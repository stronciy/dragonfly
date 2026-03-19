import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { publishDomainEvent } from "@/realtime/publishDomainEvent";

const schema = z.object({ reason: z.string().max(2000).optional() });

export async function PATCH(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json().catch(() => ({})));

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");

    if (user.role !== "customer" || order.customerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Order not found");
    if (["confirmed", "started", "completed"].includes(order.status)) throw new ApiError(403, "FORBIDDEN", "Order cannot be cancelled now");

    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: orderId }, data: { status: "cancelled" } });
      await tx.orderStatusEvent.create({
        data: { orderId, fromStatus: order.status, toStatus: "cancelled", note: body.reason ?? null },
      });
      await tx.orderMatch.deleteMany({ where: { orderId } });
      await tx.escrowLock.updateMany({
        where: { orderId, status: "locked" },
        data: { status: "released", releasedAt: new Date() },
      });
    });

    await publishDomainEvent({
      type: "order.status_changed",
      requestId,
      targets: { userIds: [order.customerUserId, ...(order.performerUserId ? [order.performerUserId] : [])] },
      data: { orderId, fromStatus: order.status, toStatus: "cancelled" },
    });

    return ok(req, { order: { id: orderId, status: "cancelled" } }, { message: "Cancelled" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
