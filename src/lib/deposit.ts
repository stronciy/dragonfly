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
