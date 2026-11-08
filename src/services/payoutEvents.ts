import { publishDomainEvent } from "../realtime/publishDomainEvent";

export type PayoutStatus = "requested" | "paid" | "rejected";

/**
 * Сигнал, що баланс або застава користувача змінились (повернення, штраф).
 * Клієнт перечитує журнал фінансів; сума в події не є джерелом істини.
 */
export async function publishWalletChanged(args: { userId: string; orderId: string }) {
  await publishDomainEvent({
    type: "wallet.changed",
    targets: { userIds: [args.userId] },
    data: { orderId: args.orderId },
  }).catch(() => {});
}

/**
 * Сигнал застосунку виконавця, що його заявка на виведення змінилась.
 * Дані в події лише для відображення; баланс клієнт перечитує з журналу.
 */
export async function publishPayoutUpdated(args: {
  userId: string;
  payoutId: string;
  status: PayoutStatus;
  amount: number;
}) {
  await publishDomainEvent({
    type: "wallet.payout_updated",
    targets: { userIds: [args.userId] },
    data: { payoutId: args.payoutId, status: args.status, amount: args.amount },
  }).catch(() => {});
}
