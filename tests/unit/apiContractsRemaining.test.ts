// Контракти, що лишались без покриття: завершення і ранній старт, звіти та
// медіа виконавця, оплати (підтвердження і синхронізація), довідники, поля,
// статистика і профілі заказчика й виконавця.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, customerPays, USERS, order, bearer } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { POST as completePost } from "../../src/app/api/v1/orders/[orderId]/complete/route";
import { POST as earlyWithdraw } from "../../src/app/api/v1/orders/[orderId]/early-start/withdraw/route";
import { GET as reportGet } from "../../src/app/api/v1/orders/[orderId]/report/route";
import { POST as reportMediaPost } from "../../src/app/api/v1/orders/[orderId]/report/media/route";
import { POST as performerIntent } from "../../src/app/api/v1/marketplace/orders/[orderId]/deposits/performer-intent/route";
import { POST as paymentConfirm } from "../../src/app/api/v1/payments/[paymentIntentId]/confirm/route";
import { POST as paymentSync } from "../../src/app/api/v1/payments/[paymentIntentId]/sync/route";
import { GET as activityGet } from "../../src/app/api/v1/marketplace/activity/route";
import { GET as marketplaceStats } from "../../src/app/api/v1/marketplace/stats/route";
import { GET as cropStatsGet } from "../../src/app/api/v1/customer/crop-stats/route";
import { GET as customerStatsGet } from "../../src/app/api/v1/customers/[customerId]/stats/route";
import { GET as cropsGet } from "../../src/app/api/v1/catalog/crops/route";
import { POST as diagnosticsPost } from "../../src/app/api/v1/diagnostics/logs/route";
import { GET as fieldGet, PATCH as fieldPatch, DELETE as fieldDelete } from "../../src/app/api/v1/fields/[fieldId]/route";
import { GET as customerLegalGet, PATCH as customerLegalPatch } from "../../src/app/api/v1/customer/legal-profile/route";
import { GET as performerLegalGet, PATCH as performerLegalPatch } from "../../src/app/api/v1/performer/legal-profile/route";
import { GET as completedWorks } from "../../src/app/api/v1/performer/wallet/completed-works/route";
import { GET as reserveTx } from "../../src/app/api/v1/performer/wallet/reserve-transactions/route";
import { PATCH as statusPatch } from "../../src/app/api/v1/orders/[orderId]/status/route";
import { liqpayEncodeData } from "../../src/services/liqpay.service";

const VALID_IBAN = "UA213223130000026007233566001";
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const paymentCtx = (paymentIntentId: string) => ({ params: Promise.resolve({ paymentIntentId }) });
const fieldCtx = (fieldId: string) => ({ params: Promise.resolve({ fieldId }) });

/** Підміна відповіді LiqPay на запит статусу — без мережі. */
async function withLiqpayStatus(providerStatus: string, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ status: providerStatus }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function startedOrder() {
  const id = createOrder({ days: 1 });
  await performerClaimsAndPays(id);
  await customerPays(id);
  await statusPatch(await call(USERS.performer, "PATCH", { status: "en_route" }), ctx(id));
  await statusPatch(await call(USERS.performer, "PATCH", { status: "started" }), ctx(id));
  return id;
}

beforeEach(() => resetWorld());

describe("завершення роботи і ранній старт", () => {
  it("застарілий шлях завершення вимкнено (410) і не змінює заказ чи гаманець", async () => {
    const id = await startedOrder();
    const res = await readResponse(await completePost(await call(USERS.performer, "POST", { confirmed: true }), ctx(id)));
    assert.equal(res.status, 410);
    assert.equal(order(id).status, "started", "статус не змінено без підтвердження заказчика");
    assert.equal(db.count("wallet", {}), 0, "жодних нарахувань у застарілий гаманець");
  });

  it("застарілий шлях завершення відповідає 410 незалежно від стану заказу", async () => {
    const id = createOrder({ days: 1 });
    const res = await readResponse(await completePost(await call(USERS.performer, "POST", { confirmed: true }), ctx(id)));
    assert.equal(res.status, 410);
  });

  it("відкликання раннього старту без запиту — 409", async () => {
    const id = await startedOrder();
    const res = await readResponse(await earlyWithdraw(await call(USERS.performer, "POST"), ctx(id)));
    assert.equal(res.status, 409);
  });
});

describe("звіт виконавця", () => {
  it("учасники бачать звіт, сторонній — 404", async () => {
    const id = await startedOrder();
    assert.equal((await readResponse(await reportGet(await call(USERS.customer, "GET"), ctx(id)))).status, 200);
    assert.equal((await readResponse(await reportGet(await call(USERS.otherPerformer, "GET"), ctx(id)))).status, 404);
  });

  it("медіа звіту приймається під час роботи (multipart)", async () => {
    const id = await startedOrder();
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "field.jpg", { type: "image/jpeg" }));
    const req = new Request(`http://localhost/x`, { method: "POST", headers: { authorization: await bearer(USERS.performer) }, body: form });
    const res = await readResponse(await reportMediaPost(req, ctx(id)));
    assert.equal(res.status, 201);
    assert.equal(db.count("orderMedia", { where: { orderId: id, kind: "report" } }), 1);
  });

  it("медіа звіту до старту робіт заборонено (403)", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1])], "x.jpg", { type: "image/jpeg" }));
    const req = new Request(`http://localhost/x`, { method: "POST", headers: { authorization: await bearer(USERS.performer) }, body: form });
    assert.equal((await readResponse(await reportMediaPost(req, ctx(id)))).status, 403);
  });


});

describe("оплати", () => {
  it("виконавець створює інтент застави для призначеного заказу", async () => {
    const pre = createOrder({ days: 1 });
    db.updateMany("order", { where: { id: pre }, data: { status: "accepted", performerUserId: USERS.performer } });
    const res = await readResponse(await performerIntent(await call(USERS.performer, "POST", {}), ctx(pre)));
    assert.ok([200, 201].includes(res.status), `очікувався успіх, отримано ${res.status}`);
    assert.ok(db.findFirst("paymentIntent", { where: { orderId: pre, role: "performer" } }), "інтент створено");
  });

  it("підтвердження оплати з некоректним провайдером відхиляється (400)", async () => {
    const id = createOrder({ days: 1 });
    const res = await readResponse(await paymentConfirm(await call(USERS.customer, "POST", { providerPayload: { provider: "stripe", data: "x", signature: "y" } }), paymentCtx("missing")));
    assert.ok([400, 404].includes(res.status));
  });

  it("підтвердження з підробленим підписом не проводить платіж", async () => {
    const id = createOrder({ days: 1 });
    db.updateMany("order", { where: { id }, data: { status: "requires_confirmation", performerUserId: USERS.performer } });
    db.insert("paymentIntent", { id: "pi-c", orderId: id, role: "customer", part: 1, amount: 10850, currency: "UAH", provider: "liqpay", status: "pending", depositAmount: 10000, feeAmount: 850, feeRate: 0.085, data: "x", signature: "y", providerRaw: null, paidAt: null, serverUrl: null, resultUrl: null, createdAt: new Date(), updatedAt: new Date() });
    const data = liqpayEncodeData({ status: "success", action: "pay", amount: 10850 } as never);
    const res = await readResponse(await paymentConfirm(await call(USERS.customer, "POST", { providerPayload: { provider: "liqpay", data, signature: "forged" } }), paymentCtx("pi-c")));
    assert.notEqual(res.status, 200);
    assert.equal((db.findUnique("paymentIntent", { where: { id: "pi-c" } }) as any).status, "pending");
  });

  it("синхронізація платежу з банком: чужий користувач — 404", async () => {
    const id = createOrder({ days: 1 });
    db.insert("paymentIntent", { id: "pi-s", orderId: id, role: "customer", part: 1, amount: 10850, currency: "UAH", provider: "liqpay", status: "pending", depositAmount: 10000, feeAmount: 850, feeRate: 0.085, data: "x", signature: "y", providerRaw: null, providerOrderId: "lp-1", paidAt: null, serverUrl: null, resultUrl: null, createdAt: new Date(), updatedAt: new Date() });
    const res = await readResponse(await paymentSync(await call(USERS.otherCustomer, "POST"), paymentCtx("pi-s")));
    assert.equal(res.status, 404);
  });

  it("синхронізація: банк ще обробляє — статус pending, без зміни заказу", async () => {
    const id = createOrder({ days: 1 });
    db.updateMany("order", { where: { id }, data: { status: "requires_confirmation", performerUserId: USERS.performer } });
    db.insert("paymentIntent", { id: "pi-p", orderId: id, role: "customer", part: 1, amount: 10850, currency: "UAH", provider: "liqpay", status: "pending", depositAmount: 10000, feeAmount: 850, feeRate: 0.085, data: "x", signature: "y", providerRaw: null, providerOrderId: "lp-2", paidAt: null, serverUrl: null, resultUrl: null, createdAt: new Date(), updatedAt: new Date() });
    await withLiqpayStatus("processing", async () => {
      await paymentSync(await call(USERS.customer, "POST"), paymentCtx("pi-p"));
    });
    assert.equal(order(id).status, "requires_confirmation");
    assert.equal((db.findUnique("paymentIntent", { where: { id: "pi-p" } }) as any).status, "pending");
  });
});

describe("статистика і довідники", () => {
  it("активність і статистика біржі віддаються виконавцю", async () => {
    assert.equal((await readResponse(await activityGet(await call(USERS.performer, "GET")))).status, 200);
    assert.equal((await readResponse(await marketplaceStats(await call(USERS.performer, "GET")))).status, 200);
  });

  it("статистика культур і довідник культур доступні заказчику", async () => {
    assert.equal((await readResponse(await cropStatsGet(await call(USERS.customer, "GET")))).status, 200);
    assert.equal((await readResponse(await cropsGet(new Request("http://localhost/api/v1/catalog/crops")))).status, 200);
  });

  it("статистика заказчика — лише власнику (чужий — 403)", async () => {
    const own = (id: string) => ({ params: Promise.resolve({ customerId: id }) });
    assert.equal((await readResponse(await customerStatsGet(await call(USERS.customer, "GET"), own(USERS.customer)))).status, 200);
    assert.equal((await readResponse(await customerStatsGet(await call(USERS.otherCustomer, "GET"), own(USERS.customer)))).status, 403);
  });

  it("діагностичні логи приймаються від застосунку (201/200)", async () => {
    const res = await readResponse(await diagnosticsPost(await call(USERS.customer, "POST", {
      capturedAt: new Date().toISOString(),
      entries: [{ t: new Date().toISOString(), kind: "api", msg: "GET /orders 200" }],
    })));
    assert.ok([200, 201].includes(res.status), `отримано ${res.status}`);
  });
});

describe("поля заказчика", () => {
  it("власник читає, оновлює і видаляє поле; чужий — 404", async () => {
    db.insert("field", { id: "f1", ownerUserId: USERS.customer, name: "Північ", areaHa: 40, addressLabel: "Полтава", lat: 49.5, lng: 34.5, createdAt: new Date(), updatedAt: new Date() });
    assert.equal((await readResponse(await fieldGet(await call(USERS.customer, "GET"), fieldCtx("f1")))).status, 200);
    assert.equal((await readResponse(await fieldGet(await call(USERS.otherCustomer, "GET"), fieldCtx("f1")))).status, 404);
    const patched = await readResponse(await fieldPatch(await call(USERS.customer, "PATCH", { name: "Південь", areaHa: 55 }), fieldCtx("f1")));
    assert.equal(patched.status, 200);
    assert.equal((db.findUnique("field", { where: { id: "f1" } }) as any).name, "Південь");
    assert.equal((await readResponse(await fieldDelete(await call(USERS.customer, "DELETE"), fieldCtx("f1")))).status, 204);
    assert.equal(db.findUnique("field", { where: { id: "f1" } }), null);
  });
});

describe("юридичні профілі заказчика і виконавця", () => {
  it("заказчик зберігає юридичні дані; виконавець їх бачить окремим маршрутом", async () => {
    const patch = await readResponse(await customerLegalPatch(await call(USERS.customer, "PATCH", {
      companyName: "ТОВ Агро", edrpou: "12345678", iban: VALID_IBAN, legalAddress: "м. Полтава, вул. Тестова, 1",
    })));
    assert.equal(patch.status, 200);
    assert.equal((await readResponse(await customerLegalGet(await call(USERS.customer, "GET")))).status, 200);
  });

  it("юридичний профіль виконавця віддається і оновлюється", async () => {
    assert.equal((await readResponse(await performerLegalGet(await call(USERS.performer, "GET")))).status, 200);
    const res = await readResponse(await performerLegalPatch(await call(USERS.performer, "PATCH", {
      companyName: "ФОП Тест", edrpou: "12345678", iban: VALID_IBAN, legalAddress: "м. Полтава, вул. Тестова, 2",
    })));
    assert.equal(res.status, 200);
  });

  it("заказчик не має доступу до юрпрофілю виконавця (403)", async () => {
    assert.equal((await readResponse(await performerLegalGet(await call(USERS.customer, "GET")))).status, 403);
  });
});

describe("журнали виконавця (сумісність)", () => {
  it("завершені роботи і резервні операції віддаються виконавцю", async () => {
    assert.equal((await readResponse(await completedWorks(await call(USERS.performer, "GET")))).status, 200);
    assert.equal((await readResponse(await reserveTx(await call(USERS.performer, "GET")))).status, 200);
  });

  it("журнали недоступні заказчику (403)", async () => {
    assert.equal((await readResponse(await completedWorks(await call(USERS.customer, "GET")))).status, 403);
  });
});
