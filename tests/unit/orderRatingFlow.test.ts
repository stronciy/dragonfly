// Оцінка — останній крок після закриття заказу: один раз на учасника, обидві
// сторони, після підтвердження заказчиком або рішення арбітражу.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, customerPays, USERS, order, rowsWhere } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { PATCH as statusPatch } from "../../src/app/api/v1/orders/[orderId]/status/route";
import { POST as confirmRoute } from "../../src/app/api/v1/orders/[orderId]/confirm-completion/route";
import { POST as openArb } from "../../src/app/api/v1/orders/[orderId]/arbitration/route";
import { GET as ratingGet, POST as ratingPost } from "../../src/app/api/v1/orders/[orderId]/rating/route";
import { POST as reviewPost } from "../../src/app/api/v1/orders/[orderId]/reviews/route";
import { POST as adminRulingPost } from "../../src/app/api/v1/admin/arbitration/[caseId]/ruling/route";

const ADMIN_KEY = "test-panel-secret";
process.env.ADMIN_PANEL_SECRET = ADMIN_KEY;

async function completedOrder(opts: { confirm: boolean }) {
  const id = createOrder({ days: 1, budget: 10000 });
  await performerClaimsAndPays(id);
  await customerPays(id);
  for (const s of ["en_route", "started", "completed"]) {
    await statusPatch(await call(USERS.performer, "PATCH", { status: s }), ctx(id));
  }
  if (opts.confirm) {
    const res = await readResponse(await confirmRoute(await call(USERS.customer, "POST", { accepted: true }), ctx(id)));
    assert.equal(res.status, 200);
  }
  return id;
}

const rate = (userId: string, id: string, rating: number, comment?: string) =>
  call(userId, "POST", { rating, comment }).then((req) => ratingPost(req, ctx(id))).then(readResponse);

const stateOf = (userId: string, id: string) =>
  call(userId, "GET").then((req) => ratingGet(req, ctx(id))).then(readResponse);

beforeEach(() => {
  resetWorld();
  db.insert("admin", { id: "admin_1", email: "a@test.local", passwordHash: "x", role: "admin", active: true });
});

describe("оцінка після закриття заказу", () => {
  it("завершено, але заказчик ще не підтвердив — оцінювати не можна", async () => {
    const id = await completedOrder({ confirm: false });
    const st = await stateOf(USERS.customer, id);
    assert.equal(st.body.data.rating.closed, false);
    assert.equal(st.body.data.rating.canRate, false);
    assert.equal((await rate(USERS.customer, id, 5)).status, 409);
  });

  it("після підтвердження обидві сторони можуть оцінити один раз", async () => {
    const id = await completedOrder({ confirm: true });
    assert.equal((await stateOf(USERS.customer, id)).body.data.rating.canRate, true);
    assert.equal((await stateOf(USERS.performer, id)).body.data.rating.canRate, true);

    assert.equal((await rate(USERS.customer, id, 5, "Все добре")).status, 201);
    assert.equal((await rate(USERS.performer, id, 4)).status, 201);

    const again = await rate(USERS.customer, id, 3);
    assert.equal(again.status, 409, "повторна оцінка від того самого учасника відхиляється");
    assert.equal((await stateOf(USERS.customer, id)).body.data.rating.ratedByMe, true);
  });

  it("заказчик оцінює виконавця, виконавець — заказчика; напрямок збережено правильно", async () => {
    const id = await completedOrder({ confirm: true });
    await rate(USERS.customer, id, 5);
    await rate(USERS.performer, id, 4);
    const reviews = rowsWhere("review", { orderId: id });
    const byCustomer = reviews.find((r) => r.authorUserId === USERS.customer);
    const byPerformer = reviews.find((r) => r.authorUserId === USERS.performer);
    assert.equal(byCustomer?.performerUserId, USERS.performer);
    assert.equal(byPerformer?.customerUserId, USERS.customer);
  });

  it("рейтинг виконавця рахується після взаємних оцінок", async () => {
    const id = await completedOrder({ confirm: true });
    await rate(USERS.customer, id, 5);
    await rate(USERS.performer, id, 4);
    const profile = db.findUnique("performerProfile", { where: { userId: USERS.performer } }) as any;
    assert.equal(profile.reviewCount, 1);
    assert.equal(profile.avgRating, 5);
  });

  it("після арбітражу з рішенням (ничья) оцінка доступна обом", async () => {
    const id = createOrder({ days: 1, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    for (const s of ["en_route", "started", "completed"]) {
      await statusPatch(await call(USERS.performer, "PATCH", { status: s }), ctx(id));
    }
    const opened = await readResponse(await openArb(await call(USERS.customer, "POST", { reason: "Спір" }), ctx(id)));
    const caseId = opened.body.data.case.id as string;
    const ruling = await readResponse(
      await adminRulingPost(
        new Request("http://localhost/x", {
          method: "POST",
          headers: { "x-admin-key": ADMIN_KEY, "x-admin-id": "admin_1", "content-type": "application/json" },
          body: JSON.stringify({ winner: "none", penalty: false, reason: "Закрито за згодою" }),
        }),
        { params: Promise.resolve({ caseId }) }
      )
    );
    assert.equal(ruling.status, 200);
    assert.equal((await stateOf(USERS.performer, id)).body.data.rating.canRate, true);
    assert.equal((await rate(USERS.performer, id, 3)).status, 201);
  });

  it("стороння особа не отримує стан і не може оцінити (404)", async () => {
    const id = await completedOrder({ confirm: true });
    assert.equal((await stateOf(USERS.otherCustomer, id)).status, 404);
    assert.equal((await rate(USERS.otherCustomer, id, 5)).status, 404);
  });

  it("старий шлях /reviews працює за тими самими правилами для обох ролей", async () => {
    const id = await completedOrder({ confirm: true });
    const res = await readResponse(
      await call(USERS.customer, "POST", { rating: 5 }).then((req) => reviewPost(req, ctx(id)))
    );
    assert.equal(res.status, 201);
    assert.equal(rowsWhere("review", { orderId: id }).length, 1);
  });

  it("оцінка, передана разом з підтвердженням, не створює відгук", async () => {
    const id = await completedOrder({ confirm: false });
    const res = await readResponse(
      await call(USERS.customer, "POST", { accepted: true, rating: 5 }).then((req) => confirmRoute(req, ctx(id)))
    );
    assert.equal(res.status, 200);
    assert.equal(rowsWhere("review", { orderId: id }).length, 0);
    assert.equal(order(id).status, "completed");
  });
});
