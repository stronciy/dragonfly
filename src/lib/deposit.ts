import { Prisma } from "@prisma/client";

export const DEPOSIT_RATE = 0.1;
export const DEPOSIT_DEADLINE_HOURS = 12;

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

export function nextDepositDeadline(now: Date = new Date()): Date {
  return new Date(now.getTime() + DEPOSIT_DEADLINE_HOURS * 60 * 60 * 1000);
}

export function safeDepositAmount(budget: Prisma.Decimal.Value): Prisma.Decimal {
  try {
    return depositAmountFor(budget);
  } catch {
    return new Prisma.Decimal(0);
  }
}