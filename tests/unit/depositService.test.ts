import test from "node:test";
import assert from "node:assert/strict";
import {
  createLiqPayCheckout,
  liqpayEncodeData,
  liqpaySign,
  liqpayVerifySignature,
} from "../../src/shared";
import { transitionForConfirm } from "../../src/shared";

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
