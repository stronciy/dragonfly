import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, prisma, publishDomainEvent, notifyUser, orderRef } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { createApplication, serializeApplication } from "@/services/application.service";

const schema = z.object({
  type: z.string().trim().min(1).max(64).optional(),
  message: z.string().trim().max(5000).optional(),
  proposedPriceUah: z.coerce.number().positive().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json().catch(() => ({})));

    const application = await prisma.$transaction((tx) =>
      createApplication(tx, {
        orderId,
        performerUserId: user.id,
        type: body.type ?? "apply",
        message: body.message ?? null,
        proposedPriceUah: body.proposedPriceUah ?? null,
      })
    );

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { customerUserId: true },
    });
    if (order) {
      await publishDomainEvent({
        type: "order.application_created",
        requestId,
        targets: { userIds: [order.customerUserId] },
        data: { orderId, applicationId: application.id, performerId: user.id },
      });
      await notifyUser({
        userId: order.customerUserId,
        type: "application",
        title: "Нова заявка на замовлення",
        message: `Замовлення ${await orderRef(orderId)}. Виконавець подав заявку на виконання.`,
        data: {
          orderId,
          applicationId: application.id,
          type: "order_application_created",
          role: "customer",
          action: "view_applications",
        },
      });
    }

    return ok(req, { item: serializeApplication(application) }, { status: 201, message: "Заявку створено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
