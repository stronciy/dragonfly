// Контракти інших потоків застосунку: ранній старт, адмін-скасування,
// зміна ролі, каталог, зведення заказчика та поля.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, customerPays, USERS, order, DAY } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { GET as earlyGet, POST as earlyPost } from "../../src/app/api/v1/orders/[orderId]/early-start/route";
import { POST as earlyApprove } from "../../src/app/api/v1/orders/[orderId]/early-start/approve/route";
import { POST as earlyReject } from "../../src/app/api/v1/orders/[orderId]/early-start/reject/route";
import { PATCH as statusPatch } from "../../src/app/api/v1/orders/[orderId]/status/route";
import { POST as adminCancel } from "../../src/app/api/v1/admin/orders/[id]/cancel/route";
import { PATCH as roleChange } from "../../src/app/api/v1/users/me/role/route";
import { GET as servicesGet } from "../../src/app/api/v1/catalog/services/route";
import { GET as billingGet } from "../../src/app/api/v1/billing/summary/route";
import { GET as fieldsGet, POST as fieldsPost } from "../../src/app/api/v1/fields/route";

const ADMIN_KEY = "test-panel-secret";
const ADMIN_ID = "admin_1";
process.env.ADMIN_PANEL_SECRET = ADMIN_KEY;
const adminHeaders = { "x-admin-key": ADMIN_KEY, "x-admin-id": ADMIN_ID };

async function confirmedFutureOrder() {
  const id = createOrder({ days: 3, budget: 10000 });
  db.updateMany("order", { where: { id }, data: { dateFrom: new Date(Date.now() + 3 * DAY) } });
  await performerClaimsAndPays(id);
  await customerPays(id);
  return id;
}

beforeEach(() => {
  resetWorld();
  db.insert("admin", { id: ADMIN_ID, email: "admin@test.local", passwordHash: "x", role: "admin", active: true });
});

describe("ранній старт", () => {
  it("виконавець просить ранній старт → заказчик погоджує → старт дозволено раніше дати", async () => {
    const id = await confirmedFutureOrder();
    const req = await readResponse(await earlyPost(await call(USERS.performer, "POST", {}), ctx(id)));
    assert.equal(req.status, 201);

    const pending = await readResponse(await earlyGet(await call(USERS.customer, "GET"), ctx(id)));
    assert.equal(pending.status, 200);

    const approve = await readResponse(await earlyApprove(await call(USERS.customer, "POST", {}), ctx(id)));
    assert.equal(approve.status, 200);

    await statusPatch(await call(USERS.performer, "PATCH", { status: "en_route" }), ctx(id));
    const started = await readResponse(await statusPatch(await call(USERS.performer, "PATCH", { status: "started" }), ctx(id)));
    assert.equal(started.status, 200, "погоджений ранній старт знімає блокування дати");
    assert.equal(order(id).status, "started");
  });

  it("без погодження старт до дати відхиляється (400)", async () => {
    const id = await confirmedFutureOrder();
    await statusPatch(await call(USERS.performer, "PATCH", { status: "en_route" }), ctx(id));
    const res = await readResponse(await statusPatch(await call(USERS.performer, "PATCH", { status: "started" }), ctx(id)));
    assert.equal(res.status, 400);
    assert.equal(order(id).status, "en_route", "перехід en_route дозволено, а started — ні");
  });

  it("заказчик відхиляє ранній старт — статус не змінюється", async () => {
    const id = await confirmedFutureOrder();
    await earlyPost(await call(USERS.performer, "POST", {}), ctx(id));
    const res = await readResponse(await earlyReject(await call(USERS.customer, "POST", { reason: "Ще рано" }), ctx(id)));
    assert.equal(res.status, 200);
    await statusPatch(await call(USERS.performer, "PATCH", { status: "en_route" }), ctx(id));
    assert.equal((await readResponse(await statusPatch(await call(USERS.performer, "PATCH", { status: "started" }), ctx(id)))).status, 400);
  });

  it("неназначений виконавець не бачить заказ для раннього старту (404)", async () => {
    const id = createOrder({ days: 3 });
    const res = await readResponse(await earlyPost(await call(USERS.performer, "POST", {}), ctx(id)));
    assert.equal(res.status, 404);
  });

  it("ранній старт лише для підтверджених заказів: на етапі заставі — 409", async () => {
    const id = createOrder({ days: 3 });
    await performerClaimsAndPays(id);
    const res = await readResponse(await earlyPost(await call(USERS.performer, "POST", {}), ctx(id)));
    assert.equal(res.status, 409);
  });

  it("погоджувати може лише заказчик (403 для виконавця)", async () => {
    const id = await confirmedFutureOrder();
    await earlyPost(await call(USERS.performer, "POST", {}), ctx(id));
    const res = await readResponse(await earlyApprove(await call(USERS.performer, "POST", {}), ctx(id)));
    assert.equal(res.status, 403);
  });
});

describe("адмін: скасування заказу", () => {
  it("адмін скасовує заказ із причиною, подія і журнал записані", async () => {
    const id = createOrder({ days: 1 });
    const res = await readResponse(await adminCancel(new Request("http://localhost/x", {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({ reason: "Дублікат заказу" }),
    }), { params: Promise.resolve({ id }) }));
    assert.equal(res.status, 200);
    assert.equal(order(id).status, "cancelled");
    assert.equal(db.count("adminAuditLog", { where: { entityId: id } }), 1);
  });

  it("скасування без причини відхиляється (400)", async () => {
    const id = createOrder({ days: 1 });
    const res = await readResponse(await adminCancel(new Request("http://localhost/x", {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: JSON.stringify({}),
    }), { params: Promise.resolve({ id }) }));
    assert.equal(res.status, 400);
    assert.equal(order(id).status, "published");
  });
});

describe("зміна ролі", () => {
  it("користувач перемикає роль на виконавця, нова роль зберігається", async () => {
    const res = await readResponse(await roleChange(await call(USERS.customer, "PATCH", { role: "performer" })));
    assert.equal(res.status, 200);
    assert.equal((db.findUnique("user", { where: { id: USERS.customer } }) as any).role, "performer");
  });

  it("недопустима роль відхиляється (400)", async () => {
    const res = await readResponse(await roleChange(await call(USERS.customer, "PATCH", { role: "admin" })));
    assert.equal(res.status, 400);
  });
});

describe("каталог послуг", () => {
  it("каталог віддається без авторизації і містить категорію з підкатегорією", async () => {
    db.insert("serviceCategory", { id: "cat1", name: "Обприскування", sort: 1 });
    db.insert("serviceSubcategory", { id: "sub1", categoryId: "cat1", name: "Дрони", sort: 1 });
    db.insert("serviceType", { id: "t1", subcategoryId: "sub1", name: "Обробка гербіцидом", sort: 1 });
    const res = await readResponse(await servicesGet(new Request("http://localhost/api/v1/catalog/services")));
    assert.equal(res.status, 200);
    const body = JSON.stringify(res.body.data);
    assert.ok(body.includes("Обприскування") && body.includes("Обробка гербіцидом"), "категорія і тип у відповіді");
  });
});

describe("зведення заказчика", () => {
  it("сума бюджетів завершених заказів рахується лише для власника", async () => {
    const done = createOrder({ days: 1, budget: 7000 });
    db.updateMany("order", { where: { id: done }, data: { status: "completed" } });
    createOrder({ days: 1, budget: 999 });
    const res = await readResponse(await billingGet(await call(USERS.customer, "GET")));
    assert.equal(res.status, 200);
    assert.equal(JSON.stringify(res.body.data).includes("7000"), true);
    assert.equal(JSON.stringify(res.body.data).includes("999"), false, "незавершені не входять у суму");
  });

  it("виконавець не має доступу до зведення заказчика (403)", async () => {
    assert.equal((await readResponse(await billingGet(await call(USERS.performer, "GET")))).status, 403);
  });
});

describe("поля заказчика", () => {
  it("заказчик створює поле і бачить його у списку", async () => {
    const created = await readResponse(await fieldsPost(await call(USERS.customer, "POST", {
      name: "Північне поле", areaHa: 42, addressLabel: "Полтавська обл.", lat: 49.5, lng: 34.5,
    })));
    assert.equal(created.status, 201);
    const list = await readResponse(await fieldsGet(await call(USERS.customer, "GET")));
    assert.equal(list.status, 200);
    assert.ok(JSON.stringify(list.body.data).includes("Північне поле"));
  });

  it("виконавець не створює поля (403)", async () => {
    const res = await readResponse(await fieldsPost(await call(USERS.performer, "POST", { name: "X", areaHa: 1 })));
    assert.equal(res.status, 403);
  });
});
