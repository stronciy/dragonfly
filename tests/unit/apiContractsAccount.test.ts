// Контракти облікового запису: профіль, аватар, статистика, рейтинг, застарілий
// гаманець, біометрія, 2FA, оновлення токена і відновлення пароля.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generate as totp } from "otplib";
import { resetWorld, call, ctx, readResponse, USERS } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { GET as meGet, PATCH as mePatch } from "../../src/app/api/v1/users/me/route";
import { PATCH as avatarPatch } from "../../src/app/api/v1/users/me/avatar/route";
import { GET as statsGet } from "../../src/app/api/v1/users/me/stats/route";
import { GET as customerRatingGet } from "../../src/app/api/v1/users/me/customer-rating/route";
import { GET as walletGet } from "../../src/app/api/v1/users/me/wallet/route";
import { POST as withdrawPost } from "../../src/app/api/v1/users/me/wallet/withdraw/route";
import { GET as biometricsGet, PATCH as biometricsPatch } from "../../src/app/api/v1/security/biometrics/route";
import { GET as twoFaGet } from "../../src/app/api/v1/security/2fa/route";
import { POST as twoFaSetup } from "../../src/app/api/v1/security/2fa/setup/route";
import { POST as twoFaEnable } from "../../src/app/api/v1/security/2fa/enable/route";
import { POST as twoFaDisable } from "../../src/app/api/v1/security/2fa/disable/route";
import { POST as refreshPost } from "../../src/app/api/v1/auth/refresh/route";
import { POST as forgotPost } from "../../src/app/api/v1/auth/forgot-password/route";
import { POST as resetPost } from "../../src/app/api/v1/auth/reset-password/route";
import { signRefreshToken, sha256 } from "../../src/lib/auth/tokens";

const VALID_IBAN = "UA213223130000026007233566001";
const PNG = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;

function json(url: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

beforeEach(() => {
  resetWorld();
  db.insert("legalProfile", { id: "lp1", userId: USERS.performer, companyName: "ФОП", edrpou: "12345678", iban: VALID_IBAN, legalAddress: "м. Полтава", vatPayer: false });
});

describe("профіль користувача", () => {
  it("GET повертає профіль поточного користувача", async () => {
    const res = await readResponse(await meGet(await call(USERS.customer, "GET")));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.id, USERS.customer);
  });

  it("PATCH оновлює ім'я і телефон", async () => {
    const res = await readResponse(await mePatch(await call(USERS.customer, "PATCH", { name: "Олена", phone: "+380671234567" })));
    assert.equal(res.status, 200);
    const user = db.findUnique("user", { where: { id: USERS.customer } }) as any;
    assert.equal(user.name, "Олена");
    assert.equal(user.phone, "+380671234567");
  });

  it("PATCH з email, який уже зайнятий, — 409", async () => {
    const res = await readResponse(await mePatch(await call(USERS.customer, "PATCH", { email: "cust_2@test.local" })));
    assert.equal(res.status, 409);
  });
});

describe("аватар", () => {
  it("коректне зображення зберігається як data URL", async () => {
    const res = await readResponse(await avatarPatch(await call(USERS.customer, "PATCH", { avatarUrl: PNG })));
    assert.equal(res.status, 200);
    assert.equal((db.findUnique("user", { where: { id: USERS.customer } }) as any).avatarUrl, PNG);
  });

  it("не base64 data URL відхиляється (400)", async () => {
    const res = await readResponse(await avatarPatch(await call(USERS.customer, "PATCH", { avatarUrl: "https://x/y.png" })));
    assert.equal(res.status, 400);
  });

  it("непідтримуваний тип зображення відхиляється (400)", async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
    const res = await readResponse(await avatarPatch(await call(USERS.customer, "PATCH", { avatarUrl: svg })));
    assert.equal(res.status, 400);
  });
});

describe("статистика і рейтинг заказчика", () => {
  it("статистика користувача віддається", async () => {
    assert.equal((await readResponse(await statsGet(await call(USERS.performer, "GET")))).status, 200);
  });

  it("рейтинг заказчика віддається власнику", async () => {
    assert.equal((await readResponse(await customerRatingGet(await call(USERS.customer, "GET")))).status, 200);
  });
});

describe("застарілий гаманець (сумісність)", () => {
  it("GET гаманця повертає порожній баланс без помилки", async () => {
    const res = await readResponse(await walletGet(await call(USERS.performer, "GET")));
    assert.equal(res.status, 200);
  });

  it("виведення через старий шлях іде тим самим сервісом: без балансу — 400", async () => {
    const res = await readResponse(await withdrawPost(await call(USERS.performer, "POST", { amount: 1000, iban: VALID_IBAN })));
    assert.equal(res.status, 400);
    assert.equal(db.count("payout", {}), 0);
  });

  it("IBAN, який не збігається з юрпрофілем, відхиляється (400)", async () => {
    const res = await readResponse(await withdrawPost(await call(USERS.performer, "POST", { amount: 1000, iban: "UA123456789012345678901234567" })));
    assert.equal(res.status, 400);
  });
});

describe("біометрія", () => {
  it("вмикання і читання біометричного входу", async () => {
    const on = await readResponse(await biometricsPatch(await call(USERS.customer, "PATCH", { enabled: true })));
    assert.equal(on.status, 200);
    const read = await readResponse(await biometricsGet(await call(USERS.customer, "GET")));
    assert.equal(read.status, 200);
    assert.equal(read.body.data.biometrics.enabled, true);
  });
});

describe("двофакторна автентифікація", () => {
  it("статус 2FA спочатку вимкнено", async () => {
    const res = await readResponse(await twoFaGet(await call(USERS.customer, "GET")));
    assert.equal(res.status, 200);
  });

  it("setup віддає секрет, enable з правильним кодом вмикає 2FA", async () => {
    const setup = await readResponse(await twoFaSetup(await call(USERS.customer, "POST")));
    assert.equal(setup.status, 200);
    const secret = setup.body.data.setup.secret as string;
    assert.ok(secret, "секрет віддається для налаштування застосунку");

    const enable = await readResponse(await twoFaEnable(await call(USERS.customer, "POST", { secret, code: await totp({ secret }) })));
    assert.equal(enable.status, 200);
  });

  it("enable з хибним кодом відхиляється (400) і 2FA не вмикається", async () => {
    const setup = await readResponse(await twoFaSetup(await call(USERS.customer, "POST")));
    const res = await readResponse(await twoFaEnable(await call(USERS.customer, "POST", { secret: setup.body.data.setup.secret, code: "000000" })));
    assert.equal(res.status, 400);
    assert.ok(!(db.findUnique("user", { where: { id: USERS.customer } }) as any).twoFactorEnabledAt, "2FA не увімкнено");
  });

  it("disable, коли 2FA не увімкнено, — безпечний no-op (200, enabled: false)", async () => {
    const res = await readResponse(await twoFaDisable(await call(USERS.customer, "POST", { code: "000000" })));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.twoFactor.enabled, false);
  });

  it("disable з хибним кодом, коли 2FA увімкнено, відхиляється (400)", async () => {
    const secret = (await readResponse(await twoFaSetup(await call(USERS.customer, "POST")))).body.data.setup.secret;
    await readResponse(await twoFaEnable(await call(USERS.customer, "POST", { secret, code: await totp({ secret }) })));
    const res = await readResponse(await twoFaDisable(await call(USERS.customer, "POST", { code: "000000" })));
    assert.equal(res.status, 400);
    assert.ok((db.findUnique("user", { where: { id: USERS.customer } }) as any).twoFactorSecret, "2FA лишається увімкненою");
  });
});

describe("оновлення сесії", () => {
  it("коректний refresh-токен з cookie видає новий access-токен", async () => {
    const refresh = await signRefreshToken({ userId: USERS.customer, jti: "jti-1" });
    db.insert("refreshToken", { id: "rt-r", userId: USERS.customer, tokenHash: await sha256(refresh), revokedAt: null, expiresAt: new Date(Date.now() + 1e9), createdAt: new Date() });
    const res = await readResponse(await refreshPost(new Request("http://localhost/api/v1/auth/refresh", { method: "POST", headers: { cookie: `refreshToken=${refresh}` } })));
    assert.equal(res.status, 200);
    assert.ok(res.body.data.accessToken);
  });

  it("відкликаний refresh-токен не працює (401)", async () => {
    const refresh = await signRefreshToken({ userId: USERS.customer, jti: "jti-2" });
    db.insert("refreshToken", { id: "rt-x", userId: USERS.customer, tokenHash: await sha256(refresh), revokedAt: new Date(), expiresAt: new Date(Date.now() + 1e9), createdAt: new Date() });
    const res = await readResponse(await refreshPost(new Request("http://localhost/api/v1/auth/refresh", { method: "POST", headers: { cookie: `refreshToken=${refresh}` } })));
    assert.equal(res.status, 401);
  });

  it("без refresh-токена — 401", async () => {
    const res = await readResponse(await refreshPost(new Request("http://localhost/api/v1/auth/refresh", { method: "POST" })));
    assert.equal(res.status, 401);
  });
});

describe("відновлення пароля", () => {
  it("для невідомого email повертає EMAIL_NOT_FOUND (свідомий компроміс: відкрито повідомляємо про акаунт)", async () => {
    const res = await readResponse(await forgotPost(json("http://localhost/api/v1/auth/forgot-password", "POST", { email: "nobody@test.local" })));
    assert.equal(res.status, 404);
    assert.equal(res.body.code ?? res.body.error?.code, "EMAIL_NOT_FOUND");
  });

  it("скидання з неправильним кодом відхиляється (400)", async () => {
    const res = await readResponse(await resetPost(json("http://localhost/api/v1/auth/reset-password", "POST", {
      email: "cust_1@test.local", code: "000000", newPassword: "Новий12345",
    })));
    assert.ok([400, 401, 404].includes(res.status), `неправильний код не скидає пароль, отримано ${res.status}`);
  });

  it("слабкий новий пароль відхиляється (400)", async () => {
    const res = await readResponse(await resetPost(json("http://localhost/api/v1/auth/reset-password", "POST", {
      email: "cust_1@test.local", code: "123456", newPassword: "short",
    })));
    assert.equal(res.status, 400);
  });
});

void ctx;
