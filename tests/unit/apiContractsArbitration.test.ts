// Спір вирішує лише адміністратор: сторони не пропонують, не підтверджують і не
// відхиляють рішення самі. Листування і оцінки — окремі сценарії.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, customerPays,
  USERS, order,
} from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { PATCH as statusPatch } from "../../src/app/api/v1/orders/[orderId]/status/route";
import { POST as openArb } from "../../src/app/api/v1/orders/[orderId]/arbitration/route";
import { GET as resolveGet, POST as resolvePropose } from "../../src/app/api/v1/orders/[orderId]/arbitration/resolve/route";
import { POST as approvePost } from "../../src/app/api/v1/orders/[orderId]/arbitration/resolve/approve/route";
import { POST as rejectPost } from "../../src/app/api/v1/orders/[orderId]/arbitration/resolve/reject/route";
import { POST as withdrawPost } from "../../src/app/api/v1/orders/[orderId]/arbitration/resolve/withdraw/route";

const ADMIN_KEY = "test-panel-secret";
process.env.ADMIN_PANEL_SECRET = ADMIN_KEY;

async function inArbitration(days = 1, budget = 10000) {
  const id = createOrder({ days, budget });
  await performerClaimsAndPays(id);
  await customerPays(id);
  await statusPatch(await call(USERS.performer, "PATCH", { status: "en_route" }), ctx(id));
  await statusPatch(await call(USERS.performer, "PATCH", { status: "started" }), ctx(id));
  await statusPatch(await call(USERS.performer, "PATCH", { status: "completed" }), ctx(id));
  const res = await readResponse(await openArb(await call(USERS.customer, "POST", { reason: "Не виконано" }), ctx(id)));
  assert.equal(res.status, 201);
  return id;
}

beforeEach(() => {
  resetWorld();
  db.insert("admin", { id: "admin_1", email: "a@test.local", passwordHash: "x", role: "admin", active: true });
});

describe("сторони не вирішують спір самі", () => {
  it("заказчик не може запропонувати рішення (403), заказ лишається в арбітражі", async () => {
    const id = await inArbitration();
    const res = await readResponse(await resolvePropose(await call(USERS.customer, "POST", { decision: "close_plain" }), ctx(id)));
    assert.equal(res.status, 403);
    assert.equal(order(id).status, "arbitration");
    assert.equal(db.findMany("arbitrationResolution", { where: { orderId: id } }).length, 0);
  });

  it("виконавець не може ні підтвердити, ні відхилити, ні відкликати (403)", async () => {
    const id = await inArbitration();
    for (const handler of [approvePost, rejectPost, withdrawPost]) {
      const res = await readResponse(await handler(await call(USERS.performer, "POST", {}), ctx(id)));
      assert.equal(res.status, 403);
    }
    assert.equal(order(id).status, "arbitration");
  });

  it("читання стану спору доступне стороні і не змінює його", async () => {
    const id = await inArbitration();
    const res = await readResponse(await resolveGet(await call(USERS.performer, "GET"), ctx(id)));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.resolution, null);
  });

  it("решення адміна закриває заказ (єдиний шлях розв'язання)", async () => {
    const id = await inArbitration();
    const { POST: rulingPost } = await import("../../src/app/api/v1/admin/arbitration/[caseId]/ruling/route");
    const caseId = db.findMany("arbitrationCase", { where: { orderId: id } })[0].id as string;
    const res = await readResponse(
      await rulingPost(
        new Request("http://localhost/x", {
          method: "POST",
          headers: { "x-admin-key": ADMIN_KEY, "x-admin-id": "admin_1", "content-type": "application/json" },
          body: JSON.stringify({ winner: "customer", penalty: false, reason: "Ок" }),
        }),
        { params: Promise.resolve({ caseId }) },
      ),
    );
    assert.equal(res.status, 200);
    assert.equal(order(id).status, "completed");
  });
});
