// Контракти платежів і профілю виконавця: колбек LiqPay (підпис обов'язковий),
// скасування платежу, налаштування зони роботи і видалення пристрою.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, USERS, order } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { POST as callbackPost } from "../../src/app/api/v1/payments/[paymentIntentId]/liqpay/callback/route";
import { POST as cancelPost } from "../../src/app/api/v1/payments/[paymentIntentId]/cancel/route";
import { GET as settingsGet, PUT as settingsPut } from "../../src/app/api/v1/performer/settings/route";
import { DELETE as deviceDelete } from "../../src/app/api/v1/devices/push-tokens/[deviceId]/route";
import { liqpayEncodeData, liqpaySign } from "../../src/services/liqpay.service";

beforeEach(() => resetWorld());

/** Підміняє відповідь LiqPay на запит статусу; не виходимо в мережу. */
async function withLiqpayStatus(providerStatus: string, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: providerStatus, order_id: "x" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function intentCtx(paymentIntentId: string) {
  return { params: Promise.resolve({ paymentIntentId }) };
}

function pendingIntent(orderId: string, id = "pi_pending") {
  db.insert("paymentIntent", {
    id, orderId, role: "customer", part: 1, amount: 10850, currency: "UAH", provider: "liqpay",
    status: "pending", depositAmount: 10000, feeAmount: 850, feeRate: 0.085,
    data: "x", signature: "y", serverUrl: null, resultUrl: null, paidAt: null, providerRaw: null,
    createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
}

describe("колбек LiqPay", () => {
  it("колбек без підпису відхиляється (400) і нічого не змінює", async () => {
    const id = createOrder({ days: 1 });
    const intent = pendingIntent(id);
    const form = new FormData();
    form.append("data", "abc");
    const res = await readResponse(await callbackPost(new Request("http://localhost/x", { method: "POST", body: form }), intentCtx(intent)));
    assert.equal(res.status, 400);
    assert.equal((db.findUnique("paymentIntent", { where: { id: intent } }) as any).status, "pending");
  });

  it("колбек з підробленим підписом не підтверджує платіж", async () => {
    const id = createOrder({ days: 1 });
    const intent = pendingIntent(id);
    const data = liqpayEncodeData({ status: "success", action: "pay", amount: 10850 } as any);
    const form = new FormData();
    form.append("data", data);
    form.append("signature", "forged-signature");
    const res = await readResponse(await callbackPost(new Request("http://localhost/x", { method: "POST", body: form }), intentCtx(intent)));
    assert.notEqual(res.status, 200);
    assert.equal((db.findUnique("paymentIntent", { where: { id: intent } }) as any).status, "pending");
    assert.equal(order(id).status, "published");
  });

  it("колбек з валідним підписом і success підтверджує платіж", async () => {
    const id = createOrder({ days: 1 });
    db.updateMany("order", { where: { id }, data: { status: "requires_confirmation", performerUserId: USERS.performer } });
    const intent = pendingIntent(id);
    const data = liqpayEncodeData({ status: "success", action: "pay", amount: 10850 } as any);
    const signature = liqpaySign(data);
    const form = new FormData();
    form.append("data", data);
    form.append("signature", signature);
    const res = await readResponse(await callbackPost(new Request("http://localhost/x", { method: "POST", body: form }), intentCtx(intent)));
    assert.equal(res.status, 200);
    assert.equal((db.findUnique("paymentIntent", { where: { id: intent } }) as any).status, "paid");
    assert.equal(order(id).status, "confirmed");
  });
});

describe("скасування платежу", () => {
  it("учасник скасовує оплату, яку банк відхилив", async () => {
    const id = createOrder({ days: 1 });
    const intent = pendingIntent(id);
    db.updateMany("paymentIntent", { where: { id: intent }, data: { providerOrderId: "lp-order-1" } });
    await withLiqpayStatus("failure", async () => {
      const res = await readResponse(await cancelPost(await call(USERS.customer, "POST"), intentCtx(intent)));
      assert.equal(res.status, 200);
    });
    assert.equal((db.findUnique("paymentIntent", { where: { id: intent } }) as any).status, "cancelled");
  });

  it("поки банк обробляє платіж, скасувати не можна (409)", async () => {
    const id = createOrder({ days: 1 });
    const intent = pendingIntent(id);
    db.updateMany("paymentIntent", { where: { id: intent }, data: { providerOrderId: "lp-order-2" } });
    await withLiqpayStatus("processing", async () => {
      const res = await readResponse(await cancelPost(await call(USERS.customer, "POST"), intentCtx(intent)));
      assert.equal(res.status, 409);
    });
    assert.equal((db.findUnique("paymentIntent", { where: { id: intent } }) as any).status, "pending");
  });

  it("сторонній користувач не бачить чужий платіж (404)", async () => {
    const id = createOrder({ days: 1 });
    const intent = pendingIntent(id);
    const res = await readResponse(await cancelPost(await call(USERS.otherCustomer, "POST"), intentCtx(intent)));
    assert.equal(res.status, 404);
  });

  it("вже проведену оплату скасувати не можна (409)", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    const paid = db.findFirst("paymentIntent", { where: { orderId: id, role: "performer" } }) as { id: string };
    const res = await readResponse(await cancelPost(await call(USERS.performer, "POST"), intentCtx(paid.id)));
    assert.equal(res.status, 409);
  });
});

describe("налаштування виконавця", () => {
  it("заказчик не може задати локацію і радіус: 403, профіль виконавця не створюється", async () => {
    const res = await readResponse(await settingsPut(await call(USERS.customer, "PUT", {
      baseLocationLabel: "Полтава",
      baseCoordinate: { lat: 49.59, lng: 34.55 },
      coverage: { mode: "radius", radiusKm: 80 },
    })));
    assert.equal(res.status, 403);
    assert.equal(db.count("performerProfile", { where: { userId: USERS.customer } }), 0);
  });

  it("зона роботи радіусом зберігається і віддається", async () => {
    const put = await readResponse(await settingsPut(await call(USERS.performer, "PUT", {
      baseLocationLabel: "Полтава",
      baseCoordinate: { lat: 49.59, lng: 34.55 },
      coverage: { mode: "radius", radiusKm: 80 },
    })));
    assert.equal(put.status, 200);
    const get = await readResponse(await settingsGet(await call(USERS.performer, "GET")));
    assert.equal(get.status, 200);
    assert.equal(JSON.stringify(get.body.data).includes("80"), true);
  });

  it("радіус без значення відхиляється (400)", async () => {
    const res = await readResponse(await settingsPut(await call(USERS.performer, "PUT", {
      baseLocationLabel: "Полтава",
      coverage: { mode: "radius" },
    })));
    assert.equal(res.status, 400);
  });

  it("збереження зони роботи не падає, коли черга підбору недоступна (Redis вимкнено)", async () => {
    const res = await readResponse(await settingsPut(await call(USERS.performer, "PUT", {
      baseLocationLabel: "Полтава",
      baseCoordinate: { lat: 49.59, lng: 34.55 },
      coverage: { mode: "country" },
    })));
    assert.equal(res.status, 200, "дані збережено, помилки для користувача немає");
  });
});

describe("пристрої", () => {
  it("видалення власного пристрою; чужий — 404", async () => {
    db.insert("device", { id: "dev1", userId: USERS.performer, expoPushToken: "ExponentPushToken[aaaaaaaaaaaaa]", platform: "ios", revokedAt: null, createdAt: new Date(), updatedAt: new Date() });
    const foreign = await readResponse(await deviceDelete(await call(USERS.customer, "DELETE"), { params: Promise.resolve({ deviceId: "dev1" }) }));
    assert.equal(foreign.status, 404);
    const own = await readResponse(await deviceDelete(await call(USERS.performer, "DELETE"), { params: Promise.resolve({ deviceId: "dev1" }) }));
    assert.equal(own.status, 204);
    assert.equal((db.findUnique("device", { where: { id: "dev1" } }) as any).revokedAt !== null, true);
  });
});
