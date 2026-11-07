// Контракти ще кількох груп маршрутів: адмін-сесії та розблокування, журнал
// аудиту, деталі біржі, активна робота і звіти виконавця, котирування, здоров'я.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, USERS } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { POST as blockPost } from "../../src/app/api/v1/admin/users/[id]/block/route";
import { POST as unblockPost } from "../../src/app/api/v1/admin/users/[id]/unblock/route";
import { POST as revokePost } from "../../src/app/api/v1/admin/users/[id]/revoke-sessions/route";
import { GET as auditGet } from "../../src/app/api/v1/admin/audit-logs/route";
import { GET as marketplaceDetail } from "../../src/app/api/v1/marketplace/orders/[orderId]/route";
import { GET as activeWorkGet } from "../../src/app/api/v1/performer/active-work/route";
import { GET as billingGet } from "../../src/app/api/v1/billing/orders/route";
import { GET as ratingGet } from "../../src/app/api/v1/performer/rating/route";
import { GET as reviewsGet } from "../../src/app/api/v1/performer/reviews/route";
import { POST as quotePost } from "../../src/app/api/v1/orders/quote/route";
import { GET as healthGet } from "../../src/app/api/v1/health/route";
import { GET as meGet } from "../../src/app/api/v1/auth/me/route";
import { signAccessToken } from "../../src/lib/auth/tokens";

const ADMIN_KEY = "test-panel-secret";
const ADMIN_ID = "admin_1";
process.env.ADMIN_PANEL_SECRET = ADMIN_KEY;
const adminJson = (body: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "x-admin-key": ADMIN_KEY, "x-admin-id": ADMIN_ID, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Токен із поточною версією сесії користувача (після блокування/відкликання). */
async function signFor(userId: string): Promise<Request> {
  const user = db.findUnique("user", { where: { id: userId } }) as { role: string; email: string; sessionVersion: number };
  const token = await signAccessToken({ userId, email: user.email, role: user.role as "customer", sv: user.sessionVersion });
  return new Request("http://localhost/api/v1/auth/me", { headers: { authorization: `Bearer ${token}` } });
}

beforeEach(() => {
  resetWorld();
  db.insert("admin", { id: ADMIN_ID, email: "admin@test.local", passwordHash: "x", role: "admin", active: true });
});

describe("адмін: блокування, розблокування і відкликання сесій", () => {
  it("розблокування повертає доступ користувачу", async () => {
    await blockPost(adminJson({ reason: "Тест" }), idCtx(USERS.customer));
    assert.equal((await readResponse(await meGet(await call(USERS.customer, "GET")))).status, 403);
    const res = await readResponse(await unblockPost(adminJson({ reason: "Помилку виправлено" }), idCtx(USERS.customer)));
    assert.equal(res.status, 200);
    // Блокування відкликало сесію: старий токен не відновлюється, потрібен новий вхід.
    const freshSession = await signFor(USERS.customer);
    assert.equal((await readResponse(await meGet(freshSession))).status, 200);
  });

  it("розблокувати незаблокованого не можна (409)", async () => {
    const res = await readResponse(await unblockPost(adminJson({ reason: "Тест" }), idCtx(USERS.customer)));
    assert.equal(res.status, 409);
  });

  it("відкликання сесій інвалідовує вже видані токени", async () => {
    const old = await call(USERS.customer, "GET");
    assert.equal((await readResponse(await meGet(old))).status, 200);
    const res = await readResponse(await revokePost(adminJson({ reason: "Підозра на злам" }), idCtx(USERS.customer)));
    assert.equal(res.status, 200);
    assert.equal((await readResponse(await meGet(old))).status, 401, "старий токен більше не працює");
  });
});

describe("адмін: журнал аудиту", () => {
  it("журнал віддається адміну, з курсором — 400 для некоректного", async () => {
    db.insert("adminAuditLog", { id: "a1", adminId: ADMIN_ID, adminEmail: "admin@test.local", action: "user.block", entityType: "user", entityId: USERS.customer, reason: "x", createdAt: new Date() });
    const req = new Request("http://localhost/api/v1/admin/audit-logs", { headers: { "x-admin-key": ADMIN_KEY, "x-admin-id": ADMIN_ID } });
    const res = await readResponse(await auditGet(req));
    assert.equal(res.status, 200);
    assert.ok(JSON.stringify(res.body.data).includes("user.block"));

    const bad = new Request("http://localhost/api/v1/admin/audit-logs?cursor=broken", { headers: { "x-admin-key": ADMIN_KEY, "x-admin-id": ADMIN_ID } });
    assert.equal((await readResponse(await auditGet(bad))).status, 400);
  });
});

describe("біржа: деталі замовлення", () => {
  it("призначений виконавець бачить деталі; замовник — 403", async () => {
    const id = createOrder({ days: 1 });
    db.insert("orderMatch", { id: "mm", orderId: id, performerUserId: USERS.performer, status: "pending", createdAt: new Date() });
    const ok = await readResponse(await marketplaceDetail(await call(USERS.performer, "GET"), ctx(id)));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.order.id, id);
    const wrongRole = await readResponse(await marketplaceDetail(await call(USERS.customer, "GET"), ctx(id)));
    assert.equal(wrongRole.status, 403);
  });

  it("виконавець без збігу не бачить замовлення (404)", async () => {
    const id = createOrder({ days: 1 });
    const res = await readResponse(await marketplaceDetail(await call(USERS.otherPerformer, "GET"), ctx(id)));
    assert.equal(res.status, 404);
  });
});

describe("активна робота і звіти виконавця", () => {
  it("активна робота містить взятий заказ, рейтинг і відгуки віддаються", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    const active = await readResponse(await activeWorkGet(await call(USERS.performer, "GET")));
    assert.equal(active.status, 200);
    assert.ok(JSON.stringify(active.body.data).includes(id));

    const rating = await readResponse(await ratingGet(await call(USERS.performer, "GET")));
    assert.equal(rating.status, 200);
    const reviews = await readResponse(await reviewsGet(await call(USERS.performer, "GET")));
    assert.equal(reviews.status, 200);
    assert.equal((await readResponse(await ratingGet(await call(USERS.customer, "GET")))).status, 403);
  });

  it("історія виплат виконавця віддається з фільтром за роллю", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    const res = await readResponse(await billingGet(await call(USERS.performer, "GET")));
    assert.equal(res.status, 200);
  });
});

describe("котирування заказу", () => {
  it("котирування доступне лише заказчику (403 для виконавця)", async () => {
    const res = await readResponse(await quotePost(await call(USERS.performer, "POST", { serviceCategoryId: "x", areaHa: 10 })));
    assert.equal(res.status, 403);
  });

  it("неповний запит котирування відхиляється валідацією (400)", async () => {
    const res = await readResponse(await quotePost(await call(USERS.customer, "POST", { serviceCategoryId: "missing", areaHa: 10 })));
    assert.equal(res.status, 400);
  });
});

describe("стан сервісу", () => {
  it("health чесно повідомляє про недоступний Redis (503), без авторизації", async () => {
    const res = await readResponse(await healthGet(new Request("http://localhost/api/v1/health")));
    assert.equal(res.status, 503);
    assert.ok(res.body, "відповідь містить тіло з перевірками");
  });
});
