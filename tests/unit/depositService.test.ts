import test from "node:test";
import assert from "node:assert/strict";
import {
  createLiqPayCheckout,
  liqpayEncodeData,
  liqpaySign,
  liqpayVerifySignature,
} from "../../src/shared";
import { transitionForConfirm, buildDepositPaidEvents } from "../../src/shared";

test("liqpay sign/verify roundtrip", () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const data = liqpayEncodeData({
    public_key: "test_public",
    version: 3,
    action: "pay",
    amount: "100.00",
    currency: "UAH",
    description: "test",
    order_id: "order1",
  });
  const signature = liqpaySign(data);
  assert.equal(liqpayVerifySignature(data, signature), true);
  assert.equal(liqpayVerifySignature(data, `${signature}x`), false);
  assert.equal(liqpayVerifySignature(data, ""), false);
});

test("transitionForConfirm maps roles to next status", () => {
  assert.equal(transitionForConfirm("performer", "accepted"), "requires_confirmation");
  assert.equal(transitionForConfirm("customer", "requires_confirmation"), "confirmed");
  assert.equal(transitionForConfirm("performer", "published"), null);
  assert.equal(transitionForConfirm("customer", "accepted"), null);
  assert.equal(transitionForConfirm("customer", "confirmed"), null);
});

test("deposit checkout freezes funds (hold), not charges", () => {
  process.env.LIQPAY_PUBLIC_KEY = "test_public";
  process.env.LIQPAY_PRIVATE_KEY = "test_private";
  const checkout = createLiqPayCheckout({
    orderId: "order1:customer:123",
    amount: 1000,
    currency: "UAH",
    description: "test",
  });
  const decoded = JSON.parse(Buffer.from(checkout.data, "base64").toString("utf8")) as { action?: string };
  assert.equal(decoded.action, "hold");
  assert.equal(liqpayVerifySignature(checkout.data, checkout.signature), true);
});

test("buildDepositPaidEvents performer branch notifies both + customer next step", () => {
  const events = buildDepositPaidEvents({
    orderId: "o1",
    toStatus: "requires_confirmation",
    role: "performer",
    customerUserId: "c1",
    performerUserId: "p1",
    providerStatus: "hold_wait",
  });
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "deposit.performer_paid",
    "escrow.changed",
    "order.status_changed",
    "deposit.customer_required",
    "payment:required",
  ]);
  for (const e of events.slice(0, 3)) {
    assert.deepEqual(e.targets, { userIds: ["c1", "p1"] });
  }
  assert.deepEqual(events[3].targets, { userIds: ["c1"] });
});

test("buildDepositPaidEvents customer branch confirms to both", () => {
  const events = buildDepositPaidEvents({
    orderId: "o1",
    toStatus: "confirmed",
    role: "customer",
    customerUserId: "c1",
    performerUserId: "p1",
    providerStatus: "success",
  });
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "deposit.customer_paid",
    "escrow.changed",
    "order.status_changed",
    "order.confirmed",
    "order:confirmed",
  ]);
});

test("buildDepositPaidEvents tolerates missing performer", () => {
  const events = buildDepositPaidEvents({
    orderId: "o1",
    toStatus: "confirmed",
    role: "customer",
    customerUserId: "c1",
    performerUserId: null,
    providerStatus: null,
  });
  for (const e of events.slice(0, 3)) {
    assert.deepEqual(e.targets, { userIds: ["c1"] });
  }
});
