// Фінансовий журнал користувача, зібраний з реальних грошових подій:
// оплати (PaymentIntent), ескроу (EscrowLock) та заявки на виведення (Payout).
// Журнал не зберігається окремо — він завжди відповідає фактичному стану
// платежів і блокувань, тож не може розійтися з ними.
import { customerPaymentPlan } from "../deposit";

export type LedgerRole = "customer" | "performer";

export type LedgerKind =
  | "customer_deposit"
  | "customer_balance"
  | "service_fee"
  | "customer_refund"
  | "performer_deposit"
  | "performer_deposit_return"
  | "performer_deposit_forfeit"
  | "order_payout"
  | "withdrawal";

export type LedgerDirection = "out" | "in" | "none";

export type LedgerStatus =
  | "in_escrow"
  | "settling"
  | "completed"
  | "refunded"
  | "returned"
  | "forfeited"
  | "requested"
  | "paid"
  | "rejected";

export type LedgerEntry = {
  id: string;
  occurredAt: string;
  kind: LedgerKind;
  direction: LedgerDirection;
  amount: number;
  currency: string;
  status: LedgerStatus;
  orderId: string | null;
  orderNumber: string | null;
  title: string;
  reason: string;
};

export type LedgerOrder = {
  id: string;
  orderNumber: string | null;
  customerUserId: string;
  performerUserId: string | null;
  budget: number;
  dateFrom: Date | null;
  dateTo: Date | null;
};

export type LedgerIntent = {
  id: string;
  orderId: string;
  role: string;
  part: number;
  amount: number;
  depositAmount: number | null;
  feeAmount: number;
  currency: string;
  paidAt: Date | null;
};

export type LedgerLock = {
  id: string;
  orderId: string;
  role: string;
  userId: string;
  amount: number;
  status: string;
  releasedAt: Date | null;
};

export type LedgerPayout = {
  id: string;
  amount: number;
  currency: string;
  iban: string;
  status: string;
  requestedAt: Date;
  processedAt: Date | null;
  rejectReason: string | null;
};

export type LedgerInput = {
  role: LedgerRole;
  userId: string;
  orders: LedgerOrder[];
  intents: LedgerIntent[];
  locks: LedgerLock[];
  payouts: LedgerPayout[];
};

export type LedgerSummary = {
  /** Виконавець: можна вивести зараз. Заказчик: 0. */
  availableUah: number;
  /** Кошти на рахунку компанії-гаранта, заблоковані в ескроу. */
  inEscrowUah: number;
  /** Виконавець: отримано за роботи. Заказчик: сплачено за замовлення (без комісії). */
  earnedOrPaidUah: number;
  /** Сплачена комісія сервісу (тільки заказчик). */
  feesPaidUah: number;
  /** Повернено заказчику. */
  refundedUah: number;
  /** Виведено (проведені виплати). */
  withdrawnUah: number;
  /** Заявки, що чекають на обробку. */
  pendingWithdrawalUah: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function iso(d: Date | null | undefined, fallback: Date): string {
  return (d ?? fallback).toISOString();
}

function customerDepositTitle(order: LedgerOrder): { title: string; reason: string } {
  const mode = customerPaymentPlan(order.budget, order.dateFrom, order.dateTo).mode;
  if (mode === "full") {
    return {
      title: "Оплата вартості замовлення (100%)",
      reason:
        "Робота до 2 днів включно: вся вартість вноситься одразу. Кошти зберігаються на рахунку компанії-гаранта і передаються виконавцю після підтвердження роботи.",
    };
  }
  return {
    title: "Гарантійна сума (30%)",
    reason:
      "Робота понад 2 дні: перші 30% вартості вносяться одразу як гарантія. Залишок 70% — до кінця третього дня від початку робіт.",
  };
}

function customerDepositStatus(lockStatus: string | undefined): LedgerStatus {
  if (lockStatus === "refunded" || lockStatus === "refund_pending") return "refunded";
  if (lockStatus === "released" || lockStatus === "release_pending" || lockStatus === "forfeited") return "completed";
  return "in_escrow";
}

function customerDepositReason(status: LedgerStatus): string {
  if (status === "in_escrow") {
    return "Кошти заблоковані на рахунку компанії-гаранта до завершення роботи та підтвердження заказчиком.";
  }
  if (status === "refunded") {
    return "Заказ скасовано або робота не відбулась — кошти повернуто.";
  }
  return "Кошти передано виконавцю за виконану роботу.";
}

/**
 * Будує журнал для однієї ролі. Записи відсортовано від найновішого до найстарішого.
 * Для кожного платежу/блокування є рівно один запис (окрім комісії — окремий).
 */
export function buildLedger(input: LedgerInput): LedgerEntry[] {
  const now = new Date(0);
  const ordersById = new Map(input.orders.map((o) => [o.id, o]));
  const locksByKey = new Map(input.locks.map((l) => [`${l.orderId}:${l.role}`, l]));
  const entries: LedgerEntry[] = [];
  // Заказ належить виконавцю, якщо він досі призначений або його застава була
  // внесена (після відмови заказ знімається з виконавця, але гроші лишаються в журналі).
  const isMyPerformerOrder = (orderId: string) => {
    const order = ordersById.get(orderId);
    if (order?.performerUserId === input.userId) return true;
    return input.locks.some((l) => l.orderId === orderId && l.role === "performer" && l.userId === input.userId);
  };
  const isMyCustomerOrder = (orderId: string) => ordersById.get(orderId)?.customerUserId === input.userId;

  const orderMeta = (orderId: string) => {
    const o = ordersById.get(orderId);
    return { orderId, orderNumber: o?.orderNumber ?? null };
  };

  for (const intent of input.intents) {
    const order = ordersById.get(intent.orderId);
    if (!order || intent.paidAt === null) continue;
    const meta = orderMeta(intent.orderId);
    const occurredAt = iso(intent.paidAt, now);

    if (input.role === "customer" && intent.role === "customer") {
      if (intent.part === 2) {
        const status = customerDepositStatus(locksByKey.get(`${order.id}:customer`)?.status);
        entries.push({
          id: `intent:${intent.id}`,
          occurredAt,
          kind: "customer_balance",
          direction: "out",
          amount: round2(intent.amount),
          currency: intent.currency,
          status,
          ...meta,
          title: "Залишок оплати (70%)",
          reason: customerDepositReason(status),
        });
        continue;
      }
      const deposit = intent.depositAmount ?? intent.amount - intent.feeAmount;
      const status = customerDepositStatus(locksByKey.get(`${order.id}:customer`)?.status);
      const { title, reason } = customerDepositTitle(order);
      entries.push({
        id: `intent:${intent.id}`,
        occurredAt,
        kind: "customer_deposit",
        direction: "out",
        amount: round2(deposit),
        currency: intent.currency,
        status,
        ...meta,
        title,
        reason: status === "in_escrow" ? `${reason} ${customerDepositReason(status)}` : customerDepositReason(status),
      });
      if (intent.feeAmount > 0) {
        entries.push({
          id: `fee:${intent.id}`,
          occurredAt,
          kind: "service_fee",
          direction: "out",
          amount: round2(intent.feeAmount),
          currency: intent.currency,
          status: "completed",
          ...meta,
          title: "Комісія сервісу (8.5%)",
          reason: "Винагорода платформи за розміщення та гарантію виконання. Не повертається.",
        });
      }
    }

    if (input.role === "performer" && intent.role === "performer" && isMyPerformerOrder(order.id)) {
      const lock = locksByKey.get(`${order.id}:performer`);
      const lockStatus = lock?.status;
      let status: LedgerStatus = "in_escrow";
      if (lockStatus === "released" || lockStatus === "release_pending") status = "returned";
      if (lockStatus === "forfeited" || lockStatus === "forfeit_pending") status = "forfeited";
      entries.push({
        id: `intent:${intent.id}`,
        occurredAt,
        kind: "performer_deposit",
        direction: "out",
        amount: round2(intent.amount),
        currency: intent.currency,
        status,
        ...meta,
        title: "Гарантійна застава (30%)",
        reason:
          status === "in_escrow"
            ? "Застава зберігається на рахунку компанії-гаранта. Повернеться після завершення роботи або буде утримана за порушення."
            : status === "returned"
              ? "Застава розблокована на вашій картці після завершення роботи. На баланс не зараховується."
              : "Застава утримана за рішенням арбітражу або через відмову від заказу — залишається у компанії як штраф.",
      });
    }
  }

  for (const lock of input.locks) {
    const order = ordersById.get(lock.orderId);
    if (!order) continue;
    const meta = orderMeta(lock.orderId);
    const occurredAt = iso(lock.releasedAt, now);
    const amount = round2(lock.amount);

    if (input.role === "customer" && lock.role === "customer" && isMyCustomerOrder(order.id)) {
      if (lock.status === "refunded") {
        entries.push({
          id: `refund:${lock.id}`,
          occurredAt,
          kind: "customer_refund",
          direction: "in",
          amount,
          currency: "UAH",
          status: "refunded",
          ...meta,
          title: "Повернення коштів",
          reason: "Заказ скасовано або робота не відбулась — кошти повернуто.",
        });
      }
    }

    if (input.role === "performer" && lock.role === "customer" && isMyPerformerOrder(order.id)) {
      if (lock.status === "released" || lock.status === "release_pending") {
        entries.push({
          id: `payout:${lock.id}`,
          occurredAt,
          kind: "order_payout",
          direction: "in",
          amount,
          currency: "UAH",
          status: lock.status === "released" ? "completed" : "settling",
          ...meta,
          title: "Оплата за роботу",
          reason:
            lock.status === "released"
              ? "Заказчик підтвердив завершення роботи (або арбітраж визнав роботу виконаною). Кошти зараховано на баланс."
              : "Оплата передається на баланс після завершення переказу компанією-гарантом.",
        });
      }
    }

    if (input.role === "performer" && lock.role === "performer" && isMyPerformerOrder(order.id)) {
      if (lock.status === "released") {
        entries.push({
          id: `deposit-return:${lock.id}`,
          occurredAt,
          kind: "performer_deposit_return",
          direction: "none",
          amount,
          currency: "UAH",
          status: "returned",
          ...meta,
          title: "Розблокування застави",
          reason: "Заказ завершено без порушень: гарантійна сума розблокована на вашій картці. Вона не зараховується на баланс.",
        });
      }
    }
  }

  if (input.role === "performer") {
    for (const p of input.payouts) {
      entries.push({
        id: `withdrawal:${p.id}`,
        occurredAt: iso(p.processedAt ?? p.requestedAt, now),
        kind: "withdrawal",
        direction: "out",
        amount: round2(p.amount),
        currency: p.currency,
        status: p.status === "paid" ? "paid" : p.status === "rejected" ? "rejected" : "requested",
        orderId: null,
        orderNumber: null,
        title: "Виведення коштів",
        reason: withdrawalReason(p),
      });
    }
  }

  return entries.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
}

function withdrawalReason(p: LedgerPayout): string {
  if (p.status === "paid") return `Перераховано на IBAN ${maskIban(p.iban)}.`;
  if (p.status === "rejected") {
    return `Заявку відхилено${p.rejectReason ? `: ${p.rejectReason}` : ""}. Кошти повернуто на баланс.`;
  }
  return `Заявку на переказ на IBAN ${maskIban(p.iban)} прийнято — очікує обробки. Кошти зарезервовано.`;
}

export function maskIban(iban: string): string {
  const clean = iban.replace(/\s/g, "");
  return `${clean.slice(0, 4)}…${clean.slice(-4)}`;
}

/** Підсумки для шапки екрана фінансів. Суми — лише з фактичних подій. */
export function summarizeLedger(role: LedgerRole, entries: LedgerEntry[]): LedgerSummary {
  const sum = (pred: (e: LedgerEntry) => boolean) =>
    round2(entries.filter(pred).reduce((acc, e) => acc + e.amount, 0));

  const inEscrowUah =
    role === "customer"
      ? sum((e) => (e.kind === "customer_deposit" || e.kind === "customer_balance") && e.status === "in_escrow")
      : sum((e) => (e.kind === "performer_deposit" || e.kind === "order_payout") && (e.status === "in_escrow" || e.status === "settling"));

  if (role === "customer") {
    return {
      availableUah: 0,
      inEscrowUah,
      earnedOrPaidUah: sum((e) => e.kind === "customer_deposit" || e.kind === "customer_balance"),
      feesPaidUah: sum((e) => e.kind === "service_fee"),
      refundedUah: sum((e) => e.kind === "customer_refund"),
      withdrawnUah: 0,
      pendingWithdrawalUah: 0,
    };
  }

  // Застава не є грошима виконавця на балансі: вона лише блокується на картці
  // і після роботи розблоковується там, тож у доступний баланс не входить.
  const earned = sum((e) => e.kind === "order_payout" && e.status === "completed");
  const withdrawn = sum((e) => e.kind === "withdrawal" && e.status === "paid");
  const pending = sum((e) => e.kind === "withdrawal" && e.status === "requested");
  return {
    availableUah: round2(earned - withdrawn - pending),
    inEscrowUah,
    earnedOrPaidUah: earned,
    feesPaidUah: 0,
    refundedUah: 0,
    withdrawnUah: withdrawn,
    pendingWithdrawalUah: pending,
  };
}
