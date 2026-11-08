import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/errors";
import { notifyUser } from "./notify";
import { emitEscrowChanged, settleProviderHolds } from "./deposit.service";
import { publishWalletChanged } from "./payoutEvents";

export type PerformerDepositDecision = "return" | "fine";

/** Текст суми застави для повідомлень: " 3000.00 ₴" або порожньо, якщо суми немає. */
export function formatPerformerDeposit(amount: number | null): string {
  return amount == null ? "" : ` ${amount.toFixed(2)} ₴`;
}

/**
 * Рішення заказчика щодо застави виконавця, який відмовився після оплати
 * заказчика: повернути заставу або утримати як штраф. Лише один раз.
 */
export async function decidePerformerDeposit(args: {
  orderId: string;
  customerUserId: string;
  decision: PerformerDepositDecision;
  requestId?: string;
}) {
  const order = await prisma.order.findUnique({
    where: { id: args.orderId },
    select: { id: true, customerUserId: true, performerUserId: true, status: true },
  });
  if (!order || order.customerUserId !== args.customerUserId) {
    throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
  }

  const lock = await prisma.escrowLock.findFirst({
    where: { orderId: args.orderId, role: "performer", status: "decision_pending" },
    select: { id: true, amount: true, userId: true },
  });
  if (!lock || !lock.userId) {
    throw new ApiError(409, "CONFLICT", "Рішення щодо застави вже прийнято або не потрібне");
  }

  const nextStatus = args.decision === "return" ? "release_pending" : "forfeit_pending";
  const updated = await prisma.escrowLock.updateMany({
    where: { id: lock.id, status: "decision_pending" },
    data: { status: nextStatus },
  });
  if (updated.count !== 1) {
    throw new ApiError(409, "CONFLICT", "Рішення щодо застави вже прийнято або не потрібне");
  }

  await settleProviderHolds({
    orderId: args.orderId,
    role: "performer",
    to: args.decision === "return" ? "released" : "forfeited",
  }).catch(() => {});

  const amountText = formatPerformerDeposit(Number(lock.amount));
  const message =
    args.decision === "return"
      ? `Замовник повернув заставу${amountText} за заказ. Кошти повертаються на вашу картку.`
      : `Замовник утримав заставу${amountText} як штраф за відмову від заказу.`;
  await notifyUser({
    userId: lock.userId,
    type: "wallet.deposit",
    title: args.decision === "return" ? "Заставу повернено" : "Заставу утримано",
    message,
    data: { orderId: args.orderId, type: "performer_deposit_decided", role: "performer", decision: args.decision, action: "view_finance" },
  });

  await emitEscrowChanged({
    requestId: args.requestId,
    orderId: args.orderId,
    customerUserId: order.customerUserId,
    performerUserId: lock.userId,
    roles: ["performer"],
    orderStatus: order.status,
  });
  await publishWalletChanged({ userId: lock.userId, orderId: args.orderId });

  return { decision: args.decision, status: nextStatus };
}
