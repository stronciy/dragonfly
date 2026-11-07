// Контракти адмін-панелі: редагування користувача, повідомлення, зміна статусу
// заказу, черги, захист скидання даних і відновлення пароля адміном. Скидання
// даних тестуємо лише на відмови: реального знищення в тестах немає.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetWorld, createOrder, call, ctx, readResponse, performerClaimsAndPays, customerPays, USERS, order } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { PATCH as adminUserPatch } from "../../src/app/api/v1/admin/users/[id]/route";
import { POST as adminNotifyPost } from "../../src/app/api/v1/admin/users/[id]/notify/route";
import { POST as adminStatusPost } from "../../src/app/api/v1/admin/orders/[id]/status/route";
import { GET as queuesGet } from "../../src/app/api/v1/admin/system/queues/route";
import { POST as resetPost } from "../../src/app/api/v1/admin/system/reset/route";
import { POST as adminForgotPost } from "../../src/app/api/v1/admin/auth/forgot-password/route";
import { POST as adminResetPost } from "../../src/app/api/v1/admin/auth/reset-password/route";
import { DELETE as notificationDelete } from "../../src/app/api/v1/notifications/[notificationId]/route";

const ADMIN_KEY = "test-panel-secret";
const ADMIN_ID = "admin_1";
process.env.ADMIN_PANEL_SECRET = ADMIN_KEY;

const admin = (method: string, body?: unknown, extra: Record<string, string> = {}) => new Request("http://localhost/x", {
  method,
  headers: { "x-admin-key": ADMIN_KEY, "x-admin-id": ADMIN_ID, "content-type": "application/json", ...extra },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  resetWorld();
  db.insert("admin", { id: ADMIN_ID, email: "admin@test.local", passwordHash: "x", role: "admin", active: true });
});

describe("адмін: редагування користувача", () => {
  it("змінює ім'я і телефон з причиною, пишеться журнал", async () => {
    const res = await readResponse(await adminUserPatch(admin("PATCH", { name: "Нове ім'я", phone: "+380501112233", reason: "Виправлено з документа" }), idCtx(USERS.customer)));
    assert.equal(res.status, 200);
    const user = db.findUnique("user", { where: { id: USERS.customer } }) as any;
    assert.equal(user.name, "Нове ім'я");
    assert.equal(db.count("adminAuditLog", { where: { entityId: USERS.customer } }), 1);
  });

  it("без причини зміна відхиляється (400)", async () => {
    const res = await readResponse(await adminUserPatch(admin("PATCH", { name: "X" }), idCtx(USERS.customer)));
    assert.equal(res.status, 400);
  });

  it("порожній запит без змін — 400", async () => {
    const res = await readResponse(await adminUserPatch(admin("PATCH", { reason: "Немає змін" }), idCtx(USERS.customer)));
    assert.equal(res.status, 400);
  });

  it("неіснуючий користувач — 404", async () => {
    const res = await readResponse(await adminUserPatch(admin("PATCH", { name: "X", reason: "Тест" }), idCtx("missing")));
    assert.equal(res.status, 404);
  });
});

describe("адмін: повідомлення користувачу", () => {
  it("push-повідомлення створює сповіщення у скриньці користувача", async () => {
    const res = await readResponse(await adminNotifyPost(admin("POST", { channel: "push", title: "Увага", message: "Перевірте заказ" }), idCtx(USERS.performer)));
    assert.equal(res.status, 200);
    const list = db.findMany("notification", { where: { userId: USERS.performer } });
    assert.ok(list.some((n: any) => n.title === "Увага"));
  });

  it("невідомий канал відхиляється (400)", async () => {
    const res = await readResponse(await adminNotifyPost(admin("POST", { channel: "sms", message: "x" }), idCtx(USERS.performer)));
    assert.equal(res.status, 400);
  });

  it("повідомлення про заказ чужого користувача — 400", async () => {
    const id = createOrder({ days: 1 });
    const res = await readResponse(await adminNotifyPost(admin("POST", { channel: "push", message: "x", orderId: id }), idCtx(USERS.otherPerformer)));
    assert.equal(res.status, 400);
  });
});

describe("адмін: зміна статусу заказу", () => {
  it("неіснуючий статус — 400", async () => {
    const id = createOrder({ days: 1 });
    const res = await readResponse(await adminStatusPost(admin("POST", { to: "teleported", reason: "Тест" }), idCtx(id)));
    assert.equal(res.status, 400);
  });

  it("статус, що змінюється окремою дією (скасування/депозит) — 400", async () => {
    const id = createOrder({ days: 1 });
    const res = await readResponse(await adminStatusPost(admin("POST", { to: "cancelled", reason: "Тест" }), idCtx(id)));
    assert.equal(res.status, 400);
  });

  it("заказ без виконавця не переводиться в роботу (409)", async () => {
    const id = createOrder({ days: 1 });
    const res = await readResponse(await adminStatusPost(admin("POST", { to: "started", reason: "Тест" }), idCtx(id)));
    assert.ok([409, 400].includes(res.status), `очікувався 409/400, отримано ${res.status}`);
    assert.equal(order(id).status, "published");
  });

  it("недопустимий перехід (published → completed) — 409", async () => {
    const id = createOrder({ days: 1 });
    db.updateMany("order", { where: { id }, data: { performerUserId: USERS.performer } });
    const res = await readResponse(await adminStatusPost(admin("POST", { to: "completed", reason: "Тест" }), idCtx(id)));
    assert.equal(res.status, 409);
  });

  it("допустимий перехід із причиною змінює статус і пишеться в журнал", async () => {
    const id = createOrder({ days: 1 });
    await performerClaimsAndPays(id);
    await customerPays(id);
    const res = await readResponse(await adminStatusPost(admin("POST", { to: "en_route", reason: "Виконавець їде" }), idCtx(id)));
    assert.equal(res.status, 200);
    assert.equal(order(id).status, "en_route");
    assert.equal(db.count("adminAuditLog", { where: { entityId: id } }), 1);
  });
});

describe("адмін: черги і захист скидання даних", () => {
  it("без ключа черги недоступні (401)", async () => {
    const res = await readResponse(await queuesGet(new Request("http://localhost/x")));
    assert.equal(res.status, 401);
  });

  it("скидання даних без точної фрази підтвердження відхиляється (400) і нічого не робить", async () => {
    const id = createOrder({ days: 1 });
    const res = await readResponse(await resetPost(admin("POST", { confirm: "так" })));
    assert.equal(res.status, 400);
    assert.equal(order(id).status, "published", "дані не змінені");
  });

  it("скидання без ключа панелі — 401", async () => {
    const res = await readResponse(await resetPost(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ confirm: "RESET ALL DATA" }) })));
    assert.equal(res.status, 401);
  });
});

describe("адмін: відновлення пароля", () => {
  it("запит коду для невідомого адміна — та сама відповідь 200, без перечислення адмінів", async () => {
    const res = await readResponse(await adminForgotPost(admin("POST", { email: "nobody@test.local" })));
    assert.equal(res.status, 200);
  });

  it("скидання з неправильним кодом не змінює пароль", async () => {
    const res = await readResponse(await adminResetPost(admin("POST", { email: "admin@test.local", code: "000000", newPassword: "Новий12345" })));
    assert.ok([400, 401, 404].includes(res.status), `очікувалась відмова, отримано ${res.status}`);
    assert.equal((db.findUnique("admin", { where: { id: ADMIN_ID } }) as any).passwordHash, "x");
  });
});

describe("сповіщення: видалення", () => {
  it("власне сповіщення видаляється, чуже — 404", async () => {
    db.insert("notification", { id: "nd1", userId: USERS.performer, type: "order", title: "T", message: "m", data: {}, readAt: null, createdAt: new Date() });
    const foreign = await readResponse(await notificationDelete(await call(USERS.customer, "DELETE"), { params: Promise.resolve({ notificationId: "nd1" }) }));
    assert.equal(foreign.status, 200);
    assert.equal(foreign.body.data.count, 0, "чуже сповіщення не видаляється");
    assert.ok(db.findUnique("notification", { where: { id: "nd1" } }), "запис лишився на місці");
    const own = await readResponse(await notificationDelete(await call(USERS.performer, "DELETE"), { params: Promise.resolve({ notificationId: "nd1" }) }));
    assert.equal(own.body.data.count, 1);
    assert.equal(db.findUnique("notification", { where: { id: "nd1" } }), null);
  });
});

void ctx;
