import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { publishDomainEvent } from "@/realtime/publishDomainEvent";
import { ExpoPushService } from "@/services/expoPush.service";
import type { InputJsonValue } from "@/generated/prisma/internal/prismaNamespace";

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
    
    // Дозволяємо скасування для:
    // - draft, published (завжди)
    // - requires_confirmation, accepted (якщо просрочено або ще не підтверджено)
    const now = new Date();
    const isExpired = order.depositDeadline && new Date(order.depositDeadline) < now;
    const canCancel = 
      ["draft", "published"].includes(order.status) ||
      (["requires_confirmation", "accepted"].includes(order.status) && (isExpired || !order.performerUserId));
    
    if (!canCancel) {
      throw new ApiError(
        403, 
        "FORBIDDEN", 
        `Order cannot be cancelled now. Status: ${order.status}. Expired: ${isExpired}`
      );
    }

    const expo = new ExpoPushService(prisma);

    await prisma.$transaction(async (tx) => {
      await tx.order.update({ 
        where: { id: orderId }, 
        data: { 
          status: "cancelled",
          performerUserId: order.performerUserId, // зберігаємо виконавця якщо був
        } 
      });
      await tx.orderStatusEvent.create({
        data: { orderId, fromStatus: order.status, toStatus: "cancelled", note: body.reason ?? null },
      });
      await tx.orderMatch.deleteMany({ where: { orderId } });
      await tx.escrowLock.updateMany({
        where: { orderId, status: "locked" },
        data: { status: "released", releasedAt: new Date() },
      });
    });

    // Якщо був виконавець - відправляємо йому Push
    if (order.performerUserId) {
      const performerDevices = await prisma.device.findMany({
        where: { userId: order.performerUserId, revokedAt: null },
        select: { expoPushToken: true },
      });

      for (const device of performerDevices) {
        await expo.sendPush({
          toUserId: order.performerUserId,
          toExpoToken: device.expoPushToken,
          title: "Замовлення скасовано заказчиком",
          body: `Замовлення #${orderId.slice(-6)} скасовано. ${isExpired ? "Час підтвердження минув." : ""} ${body.reason || ''}`.trim(),
          data: {
            orderId,
            type: "order_cancelled_by_customer",
            role: "performer",
            reason: body.reason,
            expired: isExpired,
          },
        });
      }

      // Створюємо notification виконавцю
      await prisma.notification.create({
        data: {
          userId: order.performerUserId,
          type: "order",
          title: "Замовлення скасовано заказчиком",
          message: `Замовлення #${orderId.slice(-6)} скасовано заказчиком. ${body.reason || ''}`.trim(),
          data: {
            orderId,
            type: "order_cancelled_by_customer",
            role: "performer",
            reason: body.reason,
            expired: isExpired,
          } as unknown as InputJsonValue,
        },
      });
    }

    await publishDomainEvent({
      type: "order.status_changed",
      requestId,
      targets: { userIds: [order.customerUserId, ...(order.performerUserId ? [order.performerUserId] : [])] },
      data: { orderId, fromStatus: order.status, toStatus: "cancelled" },
    });

    console.log(
      "\n❌ [Cancel] Заказчик скасував замовлення:",
      `\n   OrderId: ${orderId}`,
      `\n   Status: ${order.status}`,
      `\n   Expired: ${isExpired}`,
      `\n   Reason: ${body.reason ?? 'N/A'}\n`
    );

    return ok(req, { order: { id: orderId, status: "cancelled" } }, { message: "Cancelled" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
