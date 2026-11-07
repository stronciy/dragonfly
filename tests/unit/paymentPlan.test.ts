import { test } from "node:test";
import assert from "node:assert/strict";
import {
  customerPaymentPlan,
  orderDurationDays,
  part2DeadlineFor,
} from "../../src/lib/deposit";

const d = (iso: string) => new Date(iso);

test("orderDurationDays counts Kyiv calendar days inclusive", () => {
  assert.equal(orderDurationDays(d("2026-11-09T10:00:00+02:00"), d("2026-11-09T18:00:00+02:00")), 1);
  assert.equal(orderDurationDays(d("2026-11-09T10:00:00+02:00"), d("2026-11-10T10:00:00+02:00")), 2);
  assert.equal(orderDurationDays(d("2026-11-09T10:00:00+02:00"), d("2026-11-11T10:00:00+02:00")), 3);
  assert.equal(orderDurationDays(d("2026-11-09T23:30:00+02:00"), d("2026-11-10T00:30:00+02:00")), 2);
  assert.equal(orderDurationDays(null, null), 1);
});

test("orders up to 2 days are paid 100% upfront", () => {
  const plan = customerPaymentPlan("10000", d("2026-11-09T10:00:00+02:00"), d("2026-11-10T10:00:00+02:00"));
  assert.equal(plan.mode, "full");
  assert.equal(plan.immediateAmount.toString(), "10000");
  assert.equal(plan.part2Amount.toString(), "0");
});

test("orders longer than 2 days pay 30% upfront and 70% later", () => {
  const plan = customerPaymentPlan("10000", d("2026-11-09T10:00:00+02:00"), d("2026-11-11T10:00:00+02:00"));
  assert.equal(plan.mode, "split");
  assert.equal(plan.immediateAmount.toString(), "3000");
  assert.equal(plan.part2Amount.toString(), "7000");
});

test("part 2 deadline is the end of the third Kyiv day counting the start day", () => {
  const deadline = part2DeadlineFor(d("2026-11-09T10:00:00+02:00"));
  assert.equal(deadline.toISOString(), d("2026-11-11T23:59:59+02:00").toISOString());
});

test("part 2 deadline respects the DST switch in Kyiv", () => {
  const deadline = part2DeadlineFor(d("2026-10-24T10:00:00+03:00"));
  assert.equal(deadline.toISOString(), d("2026-10-26T23:59:59+02:00").toISOString());
});
