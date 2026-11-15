import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_EVENT_DEFINITIONS, isEventEnabled, isKnownEventType } from "../../src/lib/adminNotifications/catalog";
import { advanceCursor, LOOKBACK_MS, selectFresh, sinceFor, type CursorState } from "../../src/lib/adminNotifications/cursor";
import { formatAdminEvent } from "../../src/lib/adminNotifications/format";
import type { AdminEvent } from "../../src/lib/adminNotifications/events";
import { buildSettingsKeyboard, parseBotCommand } from "../../src/lib/telegram/bot";
import { hashLinkCode, generateLinkCode } from "../../src/lib/telegram/linking";

const T0 = new Date("2026-11-15T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

test("catalog: every type is known, unique and starts enabled by default", () => {
  const types = ADMIN_EVENT_DEFINITIONS.map((d) => d.type);
  assert.equal(new Set(types).size, types.length);
  assert.ok(ADMIN_EVENT_DEFINITIONS.every((d) => d.defaultEnabled));
  assert.equal(isKnownEventType("payout.requested"), true);
  assert.equal(isKnownEventType("order.unknown"), false);
});

test("catalog: explicit override wins over default", () => {
  assert.equal(isEventEnabled("order.created", undefined), true);
  assert.equal(isEventEnabled("order.created", false), false);
  assert.equal(isEventEnabled("order.created", true), true);
  assert.equal(isEventEnabled("no.such.type", undefined), false);
});

test("cursor: first run has no fresh events and sinceFor looks back", () => {
  const cursor: CursorState = { at: T0, ids: [] };
  assert.equal(sinceFor(cursor).getTime(), T0.getTime() - LOOKBACK_MS);
});

test("cursor: already-sent rows inside the window are not returned twice", () => {
  const cursor: CursorState = { at: at(1000), ids: [{ id: "a", at: at(1000).toISOString() }] };
  const rows = [
    { id: "a", at: at(1000) },
    { id: "b", at: at(1500) },
  ];
  assert.deepEqual(selectFresh(rows, cursor).map((r) => r.id), ["b"]);
});

test("cursor: late-committed row within lookback is still delivered once", () => {
  let cursor: CursorState = { at: at(120_000), ids: [] };
  cursor = advanceCursor([{ id: "x", at: at(120_000) }], cursor, at(121_000));
  const lateRow = { id: "late", at: at(100_000) };
  assert.deepEqual(selectFresh([lateRow, { id: "x", at: at(120_000) }], cursor).map((r) => r.id), ["late"]);
  cursor = advanceCursor([lateRow, { id: "x", at: at(120_000) }], cursor, at(122_000));
  assert.deepEqual(selectFresh([lateRow, { id: "x", at: at(120_000) }], cursor), []);
});

test("cursor: advance moves to newest row and prunes marks outside the window", () => {
  const cursor: CursorState = { at: at(0), ids: [{ id: "old", at: at(0).toISOString() }] };
  const next = advanceCursor([{ id: "n", at: at(500_000) }], cursor, at(600_000));
  assert.equal(next.at.getTime(), at(500_000).getTime());
  assert.deepEqual(next.ids.map((m) => m.id), ["n"]);
});

test("cursor: empty batch keeps the cursor position", () => {
  const cursor: CursorState = { at: at(5000), ids: [] };
  const next = advanceCursor([], cursor, at(9000));
  assert.equal(next.at.getTime(), at(5000).getTime());
});

test("format: order created escapes user text and includes panel link", () => {
  const event: AdminEvent = {
    id: "o1",
    at: T0,
    type: "order.created",
    data: {
      orderId: "cmwxyz123456",
      orderNumber: "A-42",
      locationLabel: "Київ <b>",
      budget: 1500,
      currency: "UAH",
      areaHa: 12.5,
      customerName: "Іван & Ко",
    },
  };
  const text = formatAdminEvent(event, "https://admin.example.com/");
  assert.match(text, /Нове замовлення/);
  assert.match(text, /№A-42/);
  assert.match(text, /Київ &lt;b&gt;/);
  assert.match(text, /Іван &amp; Ко/);
  assert.match(text, /href="https:\/\/admin\.example\.com\/dashboard\/orders"/);
});

test("format: without panel url there is no link", () => {
  const event: AdminEvent = {
    id: "p1",
    at: T0,
    type: "payout.requested",
    data: { payoutId: "p1", userName: "Олег", email: "o@x.ua", amount: 2000, currency: "UAH", ibanTail: "1234" },
  };
  const text = formatAdminEvent(event);
  assert.match(text, /IBAN: \*\*\*\*1234/);
  assert.doesNotMatch(text, /href/);
});

test("format: arbitration party message truncates long text", () => {
  const event: AdminEvent = {
    id: "m1",
    at: T0,
    type: "arbitration.party_message",
    data: {
      caseId: "c1",
      orderNumber: null,
      authorName: "Петро",
      channel: "common",
      text: "я".repeat(400),
      hasAttachments: true,
    },
  };
  const text = formatAdminEvent(event);
  assert.match(text, /…/);
  assert.match(text, /📎/);
  assert.ok(text.length < 600);
});

test("bot: command parsing with args and bot mention", () => {
  assert.deepEqual(parseBotCommand("/start ABCD2345"), { command: "start", arg: "ABCD2345" });
  assert.deepEqual(parseBotCommand("/settings@DragonflyAdminBot"), { command: "settings", arg: "" });
  assert.equal(parseBotCommand("привіт"), null);
});

test("bot: keyboard callback data fits Telegram's 64-byte limit", () => {
  const keyboard = buildSettingsKeyboard(new Map([["order.created", false]]));
  assert.equal(keyboard.inline_keyboard.length, ADMIN_EVENT_DEFINITIONS.length);
  for (const row of keyboard.inline_keyboard) {
    for (const button of row) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
  assert.match(keyboard.inline_keyboard[2][0].text, /^⬜/);
  assert.match(keyboard.inline_keyboard[0][0].text, /^✅/);
});

test("linking: codes are 8 chars without ambiguous symbols and hash is case-insensitive", () => {
  const code = generateLinkCode();
  assert.equal(code.length, 8);
  assert.doesNotMatch(code, /[01IO]/);
  assert.equal(hashLinkCode(code.toLowerCase()), hashLinkCode(code));
});
