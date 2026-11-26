// Адмін-виписка по рахунку через реальні маршрути: повний цикл заказу,
// виведення коштів виконавцем, потім виписка і пошук користувача.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, customerPays, USERS } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { PATCH as statusPatch } from "../../src/app/api/v1/orders/[orderId]/status/route";
import { POST as confirmPost } from "../../src/app/api/v1/orders/[orderId]/confirm-completion/route";
import { POST as payoutsPost } from "../../src/app/api/v1/finance/payouts/route";
import { GET as statementGet } from "../../src/app/api/v1/admin/finance/users/[id]/statement/route";
import { GET as usersSearchGet } from "../../src/app/api/v1/admin/finance/users/route";

const ADMIN_KEY = "test-panel-secret";
const ADMIN_ID = "admin_1";
process.env.ADMIN_PANEL_SECRET = ADMIN_KEY;

const VALID_IBAN = "UA213223130000026007233566001";

function seedAdmin() {
  db.insert("admin", { id: ADMIN_ID, email: "admin@test.local", passwordHash: "x", role: "admin", active: true });
}

function seedLegalProfile(userId: string) {
  db.updateMany("legalProfile", {
    where: { userId },
    data: { companyName: "ФОП Тестовий Виконавець", edrpou: "12345678", iban: VALID_IBAN, legalAddress: "м. Полтава", vatPayer: true },
  });
}

const adminHeaders = { "x-admin-key": ADMIN_KEY, "x-admin-id": ADMIN_ID };

async function statementOf(userId: string) {
  const req = new Request(`http://localhost/api/v1/admin/finance/users/${userId}/statement`, { headers: adminHeaders });
  return readResponse(await statementGet(req, { params: Promise.resolve({ id: userId }) }));
}

const status = (orderId: string, userId: string, to: string) =>
  call(userId, "PATCH", { status: to }).then((req) => statusPatch(req, ctx(orderId))).then(readResponse);

async function completedAndPaidOut(budget = 10000) {
  const id = createOrder({ days: 1, budget });
  await performerClaimsAndPays(id);
  await customerPays(id);
  await status(id, USERS.performer, "en_route");
  await status(id, USERS.performer, "started");
  await status(id, USERS.performer, "completed");
  const req = await call(USERS.customer, "POST", { accepted: true, rating: 5 });
  const res = await readResponse(await confirmPost(req, ctx(id)));
  assert.equal(res.status, 200, "підтвердження заказчиком має пройти");
  return id;
}

beforeEach(() => {
  resetWorld();
  seedAdmin();
  seedLegalProfile(USERS.performer);
});

describe("адмін-виписка по рахунку", () => {
  it("виписка виконавця: зарахування за роботу, заявка на виведення і баланс збігаються", async () => {
    await completedAndPaidOut(10000);
    const payoutReq = await call(USERS.performer, "POST", { amount: 1000 });
    assert.equal((await readResponse(await payoutsPost(payoutReq))).status, 201);

    const res = await statementOf(USERS.performer);
    assert.equal(res.status, 200);
    const st = res.body.data;

    assert.equal(st.balanceMatchesSummary, true, "баланс за хронологією має збігатися з підсумком журналу");
    const payout = st.operations.find((o: any) => o.kind === "order_payout" && o.status === "completed");
    const withdrawal = st.operations.find((o: any) => o.kind === "withdrawal");
    assert.ok(payout && withdrawal, "є і зарахування, і заявка");
    assert.ok(payout.balanceEffect > 0, "зарахування збільшує баланс");
    assert.equal(withdrawal.balanceEffect, -1000, "заявка зменшує баланс на суму");
    assert.equal(st.availableUah, round2(payout.balanceEffect - 1000));
    assert.equal(st.totals.pendingWithdrawal, 1000);
  });

  it("виписка заказчика: оплата, комісія і нетто по заказу без коштів в ескроу", async () => {
    const orderId = await completedAndPaidOut(10000);
    const res = await statementOf(USERS.customer);
    assert.equal(res.status, 200);
    const st = res.body.data;

    const order = st.orders.find((o: any) => o.orderId === orderId);
    assert.ok(order, "заказ є у взаєморозрахунках");
    assert.ok(order.paidOut > 0, "сплачено оплату і комісію");
    assert.equal(order.received, 0, "заказчик нічого не отримував за цим заказом");
    assert.equal(order.net, -order.paidOut);
    assert.ok(st.totals.feesPaid > 0, "комісія сервісу виведена окремо");
    assert.equal(st.balanceMatchesSummary, true);
  });

  it("невідомий користувач дає 404", async () => {
    const res = await statementOf("nobody");
    assert.equal(res.status, 404);
  });

  it("без ключа панелі доступ заборонено", async () => {
    const req = new Request(`http://localhost/api/v1/admin/finance/users/${USERS.customer}/statement`);
    const res = await readResponse(await statementGet(req, { params: Promise.resolve({ id: USERS.customer }) }));
    assert.equal(res.status, 401);
  });

  it("пошук користувача знаходить виконавця за іменем і не повертає токенів", async () => {
    db.updateMany("user", { where: { id: USERS.performer }, data: { name: "Олена Виконавець", email: "olena@test.local" } });
    // Тестова БД порівнює регістр точно; без учёта регістра відповідає Prisma (mode: insensitive).
    const req = new Request("http://localhost/api/v1/admin/finance/users?q=Олена", { headers: adminHeaders });
    const res = await readResponse(await usersSearchGet(req));
    assert.equal(res.status, 200);
    const users = res.body.data.users;
    assert.equal(users.length, 1);
    assert.equal(users[0].id, USERS.performer);
    assert.equal(users[0].passwordHash, undefined);
  });
});

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
