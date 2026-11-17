/**
 * Исполнитель и заказчик обязаны быть плательщиками ПДВ: без этого отметки
 * нельзя ни разместить заказ, ни взять работу, ни внести заставу.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetWorld, createOrder, call, ctx, readResponse, USERS, order } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { POST as ordersPost } from "../../src/app/api/v1/orders/route";
import { POST as performerIntentPost } from "../../src/app/api/v1/marketplace/orders/[orderId]/deposits/performer-intent/route";
import { POST as customerIntentPost } from "../../src/app/api/v1/orders/[orderId]/deposits/customer-intent/route";

function setVatPayer(userId: string, vatPayer: boolean) {
  db.updateMany("legalProfile", { where: { userId }, data: { vatPayer } });
}

beforeEach(() => {
  resetWorld();
});

describe("платник ПДВ обов'язковий для заказчика", () => {
  it("заказчик без ПДВ не може розмістити заказ (403)", async () => {
    setVatPayer(USERS.customer, false);
    const res = await readResponse(await ordersPost(await call(USERS.customer, "POST", {})));
    assert.equal(res.status, 403);
  });

  it("заказчик без ПДВ не може внести заставу (403)", async () => {
    const orderId = createOrder({ status: "requires_confirmation", performerUserId: USERS.performer });
    setVatPayer(USERS.customer, false);
    const res = await readResponse(await customerIntentPost(await call(USERS.customer, "POST", {}), ctx(orderId)));
    assert.equal(res.status, 403);
  });
});

describe("платник ПДВ обов'язковий для виконавця", () => {
  it("виконавець без ПДВ не може взяти заказ (403), заказ лишається опублікованим", async () => {
    const orderId = createOrder({ status: "published" });
    setVatPayer(USERS.performer, false);
    const res = await readResponse(await performerIntentPost(await call(USERS.performer, "POST", {}), ctx(orderId)));
    assert.equal(res.status, 403);
    assert.equal(order(orderId).status, "published");
    assert.equal(order(orderId).performerUserId, null);
  });

  it("виконавець з ПДВ бере заказ", async () => {
    const orderId = createOrder({ status: "published" });
    const res = await readResponse(await performerIntentPost(await call(USERS.performer, "POST", {}), ctx(orderId)));
    assert.equal(res.status, 200);
    assert.equal(order(orderId).status, "accepted");
  });
});
