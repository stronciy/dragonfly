import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import {
  DEPOSIT_RATE,
  DEPOSIT_DEADLINE_HOURS,
  depositAmountFor,
  nextDepositDeadline,
  safeDepositAmount,
} from "../../src/shared";

test("depositAmountFor should round to 2 decimal places", () => {
  assert.equal(depositAmountFor("1000").toString(), "100");
  assert.equal(depositAmountFor("1234.56").toString(), "123.46");
  assert.equal(depositAmountFor("999.99").toString(), "100");
  assert.equal(depositAmountFor("0.01").toString(), "0");
});

test("depositAmountFor should use DEPOSIT_RATE", () => {
  const result = depositAmountFor("2500");
  assert.equal(result.toString(), String(2500 * DEPOSIT_RATE));
});

test("depositAmountFor should return a Decimal instance", () => {
  const result = depositAmountFor("1000");
  assert.ok(result instanceof Prisma.Decimal);
  assert.equal(result.toFixed(2), "100.00");
});

test("depositAmountFor should accept Decimal input", () => {
  const budget = new Prisma.Decimal("777.77");
  assert.equal(depositAmountFor(budget).toString(), "77.78");
});

test("depositAmountFor should throw on zero budget", () => {
  assert.throws(() => depositAmountFor("0"), RangeError);
});

test("depositAmountFor should throw on negative budget", () => {
  assert.throws(() => depositAmountFor("-100"), RangeError);
  assert.throws(() => depositAmountFor(-50), RangeError);
});

test("safeDepositAmount should fall back to zero on invalid budget", () => {
  assert.equal(safeDepositAmount("0").toString(), "0");
  assert.equal(safeDepositAmount("-100").toString(), "0");
  assert.equal(safeDepositAmount("1000").toString(), "100");
});

test("nextDepositDeadline should add DEPOSIT_DEADLINE_HOURS to now", () => {
  const now = new Date("2026-09-28T10:00:00.000Z");
  const expected = new Date(now.getTime() + DEPOSIT_DEADLINE_HOURS * 60 * 60 * 1000);
  assert.deepEqual(nextDepositDeadline(now), expected);
});

test("nextDepositDeadline should default to current time", () => {
  const before = Date.now();
  const deadline = nextDepositDeadline();
  const after = Date.now();
  assert.ok(deadline.getTime() >= before + DEPOSIT_DEADLINE_HOURS * 60 * 60 * 1000);
  assert.ok(deadline.getTime() <= after + DEPOSIT_DEADLINE_HOURS * 60 * 60 * 1000);
});