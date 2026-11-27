// Мова повідомлень API: англійський Accept-Language дає переклад, інакше — українська без змін.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../../src/lib/errors";
import { fail, ok } from "../../src/lib/apiResponse";
import { localizeServerMessage, resolveServerLocale } from "../../src/lib/serverMessages";

const req = (acceptLanguage?: string) =>
  new Request("http://localhost/api/v1/test", {
    headers: acceptLanguage ? { "accept-language": acceptLanguage } : {},
  });

describe("мова повідомлень API", () => {
  it("визначає мову з першого тегу Accept-Language", () => {
    assert.equal(resolveServerLocale(req("en")), "en");
    assert.equal(resolveServerLocale(req("en-US,uk;q=0.8")), "en");
    assert.equal(resolveServerLocale(req("uk")), "uk");
    assert.equal(resolveServerLocale(req()), "uk");
  });

  it("невідомий текст лишається як є", () => {
    assert.equal(localizeServerMessage("Щось нове", "en"), "Щось нове");
    assert.equal(localizeServerMessage("Щось нове", "uk"), "Щось нове");
  });

  it("помилка з англійською мовою повертає переклад, з українською — оригінал", async () => {
    const message = "Невірний логін або пароль";
    const en = await fail(req("en"), new ApiError(401, "UNAUTHORIZED", message)).json();
    assert.equal(en.message, "Incorrect email or password");
    const uk = await fail(req("uk"), new ApiError(401, "UNAUTHORIZED", message)).json();
    assert.equal(uk.message, message);
  });

  it("успішна відповідь з повідомленням також локалізується", async () => {
    const body = await ok(req("en"), { id: 1 }, { message: "Пароль оновлено" }).json();
    assert.equal(body.message, "Password updated");
  });
});
