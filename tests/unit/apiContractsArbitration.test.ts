// Потік рішення арбітражу: пропозиція заказчика, підтвердження або відхилення
// виконавцем, відкликання пропозиції та грошові наслідки кожного кроку.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, customerPays,
  USERS, order, escrowOf, notificationsFor,
} from "../helpers/world";
import { PATCH as statusPatch } from "../../src/app/api/v1/orders/[orderId]/status/route";
import { POST as openArb } from "../../src/app/api/v1/orders/[orderId]/arbitration/route";
import { GET as resolveGet, POST as resolvePropose } from "../../src/app/api/v1/orders/[orderId]/arbitration/resolve/route";
import { POST as approvePost } from "../../src/app/api/v1/orders/[orderId]/arbitration/resolve/approve/route";
import { POST as rejectPost } from "../../src/app/api/v1/orders/[orderId]/arbitration/resolve/reject/route";
import { POST as withdrawPost } from "../../src/app/api/v1/orders/[orderId]/arbitration/resolve/withdraw/route";

const act = (userId: string, body: Record<string, unknown> = {}, method: "POST" | "GET" = "POST") =>
  call(userId, method, method === "POST" ? body : undefined);

async function inArbitration(days = 1, budget = 10000) {
  const id = createOrder({ days, budget });
  await performerClaimsAndPays(id);
  await customerPays(id);
  await statusPatch(await call(USERS.performer, "PATCH", { status: "en_route" }), ctx(id));
  await statusPatch(await call(USERS.performer, "PATCH", { status: "started" }), ctx(id));
  await statusPatch(await call(USERS.performer, "PATCH", { status: "completed" }), ctx(id));
  const res = await readResponse(await openArb(await act(USERS.customer, { reason: "Не виконано" }), ctx(id)));
  assert.equal(res.status, 201);
  return id;
}

beforeEach(() => resetWorld());

describe("пропозиція рішення", () => {
  it("заказчик пропонує close_plain — пропозиція очікує виконавця", async () => {
    const id = await inArbitration();
    const res = await readResponse(await resolvePropose(await act(USERS.customer, { decision: "close_plain" }), ctx(id)));
    assert.equal(res.status, 201);
    const view = await readResponse(await resolveGet(await act(USERS.performer, {}, "GET"), ctx(id)));
    assert.equal(view.status, 200);
    assert.ok(JSON.stringify(view.body.data).includes("pending"));
    assert.ok(notificationsFor(USERS.performer).length > 0, "виконавець отримав сповіщення");
  });

  it("повторна пропозиція поки є активна — 409", async () => {
    const id = await inArbitration();
    await resolvePropose(await act(USERS.customer, { decision: "close_plain" }), ctx(id));
    const res = await readResponse(await resolvePropose(await act(USERS.customer, { decision: "close_fine" }), ctx(id)));
    assert.equal(res.status, 409);
  });

  it("виконавець не може пропонувати рішення (403)", async () => {
    const id = await inArbitration();
    const res = await readResponse(await resolvePropose(await act(USERS.performer, { decision: "close_plain" }), ctx(id)));
    assert.equal(res.status, 403);
  });

  it("пропозиція поза арбітражем відхиляється (409)", async () => {
    const id = createOrder({ days: 1 });
    const res = await readResponse(await resolvePropose(await act(USERS.customer, { decision: "close_plain" }), ctx(id)));
    assert.equal(res.status, 409);
  });
});

describe("підтвердження рішення виконавцем", () => {
  it("close_plain: заказ завершується, застава виконавця повертається, оплата йде виконавцю", async () => {
    const id = await inArbitration(1, 10000);
    await resolvePropose(await act(USERS.customer, { decision: "close_plain" }), ctx(id));
    const res = await readResponse(await approvePost(await act(USERS.performer), ctx(id)));
    assert.equal(res.status, 200);
    assert.equal(order(id).status, "completed");
    assert.deepEqual(escrowOf(id, "performer"), { status: "released", amount: 3000 });
    assert.deepEqual(escrowOf(id, "customer"), { status: "released", amount: 10000 });
  });

  it("close_fine: застава виконавця утримується, заказчика — зараховано", async () => {
    const id = await inArbitration(1, 10000);
    await resolvePropose(await act(USERS.customer, { decision: "close_fine" }), ctx(id));
    const res = await readResponse(await approvePost(await act(USERS.performer), ctx(id)));
    assert.equal(res.status, 200);
    assert.deepEqual(escrowOf(id, "performer"), { status: "forfeited", amount: 3000 });
    assert.deepEqual(escrowOf(id, "customer"), { status: "released", amount: 10000 });
  });

  it("підтвердити можна лише активну пропозицію (409 без неї)", async () => {
    const id = await inArbitration();
    const res = await readResponse(await approvePost(await act(USERS.performer), ctx(id)));
    assert.equal(res.status, 409);
    assert.equal(order(id).status, "arbitration");
  });

  it("інший виконавець не може підтвердити рішення (404)", async () => {
    const id = await inArbitration();
    await resolvePropose(await act(USERS.customer, { decision: "close_plain" }), ctx(id));
    const res = await readResponse(await approvePost(await act(USERS.otherPerformer), ctx(id)));
    assert.equal(res.status, 404);
  });

  it("для багатоденного заказу закрити без залишку 70% не можна (409)", async () => {
    const id = createOrder({ days: 3, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    await statusPatch(await call(USERS.performer, "PATCH", { status: "en_route" }), ctx(id));
    await statusPatch(await call(USERS.performer, "PATCH", { status: "started" }), ctx(id));
    await readResponse(await openArb(await act(USERS.performer, { reason: "Заказчик не платить" }), ctx(id)));
    await resolvePropose(await act(USERS.customer, { decision: "close_plain" }), ctx(id));
    const res = await readResponse(await approvePost(await act(USERS.performer), ctx(id)));
    assert.equal(res.status, 409);
    assert.equal(order(id).status, "arbitration");
  });
});

describe("відхилення та відкликання пропозиції", () => {
  it("виконавець відхиляє — заказ лишається в арбітражі, можна запропонувати знову", async () => {
    const id = await inArbitration();
    await resolvePropose(await act(USERS.customer, { decision: "close_plain" }), ctx(id));
    const rej = await readResponse(await rejectPost(await act(USERS.performer), ctx(id)));
    assert.equal(rej.status, 200);
    assert.equal(order(id).status, "arbitration");
    const again = await readResponse(await resolvePropose(await act(USERS.customer, { decision: "close_fine" }), ctx(id)));
    assert.equal(again.status, 201);
  });

  it("заказчик відкликає власну пропозицію", async () => {
    const id = await inArbitration();
    await resolvePropose(await act(USERS.customer, { decision: "close_plain" }), ctx(id));
    const res = await readResponse(await withdrawPost(await act(USERS.customer), ctx(id)));
    assert.equal(res.status, 200);
    assert.equal(order(id).status, "arbitration");
  });

  it("відкликати чужу пропозицію не можна (409)", async () => {
    const id = await inArbitration();
    await resolvePropose(await act(USERS.customer, { decision: "close_plain" }), ctx(id));
    const res = await readResponse(await withdrawPost(await act(USERS.performer), ctx(id)));
    assert.equal(res.status, 403);
  });

  it("після закриття заказу підтверджене рішення не відкликається (409)", async () => {
    const id = await inArbitration();
    await resolvePropose(await act(USERS.customer, { decision: "close_plain" }), ctx(id));
    await approvePost(await act(USERS.performer), ctx(id));
    const res = await readResponse(await withdrawPost(await act(USERS.customer), ctx(id)));
    assert.notEqual(res.status, 200);
  });
});
