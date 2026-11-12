// Строки відповіді в арбітражі: кожна сторона має добу; відповідь знімає її строк,
// повідомлення іншої сторони або адміна його запускає.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, customerPays, USERS, order, rowsWhere } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { PATCH as statusPatch } from "../../src/app/api/v1/orders/[orderId]/status/route";
import { GET as arbGet, POST as openArb, PATCH as arbMessage } from "../../src/app/api/v1/orders/[orderId]/arbitration/route";
import { POST as adminMessagePost } from "../../src/app/api/v1/admin/arbitration/[caseId]/messages/route";
import { GET as ratingGet, POST as ratingPost } from "../../src/app/api/v1/orders/[orderId]/rating/route";

const ADMIN_KEY = "test-panel-secret";
process.env.ADMIN_PANEL_SECRET = ADMIN_KEY;
const DAY = 24 * 60 * 60 * 1000;

async function opened(by: "customer" | "performer" = "customer") {
  const id = createOrder({ days: 1, budget: 10000 });
  await performerClaimsAndPays(id);
  await customerPays(id);
  for (const s of ["en_route", "started", "completed"]) {
    await statusPatch(await call(USERS.performer, "PATCH", { status: s }), ctx(id));
  }
  const userId = by === "customer" ? USERS.customer : USERS.performer;
  const res = await readResponse(await openArb(await call(userId, "POST", { reason: "Спір" }), ctx(id)));
  assert.equal(res.status, 201);
  const kase = rowsWhere("arbitrationCase", { orderId: id })[0];
  return { id, caseId: kase.id as string };
}

const kaseOf = (caseId: string) => db.findUnique("arbitrationCase", { where: { id: caseId } }) as Record<string, any>;
const adminReq = (body: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "x-admin-key": ADMIN_KEY, "x-admin-id": "admin_1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  resetWorld();
  db.insert("admin", { id: "admin_1", email: "a@test.local", passwordHash: "x", role: "admin", active: true });
});

describe("строки відповіді", () => {
  it("відкриття: відповідає інша сторона, а відкривач строку не має", async () => {
    const { caseId } = await opened("customer");
    const kase = kaseOf(caseId);
    assert.equal(kase.customerResponseDueAt, null);
    const due = new Date(kase.performerResponseDueAt).getTime();
    assert.ok(Math.abs(due - (Date.now() + DAY)) < 60_000, "виконавець має добу на відповідь");
  });

  it("відповідь сторони знімає її строк і запускає строк іншій стороні", async () => {
    const { id, caseId } = await opened("customer");
    await readResponse(await arbMessage(await call(USERS.performer, "PATCH", { reason: "Відповідаю" }), ctx(id)));
    const kase = kaseOf(caseId);
    assert.equal(kase.performerResponseDueAt, null, "виконавець відповів — його строк знято");
    assert.ok(kase.customerResponseDueAt, "заказчик має добу на відповідь");
  });

  it("приватне повідомлення адміну не запускає строк другій стороні", async () => {
    const { id, caseId } = await opened("customer");
    await db.update("arbitrationCase", { where: { id: caseId }, data: { customerResponseDueAt: null, performerResponseDueAt: null } } as any);
    await readResponse(await arbMessage(await call(USERS.customer, "PATCH", { reason: "Лише адміну", toAdmin: true }), ctx(id)));
    assert.equal(kaseOf(caseId).performerResponseDueAt, null, "приватний лист не запускає строк виконавцю");
  });

  it("загальне повідомлення адміна запускає строк обом сторонам", async () => {
    const { caseId } = await opened("customer");
    // Знімаємо строк виконавця відповіддю, потім адмін пише загальне
    await db.update("arbitrationCase", { where: { id: caseId }, data: { customerResponseDueAt: null, performerResponseDueAt: null } } as any);
    await adminMessagePost(adminReq({ text: "Всім: докази" }), { params: Promise.resolve({ caseId }) });
    const kase = kaseOf(caseId);
    assert.ok(kase.customerResponseDueAt && kase.performerResponseDueAt, "обидві сторони мають добу");
  });

  it("приватне повідомлення адміна запускає строк лише адресату", async () => {
    const { caseId } = await opened("customer");
    await db.update("arbitrationCase", { where: { id: caseId }, data: { customerResponseDueAt: null, performerResponseDueAt: null } } as any);
    await adminMessagePost(adminReq({ text: "Заказчику", channel: "customer" }), { params: Promise.resolve({ caseId }) });
    const kase = kaseOf(caseId);
    assert.ok(kase.customerResponseDueAt);
    assert.equal(kase.performerResponseDueAt, null);
  });

  it("сторона бачить свій строк у відповіді на GET", async () => {
    const { id } = await opened("customer");
    const res = await readResponse(await arbGet(await call(USERS.performer, "GET"), ctx(id)));
    assert.ok(res.body.data.myResponseDueAt, "виконавець бачить свій строк");
    const cust = await readResponse(await arbGet(await call(USERS.customer, "GET"), ctx(id)));
    assert.equal(cust.body.data.myResponseDueAt, null, "відкривач строку не має");
  });

  it("після закриття спору по строку оцінка доступна обом", async () => {
    const { id, caseId } = await opened("customer");
    // Імітація закриття воркером: кейс closed, заказ completed
    await db.update("arbitrationCase", { where: { id: caseId }, data: { status: "closed", closedAt: new Date() } } as any);
    await db.update("order", { where: { id }, data: { status: "completed" } } as any);
    const st = await readResponse(await ratingGet(await call(USERS.customer, "GET"), ctx(id)));
    assert.equal(st.body.data.rating.canRate, true);
    const r = await readResponse(
      await call(USERS.performer, "POST", { rating: 4 }).then((req) => ratingPost(req, ctx(id))),
    );
    assert.equal(r.status, 201);
    assert.equal(order(id).status, "completed");
  });
});
