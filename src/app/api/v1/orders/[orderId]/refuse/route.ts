import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, orderRef } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { notifyUser } from "@/shared";
import { releaseEscrowForOrder, settleProviderHolds, emitEscrowChanged } from "@/shared";
import { enqueueMatchNewOrder } from "@/shared";
import { publishWalletChanged } from "@/services/payoutEvents";
import { formatPerformerDeposit } from "@/services/performerDepositDecision";

const schema = z.object({
  reason: z.string().min(3).max(2000),
});

const REFUSABLE = ["accepted", "requires_confirmation", "confirmed"] as const;

/**
 * Відмова виконавця.
 * - Заказчик ще не платив: застава виконавця одразу повертається, виконавець
 *   отримує сповіщення і оновлення кошелька.
 * - Заказчик уже платив: застава переходить у decision_pending, а рішення
 *   (повернути або утримати як штраф) приймає заказчик.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.performerUserId !== user.id) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }
    if (!(REFUSABLE as readonly string[]).includes(order.status)) {
      throw new ApiError(409, "CONFLICT", "Замовлення не можна відхилити в поточному статусі");
    }

    const customerPaid = order.status === "confirmed";
    const performerLock = await prisma.escrowLock.findFirst({
      where: { orderId, role: "performer", status: "held" },
      select: { amount: true },
    });
    const depositText = formatPerformerDeposit(performerLock ? Number(performerLock.amount) : null);

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: "published",
          performerUserId: null,
          acceptedAt: null,
          depositDeadline: null,
        },
      });
      await tx.orderStatusEvent.create({
        data: { orderId, status: "published", note: `Performer refused: ${body.reason}` },
      });
      if (customerPaid) {
        await tx.escrowLock.updateMany({
          where: { orderId, role: "performer", status: "held" },
          data: { status: "decision_pending" },
        });
        await releaseEscrowForOrder(tx, { orderId, role: "customer", to: "refunded" });
      } else {
        await releaseEscrowForOrder(tx, { orderId, role: "performer", to: "released" });
      }
      await tx.orderMatch.deleteMany({ where: { orderId, performerUserId: { not: user.id } } });
      await tx.orderMatch.upsert({
        where: { uniq_performer_order_match: { performerUserId: user.id, orderId } },
        create: { performerUserId: user.id, orderId, status: "refused" },
        update: { status: "refused" },
      });
    });

    if (customerPaid) {
      await settleProviderHolds({ orderId, role: "customer", to: "refunded" }).catch(() => {});
    } else {
      await settleProviderHolds({ orderId, role: "performer", to: "released" }).catch(() => {});
    }

    await emitEscrowChanged({
      requestId,
      orderId,
      customerUserId: order.customerUserId,
      performerUserId: user.id,
      roles: customerPaid ? ["performer", "customer"] : ["performer"],
      orderStatus: "published",
    });

    const ref = await orderRef(orderId);
    if (customerPaid) {
      await notifyUser({
        userId: order.customerUserId,
        type: "order",
        title: "Виконавець відмовився: вирішіть долю застави",
        message: `Замовлення ${ref} повернуто на біржу. Причина: ${body.reason.slice(0, 120)}. Ваша оплата повернута. Застава виконавця${depositText} очікує вашого рішення: повернути її виконавцю або утримати як штраф.`,
        data: {
          orderId,
          type: "performer_deposit_decision_required",
          role: "customer",
          action: "decide_deposit",
          reason: body.reason,
          depositAmount: performerLock ? Number(performerLock.amount) : null,
        },
      });
      await notifyUser({
        userId: user.id,
        type: "wallet.deposit",
        title: "Застава на розгляді",
        message: `Ви відмовились від заказу ${ref} після оплати замовника. Застава${depositText} буде повернута або утримана за рішенням замовника.`,
        data: { orderId, type: "performer_deposit_pending_decision", role: "performer", action: "view_finance" },
      });
    } else {
      await notifyUser({
        userId: order.customerUserId,
        type: "order",
        title: "Виконавець відмовився",
        message: `Замовлення ${ref} повернуто на біржу. Причина: ${body.reason.slice(0, 120)}`,
        data: { orderId, type: "order_refused_by_performer", role: "customer", reason: body.reason, forfeited: false },
      });
      await notifyUser({
        userId: user.id,
        type: "wallet.deposit",
        title: "Заставу повернено",
        message: `Ви відмовились від заказу ${ref} до оплати замовника. Застава${depositText} повертається на вашу картку.`,
        data: { orderId, type: "performer_deposit_returned", role: "performer", action: "view_finance" },
      });
    }
    await publishWalletChanged({ userId: user.id, orderId });
    if (customerPaid) await publishWalletChanged({ userId: order.customerUserId, orderId });

    await enqueueMatchNewOrder(orderId).catch(() => {});

    await publishDomainEvent({
      type: "order.status_changed",
      requestId,
      targets: { userIds: [order.customerUserId, user.id] },
      data: { orderId, fromStatus: order.status, toStatus: "published", reason: "refused" },
    });

    return ok(req, { order: { id: orderId, status: "published" }, forfeited: false, decisionPending: customerPaid });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
