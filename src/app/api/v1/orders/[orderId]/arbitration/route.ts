import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, orderRef } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { notifyUser } from "@/shared";

const schema = z.object({
  reason: z.string().min(3).max(5000),
  evidenceMediaIds: z.array(z.string().min(1)).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    const canOpen =
      order.customerUserId === user.id || order.performerUserId === user.id;
    if (!canOpen) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    if (order.status === "cancelled") throw new ApiError(403, "FORBIDDEN", "Замовлення скасовано");

    const result = await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: orderId }, data: { status: "arbitration" } });
      await tx.orderMatch.deleteMany({ where: { orderId } });
      await tx.orderStatusEvent.create({
        data: { orderId, status: "arbitration", note: body.reason },
      });

      return { id: orderId, status: "arbitration", createdAt: new Date() };
    });

    const otherUserId =
      user.id === order.customerUserId ? order.performerUserId : order.customerUserId;
    const initiatorLabel = user.id === order.customerUserId ? "Замовник" : "Виконавець";
    if (otherUserId) {
      await notifyUser({
        userId: otherUserId,
        type: "arbitration",
        title: "Відкрито арбітраж",
        message: `Замовлення ${await orderRef(orderId)}. ${initiatorLabel} передав спір на арбітраж: ${body.reason.slice(0, 120)}`,
        data: { orderId, type: "arbitration_opened", role: otherUserId === order.customerUserId ? "customer" : "performer" },
      });
    }
    await publishDomainEvent({
      type: "order.status_changed",
      requestId,
      targets: { userIds: [order.customerUserId, ...(order.performerUserId ? [order.performerUserId] : [])] },
      data: { orderId, fromStatus: order.status, toStatus: "arbitration" },
    });

    return ok(req, { order: { id: orderId, status: "arbitration" }, case: result });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
