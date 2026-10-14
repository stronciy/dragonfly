import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, prisma, publishDomainEvent, notifyUser, orderRef } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { withdrawApplication, serializeApplication } from "@/services/application.service";

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    const { orderId } = await ctx.params;

    const application = await withdrawApplication({ orderId, performerUserId: user.id });

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { customerUserId: true },
    });
    if (order) {
      await publishDomainEvent({
        type: "order.application_withdrawn",
        requestId,
        targets: { userIds: [order.customerUserId] },
        data: { orderId, applicationId: application.id, performerId: user.id },
      });
      await notifyUser({
        userId: order.customerUserId,
        type: "application",
        title: "Виконавець відкликав заявку",
        message: `Замовлення ${await orderRef(orderId)}. Виконавець відкликав свою заявку на виконання.`,
        data: {
          orderId,
          applicationId: application.id,
          type: "order_application_withdrawn",
          role: "customer",
          action: "view_applications",
        },
      });
    }

    return ok(req, { item: serializeApplication(application) });
  } catch (err) {
    return fail(req, err);
  }
}
