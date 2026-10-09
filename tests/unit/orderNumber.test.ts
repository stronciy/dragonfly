import test from "node:test";
import assert from "node:assert/strict";
import { formatOrderNumber } from "../../src/lib/orderNumber";

test("formatOrderNumber groups a 9-digit number as SS-YY-NNNNN", () => {
  assert.equal(formatOrderNumber("012600010"), "№ 01-26-00010");
});

test("formatOrderNumber rejects values that are not 9 digits", () => {
  assert.equal(formatOrderNumber("cmv1hl48f000201qxygkrwdda"), null);
  assert.equal(formatOrderNumber("12345"), null);
  assert.equal(formatOrderNumber(null), null);
});
