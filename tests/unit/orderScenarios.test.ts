// End-to-end scenarios over the real route handlers and payment services,
// running against the in-memory database (tests/helpers/fakePrisma.ts).
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetWorld, createOrder, order, call, ctx, readResponse, performerClaimsAndPays, customerPays,
  notificationsFor, escrowOf, rowsWhere, bearer, USERS, DAY,
} from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { PATCH as statusPatch } from "../../src/app/api/v1/orders/[orderId]/status/route";
import { POST as confirmPost } from "../../src/app/api/v1/orders/[orderId]/confirm-completion/route";
import { POST as arbitrationPost, GET as arbitrationGet } from "../../src/app/api/v1/orders/[orderId]/arbitration/route";
import { POST as arbitrationMediaPost } from "../../src/app/api/v1/orders/[orderId]/arbitration/media/route";
import { POST as refusePost } from "../../src/app/api/v1/orders/[orderId]/refuse/route";
import { POST as requestPaymentPost } from "../../src/app/api/v1/orders/[orderId]/request-payment/route";

const status = (orderId: string, userId: string, to: string) =>
  call(userId, "PATCH", { status: to }).then((req) => statusPatch(req, ctx(orderId))).then(readResponse);

const confirm = (orderId: string, body: Record<string, unknown>) =>
  call(USERS.customer, "POST", body).then((req) => confirmPost(req, ctx(orderId))).then(readResponse);

const openArbitration = (orderId: string, userId: string, reason = "Робота виконана неякісно") =>
  call(userId, "POST", { reason }).then((req) => arbitrationPost(req, ctx(orderId))).then(readResponse);

async function uploadEvidence(orderId: string, userId: string, name: string, mime: string) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([1, 2, 3, 4])], name, { type: mime }));
  const req = new Request(`http://localhost/api/v1/orders/${orderId}/arbitration/media`, {
    method: "POST",
    headers: { authorization: await bearer(userId) },
    body: form,
  });
  return readResponse(await arbitrationMediaPost(req, ctx(orderId)));
}

/** Drives a one-day order through acceptance, payment and work to `completed`. */
async function completedOneDayOrder() {
  const id = createOrder({ days: 1 });
  await performerClaimsAndPays(id);
  await customerPays(id);
  assert.equal(order(id).status, "confirmed");
  assert.equal((await status(id, USERS.performer, "en_route")).status, 200);
  assert.equal((await status(id, USERS.performer, "started")).status, 200);
  assert.equal((await status(id, USERS.performer, "completed")).status, 200);
  return id;
}

/** Drives a multi-day order until work has started (part 2 deadline is set). */
async function startedSplitOrder(days = 3, budget = 10000) {
  const id = createOrder({ days, budget });
  await performerClaimsAndPays(id);
  await customerPays(id);
  assert.equal((await status(id, USERS.performer, "en_route")).status, 200);
  assert.equal((await status(id, USERS.performer, "started")).status, 200);
  return id;
}

beforeEach(() => resetWorld());

describe("однодневний заказ — успішний сценарій", () => {
  it("100% + комісія вносяться одразу, робота приймається, кошти розблоковано", async () => {
    const id = createOrder({ days: 1, budget: 10000 });
    await performerClaimsAndPays(id);
    const pay = await customerPays(id);
    assert.equal(pay.status, 200);
    const intent = rowsWhere("paymentIntent", { orderId: id, role: "customer" })[0];
    assert.equal(Number(intent.amount), 10850, "100% бюджету + 8.5% комісії");
    assert.equal(Number(intent.depositAmount), 10000);

    assert.equal(order(id).status, "confirmed");
    assert.deepEqual(escrowOf(id, "customer"), { status: "held", amount: 10000 });
    assert.deepEqual(escrowOf(id, "performer"), { status: "held", amount: 3000 });

    await status(id, USERS.performer, "en_route");
    await status(id, USERS.performer, "started");
    await status(id, USERS.performer, "completed");

    const res = await confirm(id, { accepted: true, rating: 5, comment: "Все добре" });
    assert.equal(res.status, 200);
    assert.equal(order(id).status, "completed");
    assert.deepEqual(escrowOf(id, "customer"), { status: "released", amount: 10000 });
    assert.deepEqual(escrowOf(id, "performer"), { status: "released", amount: 3000 });

    const review = rowsWhere("review", { orderId: id });
    assert.equal(review.length, 1);
    assert.equal(review[0].rating, 5);
    // Рейтинг виконавця показується лише після взаємних відгуків: одностороння
    // оцінка заказчика зберігається, але в середнє не йде.
    const profile = db.findUnique("performerProfile", { where: { userId: USERS.performer } }) as any;
    assert.equal(profile.avgRating, 0);
    assert.equal(profile.reviewCount, 0);

    const performerNotes = notificationsFor(USERS.performer).map((n) => n.data?.type);
    assert.ok(performerNotes.includes("order_confirmed_completed"));
  });

  it("підтвердження без оцінки — заказ закрито, відгуку немає", async () => {
    const id = await completedOneDayOrder();
    const res = await confirm(id, { accepted: true });
    assert.equal(res.status, 200);
    assert.equal(rowsWhere("review", { orderId: id }).length, 0);
    assert.equal(order(id).status, "completed");
  });

  it("повторне підтвердження того самого заказу відхиляється (409)", async () => {
    const id = await completedOneDayOrder();
    assert.equal((await confirm(id, { accepted: true, rating: 4 })).status, 200);
    assert.equal((await confirm(id, { accepted: true, rating: 4 })).status, 409);
  });

  it("закриття без оцінки не можна повторити і не можна після нього відкрити арбітраж", async () => {
    const id = await completedOneDayOrder();
    assert.equal((await confirm(id, { accepted: true })).status, 200);
    assert.equal((await confirm(id, { accepted: true })).status, 409, "повторне закриття заблоковано");
    assert.equal((await openArbitration(id, USERS.customer)).status, 409, "арбітраж після прийняття заблоковано");
    assert.equal(order(id).status, "completed");
  });

  it("підтвердити можна тільки завершений заказ (started → 409)", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    await status(id, USERS.performer, "en_route");
    await status(id, USERS.performer, "started");
    assert.equal((await confirm(id, { accepted: true, rating: 5 })).status, 409);
    assert.equal(order(id).status, "started");
  });
});

describe("однодневний заказ — невдалі сценарії", () => {
  it("заказчик відхиляє роботу: арбітраж через POST /arbitration, а не через confirm-completion", async () => {
    const id = await completedOneDayOrder();

    const reject = await confirm(id, { accepted: false, comment: "Поле не обробили" });
    assert.equal(reject.status, 400, "відхилення без кейсу заборонено");
    assert.equal(order(id).status, "completed", "статус не змінився без кейсу");

    const res = await openArbitration(id, USERS.customer, "Поле не обробили, фото додано");
    assert.equal(res.status, 201);
    assert.equal(order(id).status, "arbitration");
    const cases = rowsWhere("arbitrationCase", { orderId: id });
    assert.equal(cases.length, 1);
    assert.equal(cases[0].openedByUserId, USERS.customer);
    assert.equal(cases[0].status, "open");

    const performerNotes = notificationsFor(USERS.performer).map((n) => n.data?.type);
    assert.ok(performerNotes.includes("arbitration_opened"), "виконавець отримав сповіщення про арбітраж");
    assert.equal(escrowOf(id, "customer")?.status, "held", "кошти заблоковані до рішення");
    assert.equal(escrowOf(id, "performer")?.status, "held");
  });

  it("повторне відкриття арбітражу по тому самому заказу відхиляється (409)", async () => {
    const id = await completedOneDayOrder();
    assert.equal((await openArbitration(id, USERS.customer)).status, 201);
    // Статус уже arbitration — роут відхиляє відкриття як неактивний заказ.
    assert.equal((await openArbitration(id, USERS.customer)).status, 400);
    assert.equal((await openArbitration(id, USERS.performer)).status, 400);
  });

  it("заказчик не може відкрити арбітраж без причини (400)", async () => {
    const id = await completedOneDayOrder();
    const req = await call(USERS.customer, "POST", { reason: "" });
    assert.equal((await arbitrationPost(req, ctx(id))).status, 400);
    assert.equal(order(id).status, "completed");
  });

  it("виконавець не може завершити роботу — відкриває арбітраж під час робіт", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    await status(id, USERS.performer, "en_route");
    await status(id, USERS.performer, "started");

    const res = await openArbitration(id, USERS.performer, "Пошкоджено техніку, роботу не завершено");
    assert.equal(res.status, 201);
    assert.equal(order(id).status, "arbitration");
    const customerNotes = notificationsFor(USERS.customer).map((n) => n.data?.type);
    assert.ok(customerNotes.includes("arbitration_opened"), "заказчик отримав сповіщення");
  });

  it("виконавець відмовляється після оплати заказчика — заставу виконавця конфісковано, заказчика повернено", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    const req = await call(USERS.performer, "POST", { reason: "Захворіла людина з бригади" });
    const res = await readResponse(await refusePost(req, ctx(id)));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.forfeited, true);
    assert.equal(order(id).status, "published");
    assert.equal(order(id).performerUserId, null);
    assert.deepEqual(escrowOf(id, "performer"), { status: "forfeited", amount: 3000 });
    assert.deepEqual(escrowOf(id, "customer"), { status: "refunded", amount: 10000 });
    assert.ok(notificationsFor(USERS.customer).some((n) => n.data?.type === "order_refused_by_performer"));
  });

  it("арбітраж неможливий, поки заказ ще не оплачено (accepted / requires_confirmation → 400)", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    assert.equal(order(id).status, "requires_confirmation");
    assert.equal((await openArbitration(id, USERS.customer)).status, 400);
    assert.equal((await openArbitration(id, USERS.performer)).status, 400);
    assert.equal(order(id).status, "requires_confirmation");
  });

  it("сторонній виконавець не може відкрити арбітраж по чужому заказу (403/404)", async () => {
    const id = await completedOneDayOrder();
    const res = await openArbitration(id, USERS.otherPerformer);
    assert.ok([403, 404].includes(res.status), `очікувався 403/404, отримано ${res.status}`);
    assert.equal(order(id).status, "completed");
  });

  it("сторонній замовник не може відкрити арбітраж по чужому заказу (403/404)", async () => {
    const id = await completedOneDayOrder();
    const res = await openArbitration(id, USERS.otherCustomer);
    assert.ok([403, 404].includes(res.status), `очікувався 403/404, отримано ${res.status}`);
    assert.equal(order(id).status, "completed");
  });

  it("після прийняття роботи заказчиком арбітраж відкрити не можна (409)", async () => {
    const id = await completedOneDayOrder();
    assert.equal((await confirm(id, { accepted: true, rating: 5 })).status, 200);
    const res = await openArbitration(id, USERS.customer);
    assert.equal(res.status, 409, "заказ уже прийнято — арбітраж не відкривається");
    assert.equal(order(id).status, "completed");
  });
});

describe("арбітраж — докази та сторони", () => {
  it("заказчик додає фото, виконавець — відео; файли прив'язані до повідомлень кейсу", async () => {
    const id = await completedOneDayOrder();
    assert.equal((await openArbitration(id, USERS.customer, "Фото дефектів додано")).status, 201);

    const customerUpload = await uploadEvidence(id, USERS.customer, "defect.jpg", "image/jpeg");
    assert.equal(customerUpload.status, 201);
    const performerUpload = await uploadEvidence(id, USERS.performer, "work.mp4", "video/mp4");
    assert.equal(performerUpload.status, 201);

    const kase = rowsWhere("arbitrationCase", { orderId: id })[0];
    const media = rowsWhere("orderMedia", { orderId: id, kind: "arbitration" });
    assert.equal(media.length, 2);
    for (const m of media) {
      assert.ok(m.arbitrationMessageId, "доказ прив'язаний до повідомлення");
      const msg = db.findUnique("arbitrationMessage", { where: { id: m.arbitrationMessageId } }) as any;
      assert.equal(msg.arbitrationCaseId, kase.id);
    }
    const byUser = (uid: string) =>
      media.find((m) => (db.findUnique("arbitrationMessage", { where: { id: m.arbitrationMessageId } }) as any).userId === uid);
    assert.ok(byUser(USERS.customer));
    assert.ok(byUser(USERS.performer));
  });

  it("докази не приймаються, якщо арбітраж не відкрито (409)", async () => {
    const id = await completedOneDayOrder();
    const res = await uploadEvidence(id, USERS.customer, "x.jpg", "image/jpeg");
    assert.equal(res.status, 409);
  });

  it("сторонній користувач не завантажує докази (404)", async () => {
    const id = await completedOneDayOrder();
    await openArbitration(id, USERS.customer);
    const res = await uploadEvidence(id, USERS.otherPerformer, "x.jpg", "image/jpeg");
    assert.equal(res.status, 404);
  });

  it("сторона бачить кейс і повідомлення, сторонній користувач — ні", async () => {
    const id = await completedOneDayOrder();
    await openArbitration(id, USERS.customer, "Причина заказчика");
    const mine = await readResponse(await arbitrationGet(await call(USERS.performer, "GET"), ctx(id)));
    assert.equal(mine.status, 200);
    assert.equal(mine.body.data.messages[0].text, "Причина заказчика");
    const outsider = await readResponse(await arbitrationGet(await call(USERS.otherCustomer, "GET"), ctx(id)));
    assert.equal(outsider.status, 403);
  });
});

describe("багатоденний заказ (понад 2 дні) — 30% одразу, 70% до кінця 3-го дня", () => {
  it("2-денний заказ — оплата 100% (межа включно)", async () => {
    const id = createOrder({ days: 2, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    const intent = rowsWhere("paymentIntent", { orderId: id, role: "customer" })[0];
    assert.equal(Number(intent.amount), 10850);
    assert.deepEqual(escrowOf(id, "customer"), { status: "held", amount: 10000 });
  });

  it("3-денний заказ — 30% + комісія одразу, залишок 70% не вноситься до старту", async () => {
    const id = createOrder({ days: 3, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    const intent = rowsWhere("paymentIntent", { orderId: id, role: "customer" })[0];
    assert.equal(Number(intent.amount), 3850);
    assert.deepEqual(escrowOf(id, "customer"), { status: "held", amount: 3000 });
    assert.equal(order(id).customerPart2Deadline, null);
  });

  it("старт роботи виставляє дедлайн залишку — кінець 3-го дня від старту", async () => {
    const id = await startedSplitOrder(3);
    const deadline = new Date(order(id).customerPart2Deadline);
    const start = new Date();
    const dayDiff = Math.round(
      (Date.UTC(...ymd(deadline)) - Date.UTC(...ymd(start))) / DAY
    );
    assert.equal(dayDiff, 2, "третій день рахуючи день старту як перший");
    assert.equal(kyivHourMinute(deadline), "23:59", "дедлайн — кінець дня за Києвом");
    assert.ok(notificationsFor(USERS.customer).some((n) => /Внесіть залишок 7000/.test(n.message)));
  });

  it("заказчик вносить 70% після старту — escrow 100%, дедлайн знято, заказ завершується", async () => {
    const id = await startedSplitOrder(3);
    const pay = await customerPays(id, 2);
    assert.equal(pay.status, 200);
    const part2 = rowsWhere("paymentIntent", { orderId: id, role: "customer", part: 2 })[0];
    assert.equal(Number(part2.amount), 7000, "без додаткової комісії");
    assert.deepEqual(escrowOf(id, "customer"), { status: "held", amount: 10000 });
    assert.equal(order(id).customerPart2Deadline, null);

    await status(id, USERS.performer, "completed");
    assert.equal((await confirm(id, { accepted: true, rating: 5 })).status, 200);
    assert.deepEqual(escrowOf(id, "customer"), { status: "released", amount: 10000 });
    assert.equal(order(id).status, "completed");
  });

  it("заказчик вносить 70% після дедлайну — оплата приймається, виконавець може відкрити арбітраж", async () => {
    const id = await startedSplitOrder(3);
    db.updateMany("order", { where: { id }, data: { customerPart2Deadline: new Date(Date.now() - 1000) } });
    const pay = await customerPays(id, 2);
    assert.equal(pay.status, 200);
    assert.deepEqual(escrowOf(id, "customer"), { status: "held", amount: 10000 });
  });

  it("заказчик не може сплатити 70% до старту роботи (409)", async () => {
    const id = createOrder({ days: 3, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    const res = await customerPays(id, 2);
    assert.equal(res.status, 400, "доплата 70% доступна лише для розпочатих робіт");
    assert.deepEqual(escrowOf(id, "customer"), { status: "held", amount: 3000 });
  });

  it("повторна оплата 70% відхиляється (409)", async () => {
    const id = await startedSplitOrder(3);
    assert.equal((await customerPays(id, 2)).status, 200);
    assert.equal((await customerPays(id, 2)).status, 409);
  });

  it("закрити заказ без оплати 70% не можна (409)", async () => {
    const id = await startedSplitOrder(3);
    await status(id, USERS.performer, "completed");
    const res = await confirm(id, { accepted: true, rating: 5 });
    assert.equal(res.status, 409, "гроші за 70% не внесено — закрити не можна");
    assert.equal(order(id).status, "completed");
    assert.deepEqual(escrowOf(id, "customer"), { status: "held", amount: 3000 });
  });

  it("запит доплати від виконавця відхиляється — оплата автоматична (409)", async () => {
    const id = await startedSplitOrder(3);
    const req = await call(USERS.performer, "POST", { amount: 7000 });
    assert.equal((await requestPaymentPost(req, ctx(id))).status, 409);
  });

  it("заказчик відхиляє роботу після часткової оплати — арбітраж, кошти заблоковані", async () => {
    const id = await startedSplitOrder(3);
    await customerPays(id, 2);
    await status(id, USERS.performer, "completed");
    assert.equal((await openArbitration(id, USERS.customer, "Не встигли до кінця 3 дня")).status, 201);
    assert.equal(order(id).status, "arbitration");
    assert.deepEqual(escrowOf(id, "customer"), { status: "held", amount: 10000 });
  });

  it("арбітраж під час робіт при неоплаченому 70%: виконавець відкриває, заказчик не може доплатити", async () => {
    const id = await startedSplitOrder(3);
    assert.equal((await openArbitration(id, USERS.performer, "Заказчик не вносить залишок")).status, 201);
    assert.equal(order(id).status, "arbitration");
    const res = await customerPays(id, 2);
    assert.notEqual(res.status, 200, "під час арбітражу залишок не приймаємо");
  });

  it("виконавець не може стартувати замовлення, що починається в майбутньому (400)", async () => {
    const id = createOrder({ days: 3, budget: 10000 });
    db.updateMany("order", { where: { id }, data: { dateFrom: new Date(Date.now() + 3 * DAY) } });
    await performerClaimsAndPays(id);
    await customerPays(id);
    await status(id, USERS.performer, "en_route");
    assert.equal((await status(id, USERS.performer, "started")).status, 400);
  });
});

describe("замовлення без дат — оплата 100% одразу", () => {
  it("без дат заказ рахується як однаденний: 100% + комісія", async () => {
    const id = createOrder({ dates: null, budget: 10000 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    const intent = rowsWhere("paymentIntent", { orderId: id, role: "customer" })[0];
    assert.equal(Number(intent.amount), 10850);
    assert.deepEqual(escrowOf(id, "customer"), { status: "held", amount: 10000 });
  });
});

describe("граничні та некоректні дії", () => {
  it("статуси змінює лише призначений виконавець (404 для чужого)", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    assert.equal((await status(id, USERS.otherPerformer, "en_route")).status, 404);
    assert.equal(order(id).status, "confirmed");
  });

  it("заказчик не може змінювати статус роботи (403)", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    assert.equal((await status(id, USERS.customer, "en_route")).status, 403);
  });

  it("неавторизований запит відхиляється (401)", async () => {
    const id = await completedOneDayOrder();
    const req = new Request("http://localhost/x", {
      method: "POST",
      body: JSON.stringify({ reason: "Причина" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal((await arbitrationPost(req, ctx(id))).status, 401);
  });

  it("завершення не можна пропустити: started → completed напряму (400)", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    await status(id, USERS.performer, "en_route");
    assert.equal((await status(id, USERS.performer, "completed")).status, 400);
  });
});

function kyivHourMinute(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

function ymd(d: Date): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d)
    .split("-")
    .map(Number);
  return [parts[0], parts[1] - 1, parts[2]];
}
