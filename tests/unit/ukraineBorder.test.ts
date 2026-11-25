import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isWithinUkraine } from "../../src/lib/ukraineBorder";
import { resetWorld, createOrder, call, ctx, readResponse, USERS, order } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { claimOrderForPerformer, prisma } from "../../src/shared";
import type { Prisma } from "@prisma/client";
import { GET as marketplaceOrderGet } from "../../src/app/api/v1/marketplace/orders/[orderId]/route";
import { PUT as performerSettingsPut } from "../../src/app/api/v1/performer/settings/route";

const UA: Array<[string, number, number]> = [
  ["Київ", 50.45, 30.52],
  ["Ужгород", 48.62, 22.29],
  ["Ізмаїл", 45.35, 28.84],
  ["Сімферополь", 44.95, 34.1],
  ["Севастополь", 44.6, 33.52],
  ["Луганськ", 48.57, 39.31],
  ["Чернігів", 51.5, 31.3],
];

// Усі ці точки потрапляли в старий прямокутник 44.2–52.5 / 22–40.5.
const ABROAD: Array<[string, number, number]> = [
  ["Кишинів", 47.01, 28.86],
  ["Тирасполь", 46.84, 29.63],
  ["Бєлгород", 50.6, 36.6],
  ["Курськ", 51.73, 36.19],
  ["Ростов-на-Дону", 47.23, 39.7],
  ["Гомель", 52.43, 31.0],
  ["Ясси", 47.16, 27.59],
  ["Перемишль", 49.78, 22.77],
];

describe("кордон України", () => {
  for (const [name, lat, lng] of UA) {
    it(`${name} — в межах України`, () => assert.equal(isWithinUkraine(lat, lng), true));
  }
  for (const [name, lat, lng] of ABROAD) {
    it(`${name} — за межами України`, () => assert.equal(isWithinUkraine(lat, lng), false));
  }
  it("некоректні координати — за межами", () => {
    assert.equal(isWithinUkraine(Number.NaN, 30), false);
    assert.equal(isWithinUkraine(0, 0), false);
  });
});

describe("заказ за межами України", () => {
  beforeEach(() => resetWorld());

  function abroadOrder() {
    const id = createOrder({});
    db.update("order", { where: { id }, data: { lat: 47.01, lng: 28.86 } });
    return id;
  }

  it("Виконавець не може взяти замовлення за межами України", async () => {
    const id = abroadOrder();
    await assert.rejects(
      claimOrderForPerformer(prisma as unknown as Prisma.TransactionClient, { orderId: id, performerUserId: USERS.performer }),
      (e: any) => e.status === 409 && /межах України/.test(e.message)
    );
    assert.equal(order(id).status, "published");
    assert.equal(order(id).performerUserId, null);
  });

  it("замовлення за межами України не відкривається Виконавцю з біржі", async () => {
    const id = abroadOrder();
    db.insert("orderMatch", {
      id: "m1",
      orderId: id,
      performerUserId: USERS.performer,
      status: "pending",
      distanceKm: 10,
      createdAt: new Date(),
    });
    const res = await readResponse(await marketplaceOrderGet(await call(USERS.performer, "GET"), ctx(id)));
    assert.equal(res.status, 404);
  });

  it("базову локацію Виконавця за межами України зберегти не можна", async () => {
    const res = await readResponse(
      await performerSettingsPut(await call(USERS.performer, "PUT", { baseCoordinate: { lat: 47.01, lng: 28.86 } }))
    );
    assert.equal(res.status, 400);
    assert.match(res.body.error?.message ?? res.body.message ?? "", /межах України/);
  });
});
