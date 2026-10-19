import { z } from "zod";
import { fail, getRequestId, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import {
  ApiError,
  emitEscrowChanged,
  notifyUser,
  orderRef,
  prisma,
  publishDomainEvent,
  releaseEscrowForOrder,
  settleProviderHolds,
} from "@/shared";

export const runtime = "nodejs";

const schema = z.object({
  reason: z.string().trim().min(1).max(500),
});

/**
 * ORD-3: скасування замовлення адміністратором.
 *
 * Повторює бізнес-ланцюжок скасування замовником (refund ескроу, зняття
 * матчів, подія статусу), але без обмежень «лише своє» і без вікна дедлайну.
 * Завершені, арбітражні та вже скасовані замовлення не чіпаємо: для них є
 * окремі процеси.
 */
const CANCELLABLE = new Set([
  "draft",
  "published",
  "accepted",
  "requires_confirmation",
  "confirmed",
]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePanelAdmin(req);
    const requestId = getRequestId(req);
    const { id } = await ctx.params;
    const { reason } = schema.parse(await req.json().catch(() => null));

    const order = await prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        customerUserId: true,
        performerUserId: true,
      },
    });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    if (!CANCELLABLE.has(order.status)) {
      throw new ApiError(
        409,
        "CONFLICT",
        `Замовлення в статусі «${order.status}» не можна скасувати`
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.order.update({
        where: { id },
        data: { status: "cancelled" },
        select: { id: true, status: true },
      });
      await tx.orderStatusEvent.create({
        data: { orderId: id, status: "cancelled", note: `Адмін: ${reason}` },
      });
      await releaseEscrowForOrder(tx, { orderId: id, to: "refunded" });
      await tx.orderMatch.deleteMany({ where: { orderId: id } });
      await writeAuditLog(tx, req, {
        admin,
        action: "order.cancel",
        entityType: "order",
        entityId: id,
        reason,
        before: { status: order.status },
        after: { status: "cancelled" },
      });
      return result;
    });

    // Провайдерні hold-и звільняємо після транзакції: зовнішній виклик не
    // повинен тримати БД-транзакцію і не повинен валити скасування.
    await settleProviderHolds({ orderId: id, to: "refunded" }).catch(() => {});
    await emitEscrowChanged({
      requestId,
      orderId: id,
      customerUserId: order.customerUserId,
      performerUserId: order.performerUserId,
      roles: ["performer", "customer"],
      orderStatus: "cancelled",
    });

    await publishDomainEvent({
      type: "order.status_changed",
      requestId,
      targets: {
        userIds: [
          order.customerUserId,
          ...(order.performerUserId ? [order.performerUserId] : []),
        ],
      },
      data: { orderId: id, fromStatus: order.status, toStatus: "cancelled" },
    });

    const number = await orderRef(id);
    const message = `Замовлення ${number} скасовано адміністратором. Причина: ${reason}`;
    const recipients = [
      order.customerUserId,
      ...(order.performerUserId ? [order.performerUserId] : []),
    ];
    await Promise.allSettled(
      recipients.map((userId) =>
        notifyUser({
          userId,
          type: "order",
          title: "Замовлення скасовано",
          message,
          data: { orderId: id, type: "order_cancelled_by_admin", reason },
        })
      )
    );

    return ok(
      req,
      { order: updated },
      { message: "Замовлення скасовано, кошти повернуто" }
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
