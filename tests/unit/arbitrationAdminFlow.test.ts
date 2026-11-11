// Арбітраж через адміністратора: відкриття кейсу, листування сторін і адміна,
// рішення (переможець + штраф або без) і закриття заказу через арбітраж.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, customerPays,
  USERS, order, escrowOf, notificationsFor, rowsWhere,
} from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { PATCH as statusPatch } from "../../src/app/api/v1/orders/[orderId]/status/route";
import { GET as arbGet, POST as openArb, PATCH as arbMessage } from "../../src/app/api/v1/orders/[orderId]/arbitration/route";
import { POST as mediaPost } from "../../src/app/api/v1/orders/[orderId]/arbitration/media/route";
import { GET as adminListGet } from "../../src/app/api/v1/admin/arbitration/route";
import { GET as adminCaseGet } from "../../src/app/api/v1/admin/arbitration/[caseId]/route";
import { POST as adminMessagePost } from "../../src/app/api/v1/admin/arbitration/[caseId]/messages/route";
import { POST as adminRulingPost } from "../../src/app/api/v1/admin/arbitration/[caseId]/ruling/route";

const ADMIN_KEY = "test-panel-secret";
const ADMIN_ID = "admin_1";
process.env.ADMIN_PANEL_SECRET = ADMIN_KEY;

const adminHeaders = { "x-admin-key": ADMIN_KEY, "x-admin-id": ADMIN_ID };

function seedAdmin() {
  db.insert("admin", { id: ADMIN_ID, email: "admin@test.local", passwordHash: "x", role: "admin", active: true });
}

function adminReq(method: "GET" | "POST", body?: unknown, headers: Record<string, string> = adminHeaders): Request {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  return new Request("http://localhost/api/v1/admin/test", init);
}

const caseCtx = (caseId: string) => ({ params: Promise.resolve({ caseId }) });

/** Замовлення у статусі completed і відкритий арбітраж заказчиком. */
async function openedArbitration(opts: { days?: number; budget?: number } = {}) {
  const id = createOrder({ days: opts.days ?? 1, budget: opts.budget ?? 10000 });
  await performerClaimsAndPays(id);
  await customerPays(id);
  await statusPatch(await call(USERS.performer, "PATCH", { status: "en_route" }), ctx(id));
  await statusPatch(await call(USERS.performer, "PATCH", { status: "started" }), ctx(id));
  await statusPatch(await call(USERS.performer, "PATCH", { status: "completed" }), ctx(id));
  const res = await readResponse(
    await openArb(await call(USERS.customer, "POST", { reason: "Робота виконана не в повному обсязі" }), ctx(id))
  );
  assert.equal(res.status, 201, "відкриття арбітражу має пройти");
  const caseId = res.body.data.case.id as string;
  return { id, caseId };
}

function casesFor(orderId: string) {
  return rowsWhere("arbitrationCase", { orderId });
}

beforeEach(() => {
  resetWorld();
  seedAdmin();
});

describe("відкриття арбітражу", () => {
  it("створює кейс і перше повідомлення з правильним кейсом, заказ переходить в арбітраж", async () => {
    const { id, caseId } = await openedArbitration();
    assert.equal(order(id).status, "arbitration");
    const cases = casesFor(id);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].id, caseId);
    assert.equal(cases[0].status, "open");
    assert.equal(cases[0].openedByUserId, USERS.customer);

    const messages = rowsWhere("arbitrationMessage", { arbitrationCaseId: caseId });
    assert.equal(messages.length, 1, "перше повідомлення прив'язане до кейсу, а не до порожнього id");
    assert.equal(messages[0].text, "Робота виконана не в повному обсязі");
  });

  it("друга сторона отримує сповіщення про відкритий арбітраж", async () => {
    const { id } = await openedArbitration();
    const notes = notificationsFor(USERS.performer).filter((n) => n.type === "arbitration");
    assert.ok(notes.some((n) => n.data?.orderId === id), "виконавець бачить сповіщення про арбітраж");
  });

  it("повторне відкриття при відкритому арбітражі відхиляється, кейс один", async () => {
    const { id } = await openedArbitration();
    const res = await readResponse(await openArb(await call(USERS.performer, "POST", { reason: "Ще раз" }), ctx(id)));
    assert.equal(res.status, 400, "заказ вже в арбітражі — статус не активний для відкриття");
    assert.equal(casesFor(id).length, 1);
  });

  it("сторонній користувач не може відкрити арбітраж (403)", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    await statusPatch(await call(USERS.performer, "PATCH", { status: "en_route" }), ctx(id));
    await statusPatch(await call(USERS.performer, "PATCH", { status: "started" }), ctx(id));
    const res = await readResponse(await openArb(await call(USERS.otherCustomer, "POST", { reason: "x" }), ctx(id)));
    assert.equal(res.status, 403);
    assert.equal(order(id).status, "started");
  });

  it("арбітраж не відкривається для замовлення без активної роботи (400)", async () => {
    const id = createOrder({ days: 1 });
    const res = await readResponse(await openArb(await call(USERS.customer, "POST", { reason: "x" }), ctx(id)));
    assert.equal(res.status, 400);
  });
});

describe("листування сторін", () => {
  it("сторона пише текстом — повідомлення зберігається, друга сторона отримує сповіщення", async () => {
    const { id, caseId } = await openedArbitration();
    const res = await readResponse(await arbMessage(await call(USERS.performer, "PATCH", { reason: "Я все виконав" }), ctx(id)));
    assert.equal(res.status, 201);
    const messages = rowsWhere("arbitrationMessage", { arbitrationCaseId: caseId });
    assert.equal(messages.length, 2);
    assert.equal(messages[1].text, "Я все виконав");
    assert.equal(messages[1].userId, USERS.performer);
    const notes = notificationsFor(USERS.customer).filter((n) => n.type === "arbitration" && n.data?.type === "arbitration_message");
    assert.equal(notes.length, 1);
  });

  it("сторона прикладає файл до повідомлення — медіа прив'язане до повідомлення", async () => {
    const { id, caseId } = await openedArbitration();
    const form = new FormData();
    form.append("text", "Фото поля");
    form.append("file", new File([new Uint8Array([1, 2, 3])], "field.jpg", { type: "image/jpeg" }));
    const req = new Request("http://localhost/api/v1/test", {
      method: "PATCH",
      headers: { authorization: (await call(USERS.performer, "GET")).headers.get("authorization") ?? "" },
      body: form,
    });
    const res = await readResponse(await arbMessage(req, ctx(id)));
    assert.equal(res.status, 201);
    const media = rowsWhere("orderMedia", { kind: "arbitration" });
    assert.equal(media.length, 1);
    assert.equal(media[0].name, "field.jpg");
    const msg = rowsWhere("arbitrationMessage", { arbitrationCaseId: caseId }).find((m) => m.text === "Фото поля");
    assert.ok(msg, "повідомлення з файлом збережене");
    assert.equal(media[0].arbitrationMessageId, msg!.id);
  });

  it("порожній текст відхиляється (400)", async () => {
    const { id } = await openedArbitration();
    const res = await readResponse(await arbMessage(await call(USERS.customer, "PATCH", { reason: "   " }), ctx(id)));
    assert.equal(res.status, 400);
  });

  it("сторонній не пише в арбітраж (404)", async () => {
    const { id } = await openedArbitration();
    const res = await readResponse(await arbMessage(await call(USERS.otherPerformer, "PATCH", { reason: "x" }), ctx(id)));
    assert.equal(res.status, 404);
  });

  it("сторона бачить історію кейсу разом з відповідями адміна", async () => {
    const { id, caseId } = await openedArbitration();
    await readResponse(await adminMessagePost(adminReq("POST", { text: "Надішліть акт" }), caseCtx(caseId)));
    const view = await readResponse(await arbGet(await call(USERS.customer, "GET"), ctx(id)));
    assert.equal(view.status, 200);
    const texts = view.body.data.messages.map((m: any) => m.text);
    assert.deepEqual(texts, ["Робота виконана не в повному обсязі", "Надішліть акт"]);
  });
});

describe("повідомлення адміністратора", () => {
  it("адмін пише в кейс — кейс стає «admin_assigned», обидві сторони отримують сповіщення", async () => {
    const { id, caseId } = await openedArbitration();
    const res = await readResponse(await adminMessagePost(adminReq("POST", { text: "Розглядаю" }), caseCtx(caseId)));
    assert.equal(res.status, 201);
    const kase = casesFor(id)[0];
    assert.equal(kase.status, "admin_assigned");
    assert.equal(kase.assigneeAdminId, ADMIN_ID);
    const msg = rowsWhere("arbitrationMessage", { arbitrationCaseId: caseId }).find((m) => m.text === "Розглядаю");
    assert.equal(msg?.adminId, ADMIN_ID);
    for (const userId of [USERS.customer, USERS.performer]) {
      const notes = notificationsFor(userId).filter((n) => n.data?.type === "arbitration_admin_message");
      assert.equal(notes.length, 1, `сповіщення для ${userId}`);
    }
  });

  it("без ключа адмін-панелі — 401", async () => {
    const { caseId } = await openedArbitration();
    const res = await readResponse(
      await adminMessagePost(adminReq("POST", { text: "x" }, {}), caseCtx(caseId))
    );
    assert.equal(res.status, 401);
  });
});

describe("адмін-панель: список і карточка кейсу", () => {
  it("відкритий кейс є у списку, закритий — ні", async () => {
    const { caseId } = await openedArbitration();
    const list = await readResponse(await adminListGet(adminReq("GET")));
    assert.equal(list.status, 200);
    assert.ok(list.body.data.items.some((c: any) => c.id === caseId));
  });

  it("карточка кейсу повертає заказ, повідомлення та заставу", async () => {
    const { id, caseId } = await openedArbitration({ budget: 10000 });
    const res = await readResponse(await adminCaseGet(adminReq("GET"), caseCtx(caseId)));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.case.id, caseId);
    assert.equal(res.body.data.order.id, id);
    assert.ok(res.body.data.case.messages.length >= 1);
  });
});

describe("рішення адміністратора", () => {
  it("заказчик виграє зі штрафом: застава виконавця утримується, заказчика — повертається, заказ закрито через арбітраж", async () => {
    const { id, caseId } = await openedArbitration({ budget: 10000 });
    const res = await readResponse(
      await adminRulingPost(adminReq("POST", { winner: "customer", penalty: true, reason: "Акт не підписано" }), caseCtx(caseId))
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.data.decision, "customer_wins_penalty");

    assert.equal(order(id).status, "completed");
    assert.deepEqual(escrowOf(id, "performer"), { status: "forfeited", amount: 3000 });
    assert.deepEqual(escrowOf(id, "customer"), { status: "released", amount: 10000 });

    const kase = casesFor(id)[0];
    assert.equal(kase.status, "resolved");
    assert.ok(kase.resolvedAt);
    const ruling = rowsWhere("arbitrationRuling", { arbitrationCaseId: caseId });
    assert.equal(ruling.length, 1);
    assert.equal(ruling[0].adminId, ADMIN_ID);
    assert.equal(ruling[0].reason, "Акт не підписано");
  });

  it("виконавець виграє без штрафу: обидві застави повертаються, заказ завершено", async () => {
    const { id, caseId } = await openedArbitration({ budget: 10000 });
    const res = await readResponse(
      await adminRulingPost(adminReq("POST", { winner: "performer", penalty: false, reason: "Замовник не виконав умови" }), caseCtx(caseId))
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.data.decision, "performer_wins");
    assert.equal(order(id).status, "completed");
    assert.deepEqual(escrowOf(id, "performer"), { status: "released", amount: 3000 });
    assert.deepEqual(escrowOf(id, "customer"), { status: "released", amount: 10000 });
  });

  it("виконавець виграє зі штрафом: застава замовника утримується", async () => {
    const { id, caseId } = await openedArbitration({ budget: 10000 });
    await adminRulingPost(adminReq("POST", { winner: "performer", penalty: true, reason: "Замовник відмовився" }), caseCtx(caseId));
    assert.deepEqual(escrowOf(id, "customer"), { status: "forfeited", amount: 10000 });
    assert.deepEqual(escrowOf(id, "performer"), { status: "released", amount: 3000 });
  });

  it("обидві сторони отримують сповіщення про результат і подію закриття", async () => {
    const { caseId } = await openedArbitration();
    await adminRulingPost(adminReq("POST", { winner: "customer", penalty: false, reason: "Ок" }), caseCtx(caseId));
    for (const userId of [USERS.customer, USERS.performer]) {
      const notes = notificationsFor(userId).filter((n) => n.data?.type === "arbitration_resolved");
      assert.equal(notes.length, 1, `сповіщення про рішення для ${userId}`);
    }
  });

  it("повторне рішення по закритому кейсу — 409, стан не змінюється", async () => {
    const { id, caseId } = await openedArbitration();
    await adminRulingPost(adminReq("POST", { winner: "customer", penalty: true, reason: "Перше" }), caseCtx(caseId));
    const res = await readResponse(
      await adminRulingPost(adminReq("POST", { winner: "performer", penalty: false, reason: "Друге" }), caseCtx(caseId))
    );
    assert.equal(res.status, 409);
    assert.equal(rowsWhere("arbitrationRuling", { arbitrationCaseId: caseId }).length, 1);
    assert.deepEqual(escrowOf(id, "performer"), { status: "forfeited", amount: 3000 });
  });

  it("рішення без обґрунтування або без переможця відхиляється (400)", async () => {
    const { caseId } = await openedArbitration();
    const noReason = await readResponse(
      await adminRulingPost(adminReq("POST", { winner: "customer", penalty: false, reason: "" }), caseCtx(caseId))
    );
    assert.equal(noReason.status, 400);
    const noWinner = await readResponse(
      await adminRulingPost(adminReq("POST", { penalty: false, reason: "x" }), caseCtx(caseId))
    );
    assert.equal(noWinner.status, 400);
  });

  it("після рішення листування закрите: сторона не може писати (404, відкритого кейсу немає)", async () => {
    const { id, caseId } = await openedArbitration();
    await adminRulingPost(adminReq("POST", { winner: "customer", penalty: false, reason: "Ок" }), caseCtx(caseId));
    const res = await readResponse(await arbMessage(await call(USERS.performer, "PATCH", { reason: "Пізно" }), ctx(id)));
    assert.equal(res.status, 404);
  });

  it("адмін не може написати в закритий кейс (409)", async () => {
    const { caseId } = await openedArbitration();
    await adminRulingPost(adminReq("POST", { winner: "customer", penalty: false, reason: "Ок" }), caseCtx(caseId));
    const res = await readResponse(await adminMessagePost(adminReq("POST", { text: "Ще" }), caseCtx(caseId)));
    assert.equal(res.status, 409);
  });

  it("для багатоденного заказу без залишку 70% рішення не закриває заказ (409)", async () => {
    const { id, caseId } = await openedArbitration({ days: 3, budget: 10000 });
    const res = await readResponse(
      await adminRulingPost(adminReq("POST", { winner: "performer", penalty: false, reason: "Ок" }), caseCtx(caseId))
    );
    assert.equal(res.status, 409);
    assert.equal(order(id).status, "arbitration");
    assert.equal(casesFor(id)[0].status, "open");
  });

  it("рішення без ключа адмін-панелі — 401", async () => {
    const { id, caseId } = await openedArbitration();
    const res = await readResponse(
      await adminRulingPost(adminReq("POST", { winner: "customer", penalty: true, reason: "x" }, {}), caseCtx(caseId))
    );
    assert.equal(res.status, 401);
    assert.equal(order(id).status, "arbitration");
  });
});

describe("медіа арбітражу (окремий endpoint)", () => {
  it("сторона прикладає доказ до відкритого арбітражу", async () => {
    const { id } = await openedArbitration();
    const form = new FormData();
    form.append("file", new File([new Uint8Array([9, 9])], "act.png", { type: "image/png" }));
    const req = new Request("http://localhost/api/v1/test", {
      method: "POST",
      headers: { authorization: (await call(USERS.customer, "GET")).headers.get("authorization") ?? "" },
      body: form,
    });
    const res = await readResponse(await mediaPost(req, ctx(id)));
    assert.equal(res.status, 201);
    assert.equal(rowsWhere("orderMedia", { kind: "arbitration" }).length, 1);
  });
});
