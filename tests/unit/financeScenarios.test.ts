// Фінансовий журнал і виведення коштів: сценарії через реальні роути та
// сервіси на in-memory базі. Перевіряємо, що кожен грошовий крок з'являється
// в журналі правильної ролі з правильною сумою, статусом і поясненням.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, customerPays,
  USERS,
} from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { PATCH as statusPatch } from "../../src/app/api/v1/orders/[orderId]/status/route";
import { POST as confirmPost } from "../../src/app/api/v1/orders/[orderId]/confirm-completion/route";
import { POST as progressPost } from "../../src/app/api/v1/orders/[orderId]/progress/route";
import { POST as refusePost } from "../../src/app/api/v1/orders/[orderId]/refuse/route";
import { GET as transactionsGet } from "../../src/app/api/v1/finance/transactions/route";
import { GET as payoutsGet, POST as payoutsPost } from "../../src/app/api/v1/finance/payouts/route";
import { GET as adminPayoutsGet } from "../../src/app/api/v1/admin/payouts/route";
import { PATCH as adminPayoutPatch } from "../../src/app/api/v1/admin/payouts/[id]/route";
import { POST as performerDepositDecisionPost } from "../../src/app/api/v1/orders/[orderId]/performer-deposit-decision/route";
import { POST as confirmProgressPost } from "../../src/app/api/v1/orders/[orderId]/confirm-progress/route";

const decisionPost = (req: Request, orderId: string) => performerDepositDecisionPost(req, ctx(orderId));

const ADMIN_KEY = "test-panel-secret";
const ADMIN_ID = "admin_1";
process.env.ADMIN_PANEL_SECRET = ADMIN_KEY;

/** Валідний український IBAN (контрольна сума перевірена validateUAIban). */
const VALID_IBAN = "UA213223130000026007233566001";

function seedLegalProfile(userId: string, iban: string | null) {
  db.updateMany("legalProfile", {
    where: { userId },
    data: {
      companyName: "ФОП Тестовий Виконавець",
      edrpou: "12345678",
      iban,
      legalAddress: "м. Полтава",
      vatPayer: true,
    },
  });
}

function seedAdmin() {
  db.insert("admin", { id: ADMIN_ID, email: "admin@test.local", passwordHash: "x", role: "admin", active: true });
}

function kindOf(entries: Array<Record<string, any>>, kind: string): Record<string, any> {
  const found = entries.find((e) => e.kind === kind);
  assert.ok(found, `запис ${kind} відсутній у журналі`);
  return found;
}

const transactions = async (userId: string) => {
  const req = await call(userId, "GET");
  const res = await readResponse(await transactionsGet(req));
  assert.equal(res.status, 200);
  return res.body.data as { summary: Record<string, number>; entries: Array<Record<string, any>> };
};

async function requestPayout(userId: string, amount: number) {
  const req = await call(userId, "POST", { amount });
  return readResponse(await payoutsPost(req));
}

async function processPayout(id: string, body: Record<string, unknown>) {
  const req = new Request(`http://localhost/api/v1/admin/payouts/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY, "x-admin-id": ADMIN_ID },
    body: JSON.stringify(body),
  });
  return readResponse(await adminPayoutPatch(req, { params: Promise.resolve({ id }) }));
}

const status = (orderId: string, userId: string, to: string) =>
  call(userId, "PATCH", { status: to }).then((req) => statusPatch(req, ctx(orderId))).then(readResponse);

const confirm = (orderId: string, body: Record<string, unknown>) =>
  call(USERS.customer, "POST", body).then((req) => confirmPost(req, ctx(orderId))).then(readResponse);

const confirmProgress = (orderId: string, userId: string = USERS.customer) =>
  call(userId, "POST", {}).then((req) => confirmProgressPost(req, ctx(orderId))).then(readResponse);

const progress = (orderId: string, percent: number) =>
  call(USERS.performer, "POST", { percent }).then((req) => progressPost(req, ctx(orderId))).then(readResponse);

async function completedOneDay(budget = 10000) {
  const id = createOrder({ days: 1, budget });
  await performerClaimsAndPays(id);
  await customerPays(id);
  await status(id, USERS.performer, "en_route");
  await status(id, USERS.performer, "started");
  await status(id, USERS.performer, "completed");
  return id;
}

beforeEach(() => {
  resetWorld();
  seedAdmin();
  seedLegalProfile(USERS.performer, VALID_IBAN);
});

// У тестах немає LiqPay-холдів (payment_id), тож розрахунок після відмови
// лишається «pending». Доводимо його до кінця так, як це робить LiqPay у проді.
function settleLikeLiqPay(orderId: string) {
  const final: Record<string, string> = { release_pending: "released", refund_pending: "refunded", forfeit_pending: "forfeited" };
  for (const lock of db.findMany("escrowLock", { where: { orderId } }) as any[]) {
    const to = final[lock.status] ?? (["released", "refunded", "forfeited"].includes(lock.status) ? lock.status : null);
    if (!to) continue;
    db.update("escrowLock", { where: { id: lock.id }, data: { status: to, releasedAt: lock.releasedAt ?? new Date() } });
    for (const intent of db.findMany("paymentIntent", { where: { orderId, role: lock.role, status: "paid" } }) as any[]) {
      db.update("paymentIntent", { where: { id: intent.id }, data: { status: to } });
    }
  }
}

describe("журнал Заказчика", () => {
  it("під час робіт: оплата і комісія в ескроу, у журналі видно, чому кошти заблоковані", async () => {
    const id = createOrder({ days: 1, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    const { summary, entries } = await transactions(USERS.customer);

    const deposit = kindOf(entries, "customer_deposit");
    assert.equal(deposit.amount, 10000);
    assert.equal(deposit.direction, "out");
    assert.equal(deposit.status, "in_escrow");
    assert.equal(deposit.orderId, id);
    assert.match(deposit.reason, /заблоковані/);

    const fee = kindOf(entries, "service_fee");
    assert.equal(fee.amount, 850);
    assert.equal(fee.status, "completed", "комісія не повертається");

    assert.equal(summary.inEscrowUah, 10000);
    assert.equal(summary.feesPaidUah, 850);
    assert.equal(summary.earnedOrPaidUah, 850, "поки робота в процесі, у сплачених лише комісія сервісу, а застава в ескроу");
    assert.equal(summary.refundedUah, 0);
  });

  it("після підтвердження роботи: кошти передано Виконавцю, Заказчик бачить, за що і коли", async () => {
    const id = await completedOneDay(10000);
    assert.equal((await confirm(id, { accepted: true, rating: 5 })).status, 200);
    const { summary, entries } = await transactions(USERS.customer);
    const deposit = kindOf(entries, "customer_deposit");
    assert.equal(deposit.status, "completed");
    assert.match(deposit.reason, /передано Виконавцю/i);
    assert.ok(deposit.occurredAt, "є час події");
    assert.equal(summary.inEscrowUah, 0);
    assert.equal(summary.earnedOrPaidUah, 10850, "після підтвердження кошти Виконавцю і комісія сервісу входять у сплачені");
  });

  it("заказ на 3 дні: 30% + комісія одразу, 70% — окремий запис з часом внесення", async () => {
    const id = createOrder({ days: 3, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    await status(id, USERS.performer, "en_route");
    await status(id, USERS.performer, "started");
    await progress(id, 30);
    assert.equal((await customerPays(id, 2)).status, 200);

    const { summary, entries } = await transactions(USERS.customer);
    const first = kindOf(entries, "customer_deposit");
    assert.equal(first.amount, 3000);
    assert.match(first.title, /30%/);
    const balance = kindOf(entries, "customer_balance");
    assert.equal(balance.amount, 7000);
    assert.match(balance.title, /70%/);
    assert.equal(summary.inEscrowUah, 10000, "уся вартість у гарантії до завершення");
    assert.equal(summary.feesPaidUah, 850, "комісія лише один раз");
  });

  it("Виконавець відмовився до оплати Заказчика: застава одразу розблокована, пояснення коректне", async () => {
    const id = createOrder({ days: 1, budget: 10000 });
    await performerClaimsAndPays(id);
    const req = await call(USERS.performer, "POST", { reason: "Не встигаю за графіком" });
    assert.equal((await readResponse(await refusePost(req, ctx(id)))).status, 200);

    const { entries } = await transactions(USERS.performer);
    const deposit = kindOf(entries, "performer_deposit");
    assert.equal(deposit.status, "returned");
    assert.match(deposit.reason, /заказ не виконано/);
    assert.doesNotMatch(deposit.reason, /після завершення/);
  });

  it("застава в черзі на розблокування показується окремим статусом, не як розблокована", async () => {
    const id = createOrder({ days: 1, budget: 10000 });
    await performerClaimsAndPays(id);
    db.updateMany("escrowLock", { where: { orderId: id, role: "performer" }, data: { status: "release_pending" } });

    const { entries, summary } = await transactions(USERS.performer);
    const deposit = kindOf(entries, "performer_deposit");
    assert.equal(deposit.status, "unlock_pending");
    assert.match(deposit.reason, /Розблокування обробляє платіжна система/);
    assert.equal(summary.availableUah, 0, "застава ніколи не входить у доступний баланс");
  });

  it("заказ відмінено Виконавцем: кошти повернуто, у журналі «Повернення коштів»", async () => {
    const id = createOrder({ days: 1, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    const req = await call(USERS.performer, "POST", { reason: "Техніка зламалась" });
    assert.equal((await readResponse(await refusePost(req, ctx(id)))).status, 200);

    const { summary, entries } = await transactions(USERS.customer);
    const refund = kindOf(entries, "customer_refund");
    assert.equal(refund.amount, 10000);
    assert.equal(refund.direction, "in");
    assert.equal(summary.refundedUah, 10000);
    assert.equal(summary.inEscrowUah, 0);
    assert.equal(kindOf(entries, "customer_deposit").status, "refunded");
  });

  it("штраф з Виконавця зараховується Замовнику у журнал та підсумок", async () => {
    const id = createOrder({ days: 1, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    db.updateMany("escrowLock", { where: { orderId: id, role: "performer" }, data: { status: "forfeited" } });
    db.updateMany("escrowLock", { where: { orderId: id, role: "customer" }, data: { status: "refunded" } });

    const { summary, entries } = await transactions(USERS.customer);
    const forfeit = kindOf(entries, "performer_deposit_forfeit");
    assert.equal(forfeit.amount, 3000);
    assert.equal(forfeit.direction, "in");
    assert.equal(forfeit.title, "Штраф з Виконавця");
    assert.equal(summary.refundedUah, 13000);
  });

  it("журнал містить лише власні платежі: інший Заказчик нічого не бачить", async () => {
    const id = await completedOneDay();
    assert.equal((await transactions(USERS.otherCustomer)).entries.length, 0);
    assert.ok((await transactions(USERS.customer)).entries.some((e) => e.orderId === id));
  });
});

describe("журнал Виконавця", () => {
  it("під час робіт: застава в ескроу, баланс для виведення нульовий", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    const { summary, entries } = await transactions(USERS.performer);
    const deposit = kindOf(entries, "performer_deposit");
    assert.equal(deposit.amount, 3000);
    assert.equal(deposit.status, "in_escrow");
    assert.equal(summary.availableUah, 0);
    assert.equal(summary.inEscrowUah, 3000);
  });

  it("утриманий штраф (forfeited) відображається у підсумку штрафів Виконавця", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    db.updateMany("escrowLock", { where: { orderId: id, role: "performer" }, data: { status: "forfeited" } });
    const { summary, entries } = await transactions(USERS.performer);
    const deposit = kindOf(entries, "performer_deposit");
    assert.equal(deposit.status, "forfeited");
    assert.equal(summary.refundedUah, 3000);
  });

  it("після завершення і підтвердження: оплата за роботу на балансі, застава розблокована на картці", async () => {
    const id = await completedOneDay(10000);
    assert.equal((await confirm(id, { accepted: true, rating: 5 })).status, 200);
    const { summary, entries } = await transactions(USERS.performer);

    const payout = kindOf(entries, "order_payout");
    assert.equal(payout.amount, 10000);
    assert.equal(payout.direction, "in");
    assert.equal(payout.status, "completed");
    assert.match(payout.reason, /підтвердив завершення/);

    const back = kindOf(entries, "performer_deposit_return");
    assert.equal(back.amount, 3000);
    assert.equal(kindOf(entries, "performer_deposit").status, "returned");

    assert.equal(summary.availableUah, 10000, "застава на баланс не зараховується");
    assert.equal(summary.earnedOrPaidUah, 10000);
    assert.equal(summary.inEscrowUah, 0);
  });

  it("Виконавець завершив, але Замовник ще не прийняв: застава Виконавця заблокована", async () => {
    const id = await completedOneDay(10000);
    const { summary, entries } = await transactions(USERS.performer);
    assert.equal(kindOf(entries, "performer_deposit").status, "in_escrow");
    assert.equal(summary.inEscrowUah, 3000, "застава не розблокована до прийняття Замовником");
    assert.equal(summary.availableUah, 0);
    const customer = await transactions(USERS.customer);
    assert.equal(kindOf(customer.entries, "customer_deposit").status, "in_escrow");
  });

  it("Замовник приймає роботу: обидві застави розблоковано, штрафу немає", async () => {
    const id = await completedOneDay(10000);
    assert.equal((await confirm(id, { accepted: true, rating: 5 })).status, 200);
    const performer = await transactions(USERS.performer);
    assert.equal(kindOf(performer.entries, "performer_deposit").status, "returned");
    assert.equal(performer.summary.inEscrowUah, 0);
    assert.equal(performer.entries.find((e) => e.status === "forfeited"), undefined);
    const customer = await transactions(USERS.customer);
    assert.equal(kindOf(customer.entries, "customer_deposit").status, "completed");
  });

  it("параметр штрафу (fine) більше не утримує заставу: прийняття завжди розблоковує", async () => {
    const id = await completedOneDay(10000);
    assert.equal((await confirm(id, { accepted: true, rating: 2, fine: true } as Record<string, unknown>)).status, 200);
    const { entries } = await transactions(USERS.performer);
    assert.equal(kindOf(entries, "performer_deposit").status, "returned");
  });

  it("прийняття до завершення Виконавцем відхиляється (409)", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    assert.equal((await confirm(id, { accepted: true, rating: 5 })).status, 409);
  });

  it("відмова після оплати Заказчика: застава чекає рішення Замовника, не списується автоматично", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    const req = await call(USERS.performer, "POST", { reason: "Хвороба в бригаді" });
    assert.equal((await readResponse(await refusePost(req, ctx(id)))).status, 200);
    const { summary, entries } = await transactions(USERS.performer);
    const deposit = kindOf(entries, "performer_deposit");
    assert.equal(deposit.status, "decision_pending");
    assert.match(deposit.reason, /вирішує/);
    assert.equal(summary.availableUah, 0);
    assert.equal(summary.inEscrowUah, 3000, "застава блокована, поки Замовник не вирішить");
  });

  it("відмова до оплати Заказчика: застава одразу повертається, Виконавець отримує сповіщення", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    const req = await call(USERS.performer, "POST", { reason: "Не встигаю" });
    assert.equal((await readResponse(await refusePost(req, ctx(id)))).status, 200);

    const { entries } = await transactions(USERS.performer);
    assert.equal(kindOf(entries, "performer_deposit").status, "returned");
    const notes = db.findMany("notification", { where: { userId: USERS.performer } }) as any[];
    assert.ok(notes.find((n) => n.data?.type === "performer_deposit_returned"), "сповіщення про повернення відсутнє");
  });

  it("Замовник повертає заставу після відмови: Виконавець отримує повернення", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    await refusePost(await call(USERS.performer, "POST", { reason: "Хвороба" }), ctx(id));

    const res = await readResponse(await decisionPost(await call(USERS.customer, "POST", { decision: "return" }), id));
    assert.equal(res.status, 200);
    const { summary, entries } = await transactions(USERS.performer);
    assert.equal(kindOf(entries, "performer_deposit").status, "returned");
    assert.equal(summary.inEscrowUah, 0);
    const notes = db.findMany("notification", { where: { userId: USERS.performer } }) as any[];
    assert.ok(notes.find((n) => n.data?.decision === "return"));
  });

  it("Замовник утримує заставу як штраф: застава втрачена, Виконавець бачить штраф", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    await refusePost(await call(USERS.performer, "POST", { reason: "Хвороба" }), ctx(id));

    assert.equal((await readResponse(await decisionPost(await call(USERS.customer, "POST", { decision: "fine" }), id))).status, 200);
    const { summary, entries } = await transactions(USERS.performer);
    const forfeit = kindOf(entries, "performer_deposit");
    assert.equal(forfeit.status, "forfeited");
    assert.match(forfeit.reason, /штраф/);
    assert.equal(summary.availableUah, 0);
    assert.equal(summary.inEscrowUah, 0);
  });

  it("взяв заказ, відмовився, взяв знову, Замовник оплатив: застава в ескроу одна, а не подвійна", async () => {
    const id = createOrder({ days: 1, budget: 500000 });
    await performerClaimsAndPays(id);
    assert.equal((await readResponse(await refusePost(await call(USERS.performer, "POST", { reason: "Помилково взяв" }), ctx(id)))).status, 200);
    settleLikeLiqPay(id);

    await performerClaimsAndPays(id);
    assert.equal((await customerPays(id)).status, 200);

    const { summary, entries } = await transactions(USERS.performer);
    const deposits = entries.filter((e) => e.kind === "performer_deposit");
    assert.equal(deposits.length, 2, "обидва внески застави лишаються в історії");
    assert.deepEqual(deposits.map((d) => d.status).sort(), ["in_escrow", "returned"]);
    assert.equal(summary.inEscrowUah, 150000, "в ескроу лише поточна застава 150 000");
    assert.equal(entries.filter((e) => e.kind === "performer_deposit_return").length, 1, "перша застава — розблокована");

    // Після завершення: поточна застава теж повертається, у ескроу нічого.
    await status(id, USERS.performer, "en_route");
    await status(id, USERS.performer, "started");
    await status(id, USERS.performer, "completed");
    assert.equal((await confirm(id, { accepted: true, rating: 5 })).status, 200);
    const after = await transactions(USERS.performer);
    assert.equal(after.summary.inEscrowUah, 0);
    assert.equal(after.summary.availableUah, 500000);
    assert.deepEqual(
      after.entries.filter((e) => e.kind === "performer_deposit").map((d) => d.status),
      ["returned", "returned"],
    );
  });

  it("Замовнику повернули оплату після відмови Виконавця, потім він оплатив знову: в ескроу одна оплата", async () => {
    const id = createOrder({ days: 1, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    await refusePost(await call(USERS.performer, "POST", { reason: "Хвороба" }), ctx(id));
    await decisionPost(await call(USERS.customer, "POST", { decision: "return" }), id);
    settleLikeLiqPay(id);

    await performerClaimsAndPays(id, USERS.performer);
    assert.equal((await customerPays(id)).status, 200);

    const { summary, entries } = await transactions(USERS.customer);
    assert.equal(summary.inEscrowUah, 10000, "лише поточна оплата");
    assert.deepEqual(
      entries.filter((e) => e.kind === "customer_deposit").map((d) => d.status).sort(),
      ["in_escrow", "refunded"],
    );
    assert.equal(entries.filter((e) => e.kind === "customer_refund").length, 1, "перша оплата — повернута");
  });

  it("рішення щодо застави приймається лише раз (409) і лише Заказчиком", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    await refusePost(await call(USERS.performer, "POST", { reason: "Хвороба" }), ctx(id));

    assert.equal((await decisionPost(await call(USERS.performer, "POST", { decision: "return" }), id)).status, 403);
    assert.equal((await readResponse(await decisionPost(await call(USERS.customer, "POST", { decision: "return" }), id))).status, 200);
    assert.equal((await readResponse(await decisionPost(await call(USERS.customer, "POST", { decision: "fine" }), id))).status, 409);
  });
});

describe("виведення коштів Виконавцем", () => {
  it("Виконавець бачить баланс і виводить частину: заявка резервує кошти", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });

    const res = await requestPayout(USERS.performer, 5000);
    assert.equal(res.status, 201);
    assert.equal(res.body.data.payout.status, "requested");

    const { summary, entries } = await transactions(USERS.performer);
    assert.equal(summary.availableUah, 5000, "10000 − 5000 зарезервовано");
    assert.equal(summary.pendingWithdrawalUah, 5000);
    const withdrawal = kindOf(entries, "withdrawal");
    assert.equal(withdrawal.status, "requested");
    assert.match(withdrawal.reason, /очікує обробки/);
  });

  it("адміністратор перераховує кошти — заявка стає «виконано», баланс не змінюється", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    const payoutId = (await requestPayout(USERS.performer, 5000)).body.data.payout.id;

    const done = await processPayout(payoutId, { action: "mark_paid" });
    assert.equal(done.status, 200);
    const { summary, entries } = await transactions(USERS.performer);
    assert.equal(kindOf(entries, "withdrawal").status, "paid");
    assert.equal(summary.withdrawnUah, 5000);
    assert.equal(summary.availableUah, 5000);
    assert.equal(summary.pendingWithdrawalUah, 0);
  });

  it("адміністратор відхиляє заявку з причиною — кошти повертаються на баланс", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    const payoutId = (await requestPayout(USERS.performer, 5000)).body.data.payout.id;

    const rejected = await processPayout(payoutId, { action: "reject", reason: "IBAN не відповідає виписці" });
    assert.equal(rejected.status, 200);
    const { summary, entries } = await transactions(USERS.performer);
    assert.equal(summary.availableUah, 10000, "повністю відновлено");
    assert.equal(kindOf(entries, "withdrawal").status, "rejected");
    assert.match(kindOf(entries, "withdrawal").reason, /IBAN не відповідає/);
  });

  it("відхилення надсилає Виконавцю сповіщення з причиною і посиланням на кошелек", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    const payoutId = (await requestPayout(USERS.performer, 5000)).body.data.payout.id;

    await processPayout(payoutId, { action: "reject", reason: "IBAN не відповідає виписці" });

    const notes = db.findMany("notification", { where: { userId: USERS.performer } }) as any[];
    const note = notes.find((n) => n.type === "wallet.withdrawal_processed");
    assert.ok(note, "сповіщення про відхилення відсутнє");
    assert.match(note.message, /IBAN не відповідає виписці/);
    assert.match(note.message, /повернуто на баланс/);
    assert.equal(note.data.action, "view_finance");
    assert.equal(note.data.payoutId, payoutId);
  });

  it("після відхилення можна знову подати заявку на весь баланс", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    const payoutId = (await requestPayout(USERS.performer, 10000)).body.data.payout.id;
    await processPayout(payoutId, { action: "reject", reason: "Помилка в реквізитах" });

    const again = await requestPayout(USERS.performer, 10000);
    assert.equal(again.status, 201);
    const { summary } = await transactions(USERS.performer);
    assert.equal(summary.availableUah, 0);
    assert.equal(summary.pendingWithdrawalUah, 10000);
  });

  it("перерахунок надсилає сповіщення з сумою і статусом «виведено»", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    const payoutId = (await requestPayout(USERS.performer, 5000)).body.data.payout.id;

    await processPayout(payoutId, { action: "mark_paid" });

    const notes = db.findMany("notification", { where: { userId: USERS.performer } }) as any[];
    const note = notes.find((n) => n.title === "Виведення виконано");
    assert.ok(note, "сповіщення про переказ відсутнє");
    assert.match(note.message, /5000\.00 ₴ перераховано на ваш рахунок/);
    assert.equal(note.data.action, "view_finance");
  });

  it("сума понад доступний баланс відхиляється (400)", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    const res = await requestPayout(USERS.performer, 13001);
    assert.equal(res.status, 400);
    assert.equal(db.count("payout", {}), 0);
  });

  it("сума менше мінімуму 100 ₴ відхиляється (400)", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    assert.equal((await requestPayout(USERS.performer, 99)).status, 400);
  });

  it("дві заявки разом понад баланс: друга відхиляється", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    assert.equal((await requestPayout(USERS.performer, 9000)).status, 201);
    assert.equal((await requestPayout(USERS.performer, 5000)).status, 400, "доступно лише 4000");
  });

  it("без юридичного профілю з IBAN вивести не можна (400)", async () => {
    db.updateMany("legalProfile", { where: { userId: USERS.performer }, data: { iban: null } });
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    assert.equal((await requestPayout(USERS.performer, 1000)).status, 400);
  });

  it("некоректний IBAN у профілі блокує виведення (400)", async () => {
    db.updateMany("legalProfile", { where: { userId: USERS.performer }, data: { iban: "UA000000000000000000000000000" } });
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    assert.equal((await requestPayout(USERS.performer, 1000)).status, 400);
  });

  it("Заказчик не може створити заявку на виведення (403)", async () => {
    const req = await call(USERS.customer, "POST", { amount: 500 });
    assert.equal((await readResponse(await payoutsPost(req))).status, 403);
  });

  it("список заявок Виконавця містить маскований IBAN і статус", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    await requestPayout(USERS.performer, 1000);
    const res = await readResponse(await payoutsGet(await call(USERS.performer, "GET")));
    assert.equal(res.body.data.payouts.length, 1);
    assert.equal(res.body.data.payouts[0].status, "requested");
    assert.ok(!res.body.data.payouts[0].iban.includes(VALID_IBAN), "повний IBAN не віддається");
  });
});

describe("обробка заявок адміністратором", () => {
  it("запит без ключа панелі відхиляється (401)", async () => {
    const req = new Request("http://localhost/api/v1/admin/payouts", { headers: {} });
    assert.equal((await readResponse(await adminPayoutsGet(req))).status, 401);
  });

  it("обробляти заявку двічі не можна (409)", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    const payoutId = (await requestPayout(USERS.performer, 1000)).body.data.payout.id;
    assert.equal((await processPayout(payoutId, { action: "mark_paid" })).status, 200);
    assert.equal((await processPayout(payoutId, { action: "mark_paid" })).status, 409);
  });

  it("відхилення вимагає причини (400)", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    const payoutId = (await requestPayout(USERS.performer, 1000)).body.data.payout.id;
    assert.equal((await processPayout(payoutId, { action: "reject" })).status, 400);
  });

  it("кожна обробка пишеться в журнал дій адміністратора", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    const payoutId = (await requestPayout(USERS.performer, 1000)).body.data.payout.id;
    await processPayout(payoutId, { action: "mark_paid" });
    const audit = db.findMany("adminAuditLog", { where: { entityId: payoutId } }) as any[];
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "payout.mark_paid");
    assert.equal(audit[0].adminId, ADMIN_ID);
  });

  it("черга заявок показує заявки зі статусом requested з даними Виконавця", async () => {
    const id = await completedOneDay(10000);
    await confirm(id, { accepted: true, rating: 5 });
    await requestPayout(USERS.performer, 1000);
    const req = new Request("http://localhost/api/v1/admin/payouts?status=requested", {
      headers: { "x-admin-key": ADMIN_KEY, "x-admin-id": ADMIN_ID },
    });
    const res = await readResponse(await adminPayoutsGet(req));
    assert.equal(res.body.data.payouts.length, 1);
    assert.equal(res.body.data.payouts[0].amount, 1000);
    assert.equal(res.body.data.payouts[0].user.id, USERS.performer);
    assert.equal(res.body.data.payouts[0].iban, VALID_IBAN, "IBAN потрібен адміністратору для переказу");
  });
});

describe("split-замовлення (> 2 діб) та виведення 30% після прогресу", () => {
  it("до фіксації 30% прогресу: 30% оплати в ескроу, доступно для виведення 0 ₴", async () => {
    const id = createOrder({ days: 3, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id, 1);
    await status(id, USERS.performer, "started");

    const { summary, entries } = await transactions(USERS.performer);
    assert.equal(summary.availableUah, 0);
    assert.equal(summary.inEscrowUah, 3000, "лише застава Виконавця; перший етап Замовника у ескроу — не його кошти");
    const part1 = kindOf(entries, "order_payout");
    assert.equal(part1.status, "in_escrow");
    assert.equal(part1.amount, 3000);
  });

  it("фіксація 30% без підтвердження Замовника: 30% ще не доступні Виконавцю", async () => {
    const id = createOrder({ days: 3, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id, 1);
    await status(id, USERS.performer, "started");
    assert.equal((await progress(id, 30)).status, 200);

    const { summary, entries } = await transactions(USERS.performer);
    assert.equal(summary.availableUah, 0);
    const part1 = kindOf(entries, "order_payout");
    assert.equal(part1.status, "in_escrow");
    assert.match(part1.reason, /після підтвердження Замовником/);
  });

  it("підтвердження 30%: лише Замовник, лише після фіксації 30%, лише один раз", async () => {
    const id = createOrder({ days: 3, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id, 1);
    await status(id, USERS.performer, "started");

    assert.equal((await confirmProgress(id)).status, 409, "до фіксації 30% підтверджувати нічого");
    await progress(id, 30);
    assert.equal((await confirmProgress(id, USERS.performer)).status, 403);
    assert.equal((await confirmProgress(id)).status, 200);
    assert.equal((await confirmProgress(id)).status, 409, "повторне підтвердження");
  });

  it("підтвердження 30% недоступне для замовлення з оплатою 100%", async () => {
    const id = createOrder({ days: 1, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id, 1);
    await status(id, USERS.performer, "started");
    assert.equal((await confirmProgress(id)).status, 409);
  });

  it("після фіксації 30% і підтвердження Замовником: 30% доступні, Виконавець виводить кошти", async () => {
    const id = createOrder({ days: 3, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id, 1);
    await status(id, USERS.performer, "started");

    const progRes = await progress(id, 30);
    assert.equal(progRes.status, 200);
    assert.equal((await confirmProgress(id)).status, 200);

    const customerView = await transactions(USERS.customer);
    const custPart1 = kindOf(customerView.entries, "customer_deposit");
    assert.equal(custPart1.status, "completed", "у Замовника підтверджені 30% — передано Виконавцю, не ескроу");
    assert.equal(customerView.summary.inEscrowUah, 0);

    const { summary, entries } = await transactions(USERS.performer);
    assert.equal(summary.availableUah, 3000, "30% вартості замовлення (3000 ₴) тепер доступні для виведення");
    assert.equal(summary.earnedOrPaidUah, 3000);
    const part1 = kindOf(entries, "order_payout");
    assert.equal(part1.status, "completed");
    assert.equal(part1.amount, 3000);
    assert.equal(part1.direction, "in");

    // Виконавець створює заявку на виведення зароблених 30% (3000 ₴)
    const payoutRes = await requestPayout(USERS.performer, 3000);
    assert.equal(payoutRes.status, 201);
    assert.equal(payoutRes.body.data.payout.amount, 3000);
    assert.equal(payoutRes.body.data.payout.status, "requested");

    const afterPayout = await transactions(USERS.performer);
    assert.equal(afterPayout.summary.availableUah, 0);
    assert.equal(afterPayout.summary.pendingWithdrawalUah, 3000);
  });

  it("повний цикл split-замовлення: виведення 30% на етапі 30%, сплата Замовником 70%, завершення і виведення залишку 70%", async () => {
    const id = createOrder({ days: 3, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id, 1);
    await status(id, USERS.performer, "started");

    // 1. Досягнуто 30%, замовник підтверджує 30% робіт
    await progress(id, 30);
    assert.equal((await confirmProgress(id)).status, 200);
    const p1 = await requestPayout(USERS.performer, 3000);
    assert.equal(p1.status, 201);
    // Адмін проводить виплату перших 30%
    await processPayout(p1.body.data.payout.id, { action: "mark_paid" });

    // 2. Замовник сплачує залишок 70%
    await customerPays(id, 2);
    const mid = await transactions(USERS.performer);
    assert.equal(mid.summary.withdrawnUah, 3000);
    assert.equal(mid.summary.availableUah, 0);
    assert.equal(mid.summary.inEscrowUah, 3000, "лише застава Виконавця; залишок Заказчика в ескроу — не його кошти");

    // 3. Завершення робіт і підтвердження замовником
    await status(id, USERS.performer, "completed");
    await confirm(id, { accepted: true, rating: 5 });

    const finalTxs = await transactions(USERS.performer);
    assert.equal(finalTxs.summary.earnedOrPaidUah, 10000);
    assert.equal(finalTxs.summary.withdrawnUah, 3000);
    assert.equal(finalTxs.summary.availableUah, 7000, "10000 зароблено − 3000 вже виведено = 7000 доступно");
    assert.equal(finalTxs.summary.inEscrowUah, 0, "застава розблокована");

    // 4. Виведення решти 7000 ₴
    const p2 = await requestPayout(USERS.performer, 7000);
    assert.equal(p2.status, 201);
    const afterP2 = await transactions(USERS.performer);
    assert.equal(afterP2.summary.availableUah, 0);
    assert.equal(afterP2.summary.pendingWithdrawalUah, 7000);
  });

  it("Замовник не підтверджував 30% окремо: підтвердження всього замовлення відкриває всю суму", async () => {
    const id = createOrder({ days: 3, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id, 1);
    await status(id, USERS.performer, "started");
    await progress(id, 30);
    assert.equal((await customerPays(id, 2)).status, 200);
    await status(id, USERS.performer, "completed");

    const before = await transactions(USERS.performer);
    assert.equal(before.summary.availableUah, 0, "до підтвердження Замовником нічого не доступно");

    assert.equal((await confirm(id, { accepted: true })).status, 200);
    const after = await transactions(USERS.performer);
    assert.equal(after.summary.availableUah, 10000);
    assert.equal(after.summary.earnedOrPaidUah, 10000);
  });

  it("Виконавець завершив до оплати 70%: Замовник доплачує вже після завершення, підтверджує, і Виконавець виводить 70%", async () => {
    const id = createOrder({ days: 3, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id, 1);
    await status(id, USERS.performer, "started");
    await progress(id, 30);
    assert.equal((await confirmProgress(id)).status, 200);
    const p1 = await requestPayout(USERS.performer, 3000);
    assert.equal(p1.status, 201);
    await processPayout(p1.body.data.payout.id, { action: "mark_paid" });

    await status(id, USERS.performer, "completed");

    // Без 70% підтвердити не можна
    const early = await confirm(id, { accepted: true });
    assert.equal(early.status, 409);

    // Доплата 70% у статусі completed дозволена
    const pay2 = await customerPays(id, 2);
    assert.equal(pay2.status, 200, JSON.stringify(pay2.body));
    const ok = await confirm(id, { accepted: true });
    assert.equal(ok.status, 200);

    const finalTxs = await transactions(USERS.performer);
    assert.equal(finalTxs.summary.withdrawnUah, 3000);
    assert.equal(finalTxs.summary.availableUah, 7000, "після підтвердження доступний залишок 70%");
    const p2 = await requestPayout(USERS.performer, 7000);
    assert.equal(p2.status, 201);
  });
});
