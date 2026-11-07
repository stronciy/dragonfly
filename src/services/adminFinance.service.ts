import { prisma } from "../lib/prisma";
import { LIQPAY_FEE_RATE, SERVICE_FEE_RATE, liqpayFeeAmount } from "../lib/fees";
import { getFinanceSnapshot } from "./finance.service";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Заробіток компанії: 8.5% комісії сервісу мінус комісія LiqPay (2%) з усіх
 * оплат через LiqPay. Комісія сервісу не повертається, тож рахуємо всі оплачені платежі.
 */
export async function getCompanyEarnings() {
  const intents = await prisma.paymentIntent.findMany({
    where: { status: "paid" },
    select: { amount: true, feeAmount: true },
  });
  const paymentsTotalUah = round2(intents.reduce((acc, i) => acc + Number(i.amount), 0));
  const serviceFeeUah = round2(intents.reduce((acc, i) => acc + Number(i.feeAmount), 0));
  const liqpayFeeUah = liqpayFeeAmount(paymentsTotalUah);
  return {
    paymentsCount: intents.length,
    paymentsTotalUah,
    serviceFeeRate: SERVICE_FEE_RATE,
    serviceFeeUah,
    liqpayFeeRate: LIQPAY_FEE_RATE,
    liqpayFeeUah,
    netEarningsUah: round2(serviceFeeUah - liqpayFeeUah),
  };
}

/**
 * Виконавці, які можуть вимагати виведення: є доступний баланс або
 * оплата за роботу ще зараховується (переказ компанією-гарантом).
 */
export async function getPerformerBalances() {
  const [orders, locks, payouts] = await Promise.all([
    prisma.order.findMany({
      where: { performerUserId: { not: null } },
      select: { performerUserId: true },
      distinct: ["performerUserId"],
    }),
    prisma.escrowLock.findMany({
      where: { role: "performer" },
      select: { userId: true },
      distinct: ["userId"],
    }),
    prisma.payout.findMany({ select: { userId: true }, distinct: ["userId"] }),
  ]);
  const ids = [
    ...new Set([
      ...orders.map((o) => o.performerUserId).filter((id): id is string => Boolean(id)),
      ...locks.map((l) => l.userId),
      ...payouts.map((p) => p.userId),
    ]),
  ];

  const rows: {
    userId: string;
    availableUah: number;
    settlingUah: number;
    pendingWithdrawalUah: number;
    withdrawnUah: number;
  }[] = [];
  for (const userId of ids) {
    const { entries, summary } = await getFinanceSnapshot(prisma, userId, "performer");
    const settlingUah = round2(
      entries
        .filter((e) => e.kind === "order_payout" && e.status === "settling")
        .reduce((acc, e) => acc + e.amount, 0)
    );
    if (summary.availableUah <= 0 && settlingUah <= 0) continue;
    rows.push({
      userId,
      availableUah: summary.availableUah,
      settlingUah,
      pendingWithdrawalUah: summary.pendingWithdrawalUah,
      withdrawnUah: summary.withdrawnUah,
    });
  }

  const users = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.userId) } },
    select: { id: true, name: true, email: true, phone: true },
  });
  const usersById = new Map(users.map((u) => [u.id, u]));

  return rows
    .map((r) => ({ ...r, user: usersById.get(r.userId) ?? null }))
    .sort((a, b) => b.availableUah - a.availableUah);
}
