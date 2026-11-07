// Контракти API для основних екранів застосунку: заказ, біржа, сповіщення,
// пристрої, юридичний профіль, прогрес, відгуки та адмін-блокування.
// Усі роути викликаються напряму з тим самим in-memory сховищем, що й у
// сценаріях, тому перевіряється саме те, що отримає мобільний клієнт.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, customerPays, USERS, order } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { PATCH as cancelPatch } from "../../src/app/api/v1/orders/[orderId]/cancel/route";
import { GET as ordersGet } from "../../src/app/api/v1/orders/route";
import { GET as orderGet } from "../../src/app/api/v1/orders/[orderId]/route";
import { GET as marketplaceGet } from "../../src/app/api/v1/marketplace/orders/route";
import { POST as hidePost } from "../../src/app/api/v1/marketplace/orders/[orderId]/hide/route";
import { GET as notificationsGet, PATCH as notificationsPatch } from "../../src/app/api/v1/notifications/route";
import { PATCH as notificationRead } from "../../src/app/api/v1/notifications/[notificationId]/read/route";
import { GET as tokensGet, POST as tokensPost } from "../../src/app/api/v1/devices/push-tokens/route";
import { GET as legalGet, PATCH as legalPatch } from "../../src/app/api/v1/users/me/legal-profile/route";
import { GET as progressGet, POST as progressPost } from "../../src/app/api/v1/orders/[orderId]/progress/route";
import { POST as reviewPost } from "../../src/app/api/v1/orders/[orderId]/reviews/route";
import { POST as blockPost } from "../../src/app/api/v1/admin/users/[id]/block/route";
import { POST as verifyPost } from "../../src/app/api/v1/admin/legal-profiles/[userId]/verify/route";
import { PATCH as statusPatch } from "../../src/app/api/v1/orders/[orderId]/status/route";

const ADMIN_KEY = "test-panel-secret";
const ADMIN_ID = "admin_1";
process.env.ADMIN_PANEL_SECRET = ADMIN_KEY;

const adminHeaders = { "x-admin-key": ADMIN_KEY, "x-admin-id": ADMIN_ID };

function seedAdmin() {
  db.insert("admin", { id: ADMIN_ID, email: "admin@test.local", passwordHash: "x", role: "admin", active: true });
}

const VALID_IBAN = "UA213223130000026007233566001";

async function get(handler: (req: Request, c: any) => Promise<Response>, userId: string, orderId?: string) {
  const req = await call(userId, "GET");
  return readResponse(await handler(req, orderId ? ctx(orderId) : undefined));
}

beforeEach(() => {
  resetWorld();
  seedAdmin();
});

describe("заказ: список, деталі, скасування", () => {
  it("заказчик бачить лише свої закази у списку", async () => {
    const mine = createOrder({ days: 1 });
    createOrder({ days: 1, status: "published" });
    db.updateMany("order", { where: { id: mine }, data: { status: "published" } });
    db.insert("order", { ...order(mine), id: "foreign", customerUserId: USERS.otherCustomer, orderNumber: "DF-X" });

    const res = await get(ordersGet, USERS.customer);
    assert.equal(res.status, 200);
    const ids = res.body.data.items.map((o: any) => o.id);
    assert.ok(ids.includes(mine));
    assert.ok(!ids.includes("foreign"), "чужий заказ не віддається");
  });

  it("заказчик отримує деталі свого заказу, сторонній — 404", async () => {
    const id = createOrder({ days: 1 });
    assert.equal((await get(orderGet, USERS.customer, id)).status, 200);
    assert.equal((await get(orderGet, USERS.otherCustomer, id)).status, 404);
  });

  it("скасувати можна опубліковане замовлення; після призначення виконавця — ні", async () => {
    const id = createOrder({ days: 1 });
    const ok = await readResponse(await cancelPatch(await call(USERS.customer, "PATCH", { reason: "Передумав" }), ctx(id)));
    assert.equal(ok.status, 200);
    assert.equal(order(id).status, "cancelled");

    const taken = createOrder({ days: 1 });
    await performerClaimsAndPays(taken);
    const res = await readResponse(await cancelPatch(await call(USERS.customer, "PATCH", {}), ctx(taken)));
    assert.notEqual(res.status, 200, "після оплати заказ не скасовується напряму");
    assert.equal(order(taken).status, "requires_confirmation");
  });

  it("виконавець не може скасувати заказ замовника (404)", async () => {
    const id = createOrder({ days: 1 });
    const res = await readResponse(await cancelPatch(await call(USERS.performer, "PATCH", {}), ctx(id)));
    assert.equal(res.status, 404);
    assert.equal(order(id).status, "published");
  });
});

describe("біржа: видача виконавцю і приховування", () => {
  it("виконавець бачить замовлення, на яке його запросили", async () => {
    const id = createOrder({ days: 1 });
    db.insert("orderMatch", { id: "m1", orderId: id, performerUserId: USERS.performer, status: "pending", createdAt: new Date() });
    const res = await get(marketplaceGet, USERS.performer);
    assert.equal(res.status, 200);
    assert.ok(res.body.data.items.some((o: any) => o.id === id));
  });

  it("замовник не може відкрити біржу (403)", async () => {
    assert.equal((await get(marketplaceGet, USERS.customer)).status, 403);
  });

  it("приховане замовлення зникає з біржі виконавця", async () => {
    const id = createOrder({ days: 1 });
    db.insert("orderMatch", { id: "m2", orderId: id, performerUserId: USERS.performer, status: "pending", createdAt: new Date() });
    const hide = await readResponse(await hidePost(await call(USERS.performer, "POST"), ctx(id)));
    assert.equal(hide.status, 200);
    const res = await get(marketplaceGet, USERS.performer);
    assert.ok(!res.body.data.items.some((o: any) => o.id === id));
  });
});

describe("сповіщення", () => {
  beforeEach(() => {
    db.insert("notification", { id: "n1", userId: USERS.performer, type: "order", title: "A", message: "a", data: {}, readAt: null, createdAt: new Date("2026-11-01") });
    db.insert("notification", { id: "n2", userId: USERS.performer, type: "order", title: "B", message: "b", data: {}, readAt: new Date(), createdAt: new Date("2026-11-02") });
    db.insert("notification", { id: "n3", userId: USERS.customer, type: "order", title: "C", message: "c", data: {}, readAt: null, createdAt: new Date() });
  });

  it("список містить лише сповіщення користувача", async () => {
    const res = await get(notificationsGet, USERS.performer);
    assert.equal(res.status, 200);
    const titles = res.body.data.items.map((n: any) => n.title).sort();
    assert.deepEqual(titles, ["A", "B"]);
  });

  it("позначення однієї прочитаним змінює readAt", async () => {
    const res = await readResponse(await notificationRead(await call(USERS.performer, "PATCH"), { params: Promise.resolve({ notificationId: "n1" }) }));
    assert.equal(res.status, 200);
    assert.ok((db.findUnique("notification", { where: { id: "n1" } }) as any).readAt);
  });

  it("чуже сповіщення прочитати не можна (404)", async () => {
    const res = await readResponse(await notificationRead(await call(USERS.performer, "PATCH"), { params: Promise.resolve({ notificationId: "n3" }) }));
    assert.equal(res.status, 404);
    assert.equal((db.findUnique("notification", { where: { id: "n3" } }) as any).readAt, null);
  });

  it("масове позначення прочитаними стосується лише свого користувача", async () => {
    const res = await readResponse(await notificationsPatch(await call(USERS.performer, "PATCH", { all: true })));
    assert.equal(res.status, 200);
    assert.equal((db.findUnique("notification", { where: { id: "n3" } }) as any).readAt, null);
  });
});

describe("пристрої для push", () => {
  it("реєстрація токена зберігається і видна у списку", async () => {
    const token = "ExponentPushToken[abcdefghijklmnop]";
    const res = await readResponse(await tokensPost(await call(USERS.performer, "POST", { expoPushToken: token, platform: "ios" })));
    assert.equal(res.status, 201);
    const list = await get(tokensGet, USERS.performer);
    assert.equal(list.status, 200);
    assert.equal(list.body.data.devices.length, 1);
  });

  it("некоректний токен відхиляється (400)", async () => {
    const res = await readResponse(await tokensPost(await call(USERS.performer, "POST", { expoPushToken: "x", platform: "ios" })));
    assert.equal(res.status, 400);
  });
});

describe("юридичний профіль", () => {
  it("виконавець зберігає IBAN та ЄДРПОУ, які видно у профілі", async () => {
    const res = await readResponse(await legalPatch(await call(USERS.performer, "PATCH", {
      companyName: "ФОП Тест",
      edrpou: "12345678",
      iban: VALID_IBAN,
      legalAddress: "м. Полтава, вул. Тестова, 1",
    })));
    assert.equal(res.status, 200);
    const profile = await get(legalGet, USERS.performer);
    assert.equal(profile.body.data.legalProfile?.iban ?? profile.body.data.iban, VALID_IBAN);
  });

  it("IBAN з помилкою контрольної суми відхиляється", async () => {
    const res = await readResponse(await legalPatch(await call(USERS.performer, "PATCH", {
      companyName: "ФОП Тест",
      edrpou: "12345678",
      iban: "UA000000000000000000000000000",
      legalAddress: "м. Полтава, вул. Тестова, 1",
    })));
    assert.equal(res.status, 400);
  });
});

describe("прогрес робіт і відгуки", () => {
  it("виконавець публікує прогрес під час робіт, сторони його бачать", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    await readResponse(await statusPatch(await call(USERS.performer, "PATCH", { status: "en_route" }), ctx(id)));
    await readResponse(await statusPatch(await call(USERS.performer, "PATCH", { status: "started" }), ctx(id)));

    const post = await readResponse(await progressPost(await call(USERS.performer, "POST", { percent: 40, note: "Половина поля" }), ctx(id)));
    assert.equal(post.status, 200);

    const forCustomer = await get(progressGet, USERS.customer, id);
    assert.equal(forCustomer.status, 200);
    assert.ok(forCustomer.body.data.progress.some((p: any) => p.percent === 40));

    const forStranger = await get(progressGet, USERS.otherPerformer, id);
    assert.equal(forStranger.status, 403);
  });

  it("відгук виконавця на замовника можна лише після завершення робіт", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    const early = await readResponse(await reviewPost(await call(USERS.performer, "POST", { rating: 5 }), ctx(id)));
    assert.equal(early.status, 409);
  });

  it("відгук після завершення зберігається, повторний — 409", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    for (const s of ["en_route", "started", "completed"]) {
      await readResponse(await statusPatch(await call(USERS.performer, "PATCH", { status: s }), ctx(id)));
    }
    const first = await readResponse(await reviewPost(await call(USERS.performer, "POST", { rating: 4, comment: "Вдячні" }), ctx(id)));
    assert.equal(first.status, 201);
    const second = await readResponse(await reviewPost(await call(USERS.performer, "POST", { rating: 4 }), ctx(id)));
    assert.equal(second.status, 409);
  });
});

describe("адмін-панель: блокування та перевірка", () => {
  it("заблокований користувач втрачає доступ одразу (403 на наступному запиті)", async () => {
    const before = await get(ordersGet, USERS.customer);
    assert.equal(before.status, 200);
    const block = await readResponse(await blockPost(new Request("http://localhost/x", {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ reason: "Порушення правил" }),
    }), { params: Promise.resolve({ id: USERS.customer }) }));
    assert.equal(block.status, 200);
    const after = await get(ordersGet, USERS.customer);
    assert.equal(after.status, 403);
  });

  it("заблокувати двічі не можна (409)", async () => {
    const make = () => new Request("http://localhost/x", {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ reason: "Порушення правил" }),
    });
    await blockPost(make(), { params: Promise.resolve({ id: USERS.customer }) });
    const again = await readResponse(await blockPost(make(), { params: Promise.resolve({ id: USERS.customer }) }));
    assert.equal(again.status, 409);
  });

  it("перевірка юридичних даних виконавця: після підтвердження повторне — 409", async () => {
    db.updateMany("legalProfile", { where: { userId: USERS.performer }, data: { iban: VALID_IBAN } });
    db.insert("legalProfile", { id: "lp_p", userId: USERS.performer, companyName: "ФОП", edrpou: "12345678", iban: VALID_IBAN, legalAddress: "м. Полтава", vatPayer: false });
    const make = () => new Request("http://localhost/x", {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ reason: "Документи перевірено" }),
    });
    const first = await readResponse(await verifyPost(make(), { params: Promise.resolve({ userId: USERS.performer }) }));
    assert.equal(first.status, 200);
    const second = await readResponse(await verifyPost(make(), { params: Promise.resolve({ userId: USERS.performer }) }));
    assert.equal(second.status, 409);
  });

  it("верифікація без адмін-ключа відхиляється (401)", async () => {
    const res = await readResponse(await verifyPost(new Request("http://localhost/x", { method: "POST", body: "{}" }), { params: Promise.resolve({ userId: USERS.performer }) }));
    assert.equal(res.status, 401);
  });
});
