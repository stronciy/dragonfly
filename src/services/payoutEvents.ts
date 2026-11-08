import { publishDomainEvent } from "../realtime/publishDomainEvent";

export type PayoutStatus = "requested" | "paid" | "rejected";

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
