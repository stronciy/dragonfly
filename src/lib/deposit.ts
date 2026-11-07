import { Prisma } from "@prisma/client";

// Guarantee deposit = 30% of the order budget, locked per side (customer and
// performer each hold the same full per-side amount — no staging).
export const DEPOSIT_RATE = 0.3;
export const DEPOSIT_DEADLINE_HOURS = 12;

// The customer's counter-deposit of the performer's paid deposit must be paid
// in a single full payment within 24h of the performer paying
// (accepted → requires_confirmation).
export const CUSTOMER_COUNTER_DEPOSIT_DEADLINE_HOURS = 24;

/**
 * @throws {RangeError} якщо `budget` менший або дорівнює нулю.
 */
export function depositAmountFor(budget: Prisma.Decimal.Value): Prisma.Decimal {
  const amount = new Prisma.Decimal(budget);
  if (amount.lte(0)) {
    throw new RangeError(`budget must be positive, got ${amount.toString()}`);
  }
  return amount.mul(DEPOSIT_RATE).toDecimalPlaces(2);
}

// Performer locks the full per-side deposit at claim.
export function performerDepositAmount(budget: Prisma.Decimal.Value): Prisma.Decimal {
  return depositAmountFor(budget);
}

export function nextDepositDeadline(now: Date = new Date()): Date {
  return new Date(now.getTime() + DEPOSIT_DEADLINE_HOURS * 60 * 60 * 1000);
}

export function nextCustomerCounterDepositDeadline(now: Date = new Date()): Date {
  return new Date(now.getTime() + CUSTOMER_COUNTER_DEPOSIT_DEADLINE_HOURS * 60 * 60 * 1000);
}

export function safeDepositAmount(budget: Prisma.Decimal.Value): Prisma.Decimal {
  try {
    return depositAmountFor(budget);
  } catch {
    return new Prisma.Decimal(0);
  }
}

// Customer payment plan. Orders up to FULL_PAYMENT_MAX_DAYS (inclusive) are
// paid 100% upfront. Longer orders pay DEPOSIT_RATE upfront and the remaining
// balance by the end of PART2_DEADLINE_DAY counted from the day work started.
export const FULL_PAYMENT_MAX_DAYS = 2;
export const PART2_DEADLINE_DAY = 3;

const PAYMENT_TZ = "Europe/Kyiv";

type CustomerPaymentPlan = {
  mode: "full" | "split";
  durationDays: number;
  immediateAmount: Prisma.Decimal;
  part2Amount: Prisma.Decimal;
};

function kyivDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PAYMENT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function kyivOffsetMs(epochMs: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PAYMENT_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Calendar days of the order inclusive, in Kyiv time. Missing dates count as
 * one day, which selects the full upfront payment.
 */
export function orderDurationDays(dateFrom: Date | null, dateTo: Date | null): number {
  if (!dateFrom || !dateTo) return 1;
  const from = Date.parse(`${kyivDateKey(dateFrom)}T00:00:00Z`);
  const to = Date.parse(`${kyivDateKey(dateTo)}T00:00:00Z`);
  return Math.max(1, Math.round((to - from) / (24 * 60 * 60 * 1000)) + 1);
}

export function customerPaymentPlan(
  budget: Prisma.Decimal.Value,
  dateFrom: Date | null,
  dateTo: Date | null
): CustomerPaymentPlan {
  const durationDays = orderDurationDays(dateFrom, dateTo);
  const total = new Prisma.Decimal(budget);
  if (durationDays <= FULL_PAYMENT_MAX_DAYS) {
    return { mode: "full", durationDays, immediateAmount: total, part2Amount: new Prisma.Decimal(0) };
  }
  const immediateAmount = depositAmountFor(total);
  return {
    mode: "split",
    durationDays,
    immediateAmount,
    part2Amount: total.sub(immediateAmount),
  };
}

/** End of the PART2_DEADLINE_DAY-th Kyiv calendar day, counting the start day as day 1. */
export function part2DeadlineFor(workStartedAt: Date): Date {
  const [y, m, d] = kyivDateKey(workStartedAt).split("-").map(Number);
  const lastDayUtc = Date.UTC(y, m - 1, d + PART2_DEADLINE_DAY - 1);
  const guess = lastDayUtc + (23 * 3600 + 59 * 60 + 59) * 1000;
  return new Date(guess - kyivOffsetMs(guess));
}
