// Детальна виписка по рахунку користувача: хронологія всіх грошових операцій,
// баланс виконавця після кожної операції та взаємозаліки по кожному заказу.
// Побудована поверх журналу (buildLedger), тож не може розійтися з ним.
import type { LedgerEntry, LedgerRole, LedgerSummary } from "./ledger";

export type StatementRoleData = {
  entries: LedgerEntry[];
  summary: LedgerSummary;
};

export type StatementUser = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: string;
};

export type StatementOperation = {
  id: string;
  occurredAt: string;
  role: LedgerRole;
  kind: LedgerEntry["kind"];
  title: string;
  reason: string;
  orderId: string | null;
  orderNumber: string | null;
  amount: number;
  direction: LedgerEntry["direction"];
  status: LedgerEntry["status"];
  /** Вплив на доступний баланс виконавця: + зараховано, − списано на виведення. */
  balanceEffect: number;
  /** Доступний баланс виконавця після операції (тільки для ролі виконавця). */
  balanceAfter: number | null;
};

/** Взаємозалік по заказу: скільки користувач сплатив, скільки отримав і що ще в процесі. */
export type OrderSettlement = {
  orderId: string | null;
  orderNumber: string | null;
  operations: number;
  /** Фактично сплачено з рахунку користувача і вже витрачено або повернено: оплата, комісія, штрафи. */
  paidOut: number;
  /** Фактично отримано на рахунок/картку: оплата за роботу, повернення, штрафи від іншої сторони. */
  received: number;
  /** В процесі: в ескроу або очікує переказу. Не входить у нетто. */
  inProcess: number;
  /** Нетто по заказу: отримано − сплачено (без «в процесі»). */
  net: number;
};

export type AccountTotals = {
  /** Комісія сервісу, сплачена заказчиком. */
  feesPaid: number;
  /** Штрафи, сплачені виконавцем (утримана застава). */
  penaltiesPaid: number;
  /** Повернення коштів заказчику. */
  refundsReceived: number;
  /** Штрафи, отримані заказчиком від виконавця. */
  penaltiesReceived: number;
  /** Оплата за роботу, зарахована на баланс виконавця. */
  payoutsEarned: number;
  /** Виведено на IBAN (проведені заявки). */
  withdrawn: number;
  /** Заявки на виведення в обробці (резерв на балансі). */
  pendingWithdrawal: number;
  /** Заблоковано в ескроу за заказами заказчика. */
  customerInEscrow: number;
  /** Застава виконавця, заблокована на картці. */
  performerDepositHeld: number;
};

export type AccountStatement = {
  user: StatementUser;
  availableUah: number;
  roles: { customer: StatementRoleData | null; performer: StatementRoleData | null };
  totals: AccountTotals;
  operations: StatementOperation[];
  orders: OrderSettlement[];
  /** Перевірка: баланс після останньої операції збігається з підсумком журналу. */
  balanceMatchesSummary: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const PAID_OUT_KINDS = new Set<LedgerEntry["kind"]>(["customer_deposit", "customer_balance", "service_fee"]);
const IN_PROCESS_STATUSES = new Set<LedgerEntry["status"]>(["in_escrow", "decision_pending", "unlock_pending", "settling"]);
// Кошти ще утримуються компанією-гарантом: сплачено, але не витрачено.
const HELD_STATUSES = IN_PROCESS_STATUSES;

function balanceEffect(role: LedgerRole, e: LedgerEntry): number {
  if (role !== "performer") return 0;
  if (e.kind === "order_payout" && e.status === "completed") return e.amount;
  if (e.kind === "withdrawal" && (e.status === "requested" || e.status === "paid")) return -e.amount;
  return 0;
}

type Money = Pick<LedgerEntry, "kind" | "direction" | "status" | "amount">;

function isPaidOut(role: LedgerRole, e: Money): boolean {
  if (PAID_OUT_KINDS.has(e.kind)) return e.direction === "out" && !HELD_STATUSES.has(e.status);
  // Застава виконавця — лише блокування на картці; списанням вважається тільки утримання штрафом.
  if (role === "performer" && e.kind === "performer_deposit") return e.status === "forfeited";
  return false;
}

function isReceived(e: Money): boolean {
  if (e.direction !== "in") return false;
  return e.status === "completed" || e.status === "refunded";
}

function buildTotals(entries: LedgerEntry[], summary: { withdrawnUah: number; pendingWithdrawalUah: number }): AccountTotals {
  const sum = (pred: (e: LedgerEntry) => boolean) =>
    round2(entries.filter(pred).reduce((acc, e) => acc + e.amount, 0));
  return {
    feesPaid: sum((e) => e.kind === "service_fee"),
    penaltiesPaid: sum((e) => e.kind === "performer_deposit" && e.status === "forfeited"),
    refundsReceived: sum((e) => e.kind === "customer_refund"),
    penaltiesReceived: sum((e) => e.kind === "performer_deposit_forfeit"),
    payoutsEarned: sum((e) => e.kind === "order_payout" && e.status === "completed"),
    withdrawn: round2(summary.withdrawnUah),
    pendingWithdrawal: round2(summary.pendingWithdrawalUah),
    customerInEscrow: sum(
      (e) => (e.kind === "customer_deposit" || e.kind === "customer_balance") && e.status === "in_escrow",
    ),
    performerDepositHeld: sum((e) => e.kind === "performer_deposit" && e.status === "in_escrow"),
  };
}

function buildOrderSettlements(operations: StatementOperation[]): OrderSettlement[] {
  const byOrder = new Map<string, OrderSettlement>();
  for (const op of operations) {
    const key = op.orderId ?? `none:${op.id}`;
    let row = byOrder.get(key);
    if (!row) {
      row = { orderId: op.orderId, orderNumber: op.orderNumber, operations: 0, paidOut: 0, received: 0, inProcess: 0, net: 0 };
      byOrder.set(key, row);
    }
    row.operations += 1;
    if (op.orderNumber) row.orderNumber = op.orderNumber;
    if (isPaidOut(op.role, op)) row.paidOut = round2(row.paidOut + op.amount);
    if (isReceived(op)) row.received = round2(row.received + op.amount);
    if (IN_PROCESS_STATUSES.has(op.status)) row.inProcess = round2(row.inProcess + op.amount);
  }
  for (const row of byOrder.values()) row.net = round2(row.received - row.paidOut);
  return [...byOrder.values()].sort((a, b) => (a.orderNumber ?? "").localeCompare(b.orderNumber ?? ""));
}

export function buildAccountStatement(input: {
  user: StatementUser;
  roles: { customer: StatementRoleData | null; performer: StatementRoleData | null };
}): AccountStatement {
  const { user, roles } = input;
  const flat: { role: LedgerRole; entry: LedgerEntry }[] = [];
  if (roles.customer) for (const entry of roles.customer.entries) flat.push({ role: "customer", entry });
  if (roles.performer) for (const entry of roles.performer.entries) flat.push({ role: "performer", entry });
  flat.sort((a, b) => (a.entry.occurredAt < b.entry.occurredAt ? -1 : a.entry.occurredAt > b.entry.occurredAt ? 1 : 0));

  let balance = 0;
  const operations: StatementOperation[] = flat.map(({ role, entry }) => {
    const effect = balanceEffect(role, entry);
    if (role === "performer") balance = round2(balance + effect);
    return {
      id: `${role}:${entry.id}`,
      occurredAt: entry.occurredAt,
      role,
      kind: entry.kind,
      title: entry.title,
      reason: entry.reason,
      orderId: entry.orderId,
      orderNumber: entry.orderNumber,
      amount: entry.amount,
      direction: entry.direction,
      status: entry.status,
      balanceEffect: effect,
      balanceAfter: role === "performer" ? balance : null,
    };
  });

  const availableUah = roles.performer?.summary.availableUah ?? 0;
  const lastPerformerBalance = [...operations].reverse().find((op) => op.role === "performer")?.balanceAfter ?? 0;
  const orders = buildOrderSettlements(operations);
  const totals = buildTotals(
    [...(roles.customer?.entries ?? []), ...(roles.performer?.entries ?? [])],
    {
      withdrawnUah: roles.performer?.summary.withdrawnUah ?? 0,
      pendingWithdrawalUah: roles.performer?.summary.pendingWithdrawalUah ?? 0,
    },
  );

  return {
    user,
    availableUah,
    roles,
    totals,
    operations,
    orders,
    balanceMatchesSummary: round2(lastPerformerBalance) === round2(availableUah),
  };
}
