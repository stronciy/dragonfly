import test from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  isExpirableStatus,
  isOrderStatus,
} from "../../src/shared";

test("canTransition allows the canonical deposit chain", () => {
  assert.equal(canTransition("published", "accepted"), true);
  assert.equal(canTransition("accepted", "requires_confirmation"), true);
  assert.equal(
    canTransition("requires_confirmation", "confirmed"),
    true
  );
  assert.equal(canTransition("confirmed", "started"), true);
  assert.equal(canTransition("started", "completed"), true);
});

test("canTransition rejects skips and legacy active", () => {
  assert.equal(canTransition("published", "confirmed"), false);
  assert.equal(canTransition("confirmed", "active" as never), false);
  assert.equal(canTransition("accepted", "started"), false);
  assert.equal(canTransition("confirmed", "completed"), false);
});

test("canTransition allows cancel and arbitration branches", () => {
  assert.equal(canTransition("draft", "cancelled"), true);
  assert.equal(canTransition("published", "cancelled"), true);
  assert.equal(canTransition("confirmed", "arbitration"), true);
  assert.equal(canTransition("started", "arbitration"), true);
  assert.equal(canTransition("completed", "arbitration"), true);
  assert.equal(canTransition("cancelled", "published"), false);
  assert.equal(canTransition("arbitration", "published"), false);
});

test("isExpirableStatus targets accepted and requires_confirmation only", () => {
  assert.equal(isExpirableStatus("accepted"), true);
  assert.equal(isExpirableStatus("requires_confirmation"), true);
  assert.equal(isExpirableStatus("published"), false);
  assert.equal(isExpirableStatus("confirmed"), false);
  assert.equal(isExpirableStatus("completed"), false);
});

test("isOrderStatus validates the canonical set", () => {
  assert.equal(isOrderStatus("published"), true);
  assert.equal(isOrderStatus("started"), true);
  assert.equal(isOrderStatus("active"), false);
  assert.equal(isOrderStatus("pending_deposit"), false);
  assert.equal(isOrderStatus(undefined), false);
});
