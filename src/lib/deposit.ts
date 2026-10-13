import { Prisma } from "@prisma/client";

// Guarantee deposit = 30% of the order budget, locked per side (customer and
// performer each hold the same per-side amount).
export const DEPOSIT_RATE = 0.3;
export const DEPOSIT_DEADLINE_HOURS = 12;

// The customer's per-side deposit is staged: part1 at confirmation, part2 once
// work reaches 30% progress. Rates are fractions of a side's full deposit.
export const DEPOSIT_PART1_RATE = 0.3;
export const DEPOSIT_PART2_RATE = 0.7;
export const PART2_DEADLINE_HOURS = 12;

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

// Performer locks the full per-side deposit at claim (no staging).
export function performerDepositAmount(budget: Prisma.Decimal.Value): Prisma.Decimal {
  return depositAmountFor(budget);
}

// Customer deposit split 30/70. part2 is derived as the remainder so that
// part1 + part2 === deposit exactly (no cent drift from independent rounding).
export function customerPartAmounts(budget: Prisma.Decimal.Value): {
  part1: Prisma.Decimal;
  part2: Prisma.Decimal;
} {
  const deposit = depositAmountFor(budget);
  const part1 = deposit.mul(DEPOSIT_PART1_RATE).toDecimalPlaces(2);
  const part2 = deposit.sub(part1);
  return { part1, part2 };
}

export function nextDepositDeadline(now: Date = new Date()): Date {
  return new Date(now.getTime() + DEPOSIT_DEADLINE_HOURS * 60 * 60 * 1000);
}

export function nextPart2Deadline(now: Date = new Date()): Date {
  return new Date(now.getTime() + PART2_DEADLINE_HOURS * 60 * 60 * 1000);
}

export function safeDepositAmount(budget: Prisma.Decimal.Value): Prisma.Decimal {
  try {
    return depositAmountFor(budget);
  } catch {
    return new Prisma.Decimal(0);
  }
}
