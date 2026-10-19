import { z } from "zod";
import { fail, getRequestId, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { writeAuditLog } from "@/lib/adminAudit";
import {
  ApiError,
  canTransition,
  isOrderStatus,
  notifyUser,
  orderRef,
  prisma,
  publishDomainEvent,
} from "@/shared";

export const runtime = "nodejs";

const schema = z.object({
  to: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(500),
});

/**
 * ORD-5: зміна статусу адміністратором.
 *
 * Дозволяємо лише операційні переходи (у дорозі / розпочато / завершено /
 * арбітраж). Структурні статуси (published, accepted, requires_confirmation,
 * confirmed, cancelled) мають власні процеси з депозитами й ескроу — їх
 * адмін не повинен перемикати навмання. Сам перехід додатково звіряється з
 * `canTransition`.
 */
const OPERATIONAL_TARGETS = new Set([
  "en_route",
  "started",
  "completed",
  "arbitration",
]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requirePanelAdmin(req);
    const requestId = getRequestId(req);
    const { id } = await ctx.params;
    const { to, reason } = schema.parse(await req.json().catch(() => null));

    if (!isOrderStatus(to)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Невідомий статус замовлення");
    }
    if (!OPERATIONAL_TARGETS.has(to)) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Цей статус змінюється окремою дією (скасування, депозит, підтвердження)"
      );
    }

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
    if (!isOrderStatus(order.status) || !canTransition(order.status, to)) {
      throw new ApiError(
        409,
        "CONFLICT",
        `Перехід «${order.status} → ${to}» не дозволений`
      );
    }
    if (!order.performerUserId) {
      throw new ApiError(409, "CONFLICT", "У замовлення немає виконавця");
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.order.update({
        where: { id },
        data: {
          status: to,
          ...(to === "completed" ? { completedAt: new Date() } : {}),
        },
        select: { id: true, status: true },
      });
      await tx.orderStatusEvent.create({
        data: { orderId: id, status: to, note: `Адмін: ${reason}` },
      });
      if (to === "completed") {
        await tx.orderMatch.deleteMany({ where: { orderId: id } });
      }
      await writeAuditLog(tx, req, {
        admin,
        action: "order.status",
        entityType: "order",
        entityId: id,
        reason,
        before: { status: order.status },
        after: { status: to },
      });
      return result;
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
      data: { orderId: id, fromStatus: order.status, toStatus: to },
    });

    const number = await orderRef(id);
    const message = `Замовлення ${number}: статус змінено на «${to}». Причина: ${reason}`;
    await Promise.allSettled(
      [order.customerUserId, order.performerUserId]
        .filter((userId): userId is string => Boolean(userId))
        .map((userId) =>
          notifyUser({
            userId,
            type: "order",
            title: "Статус замовлення змінено",
            message,
            data: {
              orderId: id,
              type: "order_status_changed_by_admin",
              fromStatus: order.status,
              toStatus: to,
              reason,
            },
          })
        )
    );

    return ok(req, { order: updated }, { message: "Статус оновлено" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
