import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, orderRef, notifyUser } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { ExpoPushService } from "@/shared";
import { releaseEscrowForOrder, settleProviderHolds, emitEscrowChanged } from "@/shared";
import { Prisma } from "@prisma/client";

const schema = z.object({ reason: z.string().max(2000).optional() });

export async function PATCH(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json().catch(() => ({})));

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    if (user.role !== "customer" || order.customerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    
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
        `Замовлення не можна скасувати зараз. Статус: ${order.status}. Прострочено: ${isExpired}`
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
        data: { orderId, status: "cancelled", note: body.reason ?? null },
      });
      await releaseEscrowForOrder(tx, { orderId, to: "refunded" });
      await tx.orderMatch.deleteMany({ where: { orderId } });
    });

    await settleProviderHolds({ orderId, to: "refunded" }).catch(() => {});

    await emitEscrowChanged({
      requestId,
      orderId,
      customerUserId: order.customerUserId,
      performerUserId: order.performerUserId,
      roles: ["performer", "customer"],
      orderStatus: "cancelled",
    });

    // Якщо був виконавець - відправляємо йому сповіщення з дедуплікацією
    if (order.performerUserId) {
      await notifyUser({
        userId: order.performerUserId,
        type: "order",
        title: "Замовлення скасовано Замовником",
        message: `Замовлення ${await orderRef(orderId)} скасовано Замовником. ${isExpired ? "Час підтвердження минув." : ""} ${body.reason || ''}`.trim(),
        data: {
          orderId,
          type: "order_cancelled_by_customer",
          role: "performer",
          reason: body.reason,
          expired: isExpired,
        },
      });
    }

    await publishDomainEvent({
      type: "order.status_changed",
      requestId,
      targets: { userIds: [order.customerUserId, ...(order.performerUserId ? [order.performerUserId] : [])] },
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: "cancelled",
        actorId: user.id,
        customerId: order.customerUserId,
        performerId: order.performerUserId,
      },
    });

    console.log(
      "\n❌ [Cancel] Замовник скасував замовлення:",
      `\n   OrderId: ${orderId}`,
      `\n   Status: ${order.status}`,
      `\n   Expired: ${isExpired}`,
      `\n   Reason: ${body.reason ?? 'N/A'}\n`
    );

    return ok(req, { order: { id: orderId, status: "cancelled" } }, { message: "Скасовано" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
