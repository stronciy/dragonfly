// Контракти автентифікації: реєстрація, вхід, оновлення сесії, вихід і
// блокування — саме ті відповіді, на яких тримається вхід у застосунку.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { resetWorld, call, readResponse, USERS } from "../helpers/world";
import { db } from "../helpers/fakePrisma";
import { POST as registerPost } from "../../src/app/api/v1/auth/register/route";
import { POST as loginPost } from "../../src/app/api/v1/auth/login/route";
import { GET as mePost } from "../../src/app/api/v1/auth/me/route";
import { POST as logoutPost } from "../../src/app/api/v1/auth/logout/route";
import { sha256 } from "../../src/lib/auth/tokens";

const PASSWORD = "Пароль1234";

function jsonPost(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function seedAccount(id: string, email: string, opts: { blocked?: boolean } = {}) {
  db.insert("user", {
    id,
    name: "Тест",
    email,
    role: "customer",
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    sessionVersion: 0,
    blockedAt: opts.blocked ? new Date() : null,
    phone: null,
    avatarUrl: null,
    createdAt: new Date(),
  });
}

beforeEach(() => resetWorld());

describe("реєстрація", () => {
  it("новий заказчик створюється з профілем і отримує токен", async () => {
    const res = await readResponse(await registerPost(jsonPost("http://localhost/api/v1/auth/register", {
      name: "Олена", email: "olena@test.local", password: PASSWORD,
    })));
    assert.equal(res.status, 201);
    assert.ok(res.body.data.accessToken, "є accessToken");
    const user = db.findUnique("user", { where: { email: "olena@test.local" } }) as any;
    assert.ok(user, "користувач записаний");
    assert.ok(db.findUnique("customerProfile", { where: { userId: user.id } }), "профіль заказчика створено");
    assert.notEqual(user.passwordHash, PASSWORD, "пароль не зберігається у відкритому вигляді");
  });

  it("слабкий пароль відхиляється з поясненням (400)", async () => {
    const res = await readResponse(await registerPost(jsonPost("http://localhost/api/v1/auth/register", {
      name: "Олена", email: "weak@test.local", password: "short",
    })));
    assert.equal(res.status, 400);
  });

  it("повторна реєстрація з тим самим email — 409", async () => {
    seedAccount("u_dup", "dup@test.local");
    const res = await readResponse(await registerPost(jsonPost("http://localhost/api/v1/auth/register", {
      name: "Інший", email: "dup@test.local", password: PASSWORD,
    })));
    assert.equal(res.status, 409);
  });
});

describe("вхід і сесія", () => {
  it("правильний пароль — токен і профіль користувача", async () => {
    seedAccount("u_login", "login@test.local");
    const res = await readResponse(await loginPost(jsonPost("http://localhost/api/v1/auth/login", {
      email: "login@test.local", password: PASSWORD,
    })));
    assert.equal(res.status, 200);
    assert.ok(res.body.data.accessToken);
  });

  it("неправильний пароль — 401 без підказки, що саме невірне", async () => {
    seedAccount("u_bad", "bad@test.local");
    const res = await readResponse(await loginPost(jsonPost("http://localhost/api/v1/auth/login", {
      email: "bad@test.local", password: "Інший1234",
    })));
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "Невірний логін або пароль");
  });

  it("заблокований акаунт не входить (403)", async () => {
    seedAccount("u_block", "blocked@test.local", { blocked: true });
    const res = await readResponse(await loginPost(jsonPost("http://localhost/api/v1/auth/login", {
      email: "blocked@test.local", password: PASSWORD,
    })));
    assert.equal(res.status, 403);
  });

  it("/auth/me повертає профіль за токеном, без токена — 401", async () => {
    const withToken = await readResponse(await mePost(await call(USERS.customer, "GET")));
    assert.equal(withToken.status, 200);
    assert.equal(withToken.body.data.user?.id ?? withToken.body.data.id, USERS.customer);

    const anon = await readResponse(await mePost(new Request("http://localhost/api/v1/auth/me")));
    assert.equal(anon.status, 401);
  });

  it("вихід відкликає refresh-токен із cookie", async () => {
    const refresh = "refresh-token-value-for-logout";
    db.insert("refreshToken", { id: "rt1", userId: USERS.customer, tokenHash: await sha256(refresh), revokedAt: null, expiresAt: new Date(Date.now() + 1e9), createdAt: new Date() });
    const res = await readResponse(await logoutPost(new Request("http://localhost/api/v1/auth/logout", {
      method: "POST",
      headers: { cookie: `refreshToken=${refresh}` },
    })));
    assert.equal(res.status, 200);
    assert.ok((db.findUnique("refreshToken", { where: { id: "rt1" } }) as any).revokedAt, "refresh відкликано");
  });
});
