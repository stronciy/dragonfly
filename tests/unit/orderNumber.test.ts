import test from "node:test";
import assert from "node:assert/strict";
import { formatOrderNumber } from "../../src/lib/orderNumber";

test("formatOrderNumber formats DF-01042 style order numbers", () => {
  assert.equal(formatOrderNumber("DF-01042"), "DF-01042");
  assert.equal(formatOrderNumber("df-01042"), "DF-01042");
  assert.equal(formatOrderNumber("01042"), "DF-01042");
});

test("formatOrderNumber preserves legacy 9-digit numbers as SS-YY-NNNNN", () => {
  assert.equal(formatOrderNumber("012600010"), "№ 01-26-00010");
});

test("formatOrderNumber handles null or empty input", () => {
  assert.equal(formatOrderNumber(null), null);
  assert.equal(formatOrderNumber(""), null);
});
