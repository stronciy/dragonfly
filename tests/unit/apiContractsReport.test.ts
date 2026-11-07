// Відправка фотозвіту виконавця замовнику: умови, ідемпотентність, сповіщення
// і видимість відправки в деталях та звіті.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, customerPays, USERS, order, bearer, notificationsFor } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { POST as reportSubmit } from "../../src/app/api/v1/orders/[orderId]/report/submit/route";
import { POST as reportMediaPost } from "../../src/app/api/v1/orders/[orderId]/report/media/route";
import { GET as reportGet } from "../../src/app/api/v1/orders/[orderId]/report/route";
import { PATCH as statusPatch } from "../../src/app/api/v1/orders/[orderId]/status/route";
import { GET as orderGet } from "../../src/app/api/v1/orders/[orderId]/route";

async function startedOrder() {
  const id = createOrder({ days: 1 });
  await performerClaimsAndPays(id);
  await customerPays(id);
  await statusPatch(await call(USERS.performer, "PATCH", { status: "en_route" }), ctx(id));
  await statusPatch(await call(USERS.performer, "PATCH", { status: "started" }), ctx(id));
  return id;
}

async function uploadPhoto(orderId: string, userId: string = USERS.performer) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([1, 2, 3])], "field.jpg", { type: "image/jpeg" }));
  const req = new Request("http://localhost/x", { method: "POST", headers: { authorization: await bearer(userId) }, body: form });
  return readResponse(await reportMediaPost(req, ctx(orderId)));
}

const submit = async (orderId: string, userId: string = USERS.performer) =>
  readResponse(await reportSubmit(await call(userId, "POST"), ctx(orderId)));

beforeEach(() => resetWorld());

describe("відправка звіту: умови", () => {
  it("без жодного фото звіт не надсилається (400)", async () => {
    const id = await startedOrder();
    const res = await submit(id);
    assert.equal(res.status, 400);
    assert.equal(order(id).reportSubmittedAt, undefined);
  });

  it("до старту робіт звіт не надсилається (409), навіть з фото", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    db.insert("orderMedia", { id: "m-pre", orderId: id, userId: USERS.performer, kind: "report", url: "data:image/jpeg;base64,AA==", createdAt: new Date() });
    const res = await submit(id);
    assert.equal(res.status, 409);
  });

  it("сторонній виконавець не надсилає чужий звіт (404)", async () => {
    const id = await startedOrder();
    await uploadPhoto(id);
    const res = await submit(id, USERS.otherPerformer);
    assert.equal(res.status, 404);
  });

  it("заказчик не може надіслати звіт виконавця (403)", async () => {
    const id = await startedOrder();
    await uploadPhoto(id);
    assert.equal((await submit(id, USERS.customer)).status, 403);
  });
});

describe("відправка звіту: успіх і наслідки", () => {
  it("з фото звіт надсилається: час відправки, запис у таймлайні, сповіщення заказчику", async () => {
    const id = await startedOrder();
    await uploadPhoto(id);
    const res = await submit(id);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.report.status, "submitted");
    assert.equal(res.body.data.report.photoCount, 1);
    assert.ok(order(id).reportSubmittedAt, "час відправки збережено");

    const events = db.findMany("orderStatusEvent", { where: { orderId: id } }) as any[];
    assert.ok(events.some((e) => String(e.note).includes("Звіт виконавця надіслано")));

    const customerNotes = notificationsFor(USERS.customer).filter((n) => n.data?.type === "report_submitted");
    assert.equal(customerNotes.length, 1);
    assert.equal(customerNotes[0].data.action, "view_order");
  });

  it("повторна відправка відхиляється (409) і не дублює сповіщення", async () => {
    const id = await startedOrder();
    await uploadPhoto(id);
    assert.equal((await submit(id)).status, 200);
    assert.equal((await submit(id)).status, 409);
    assert.equal(notificationsFor(USERS.customer).filter((n) => n.data?.type === "report_submitted").length, 1);
  });

  it("паралельні відправки: рівно одна успішна, інша — 409", async () => {
    const id = await startedOrder();
    await uploadPhoto(id);
    const [a, b] = await Promise.all([submit(id), submit(id)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(notificationsFor(USERS.customer).filter((n) => n.data?.type === "report_submitted").length, 1);
  });

  it("після завершення роботи звіт ще можна надіслати (200)", async () => {
    const id = await startedOrder();
    await uploadPhoto(id);
    await statusPatch(await call(USERS.performer, "PATCH", { status: "completed" }), ctx(id));
    assert.equal((await submit(id)).status, 200);
  });

  it("заказчик бачить час відправки у звіті та в деталях замовлення", async () => {
    const id = await startedOrder();
    await uploadPhoto(id);
    assert.equal((await readResponse(await reportGet(await call(USERS.customer, "GET"), ctx(id)))).body.data.report.submittedAt, null);
    await submit(id);
    const report = await readResponse(await reportGet(await call(USERS.customer, "GET"), ctx(id)));
    assert.ok(report.body.data.report.submittedAt, "звіт показує час відправки");
    const details = await readResponse(await orderGet(await call(USERS.customer, "GET"), ctx(id)));
    assert.ok(details.body.data.order.reportSubmittedAt, "деталі заказу містять відправку");
  });
});
