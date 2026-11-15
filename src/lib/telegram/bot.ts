import { prisma } from "@/shared";
import { ADMIN_EVENT_DEFINITIONS, isEventEnabled, type AdminEventDefinition } from "@/lib/adminNotifications/catalog";
import {
  answerTelegramCallback,
  editTelegramKeyboard,
  escapeHtml,
  sendTelegramMessage,
  type InlineKeyboard,
} from "./client";
import { consumeLinkCode } from "./linking";

export type TelegramUpdate = {
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number | string; type: string };
    from?: { username?: string };
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { username?: string };
    message?: { message_id: number; chat: { id: number | string } };
  };
};

const TOGGLE_PREFIX = "t:";

export function parseBotCommand(text: string): { command: string; arg: string } | null {
  const match = /^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+(.*))?$/.exec(text.trim());
  if (!match) return null;
  return { command: match[1].toLowerCase(), arg: (match[2] ?? "").trim() };
}

/** Кнопки вибірки: callback_data = `t:<індекс у каталозі>`, щоб уміститися в 64 байти. */
export function buildSettingsKeyboard(overrides: Map<string, boolean>): InlineKeyboard {
  return {
    inline_keyboard: ADMIN_EVENT_DEFINITIONS.map((def, index) => {
      const on = isEventEnabled(def.type, overrides.get(def.type));
      return [{ text: `${on ? "✅" : "⬜"} ${def.label}`, callback_data: `${TOGGLE_PREFIX}${index}` }];
    }),
  };
}

export function settingsText(): string {
  return ["<b>Вибірка сповіщень</b>", "Натисніть подію, щоб увімкнути або вимкнути її."].join("\n");
}

const HELP_TEXT = [
  "<b>Команди бота</b>",
  "/settings — вибрати, які події надсилати",
  "/stop — відключити цей чат від сповіщень",
  "/help — ця довідка",
  "",
  "Щоб підключити чат, створіть код у панелі адміністратора (розділ «Сповіщення») і надішліть його сюди командою /start КОД.",
].join("\n");

async function findLinkedAdmin(chatId: string) {
  const link = await prisma.adminTelegramLink.findUnique({
    where: { chatId },
    include: { admin: { select: { id: true, email: true, active: true } } },
  });
  if (!link || !link.admin.active) return null;
  return link.admin;
}

async function loadOverrides(adminId: string): Promise<Map<string, boolean>> {
  const rows = await prisma.adminNotificationSetting.findMany({
    where: { adminId },
    select: { eventType: true, enabled: true },
  });
  return new Map(rows.map((r) => [r.eventType, r.enabled]));
}

async function handleMessage(message: NonNullable<TelegramUpdate["message"]>) {
  const chatId = String(message.chat.id);
  const parsed = parseBotCommand(message.text ?? "");
  if (!parsed) return;

  if (parsed.command === "start") {
    if (parsed.arg) {
      const linked = await consumeLinkCode(parsed.arg, {
        chatId,
        username: message.from?.username ?? null,
      }).catch(() => null);
      if (!linked) {
        await sendTelegramMessage(chatId, "Код недійсний або прострочений. Створіть новий у панелі адміністратора.");
        return;
      }
      await sendTelegramMessage(
        chatId,
        `✅ Telegram підключено до акаунта <b>${escapeHtml(linked.email)}</b>.\nНалаштуйте події командою /settings.`
      );
      return;
    }
    await sendTelegramMessage(chatId, HELP_TEXT);
    return;
  }

  if (parsed.command === "help") {
    await sendTelegramMessage(chatId, HELP_TEXT);
    return;
  }

  const admin = await findLinkedAdmin(chatId);
  if (!admin) {
    await sendTelegramMessage(chatId, "Цей чат не підключено до адмін-панелі. Створіть код у розділі «Сповіщення» і надішліть /start КОД.");
    return;
  }

  if (parsed.command === "settings") {
    const overrides = await loadOverrides(admin.id);
    await sendTelegramMessage(chatId, settingsText(), { replyMarkup: buildSettingsKeyboard(overrides) });
    return;
  }

  if (parsed.command === "stop") {
    await prisma.adminTelegramLink.deleteMany({ where: { chatId } });
    await sendTelegramMessage(chatId, "Сповіщення вимкнено. Щоб підключити знову, створіть новий код у панелі.");
  }
}

async function handleCallback(query: NonNullable<TelegramUpdate["callback_query"]>) {
  const message = query.message;
  if (!message || !query.data?.startsWith(TOGGLE_PREFIX)) {
    await answerTelegramCallback(query.id);
    return;
  }
  const chatId = String(message.chat.id);
  const admin = await findLinkedAdmin(chatId);
  if (!admin) {
    await answerTelegramCallback(query.id, "Чат не підключено");
    return;
  }

  const index = Number(query.data.slice(TOGGLE_PREFIX.length));
  const def: AdminEventDefinition | undefined = Number.isInteger(index) ? ADMIN_EVENT_DEFINITIONS[index] : undefined;
  if (!def) {
    await answerTelegramCallback(query.id, "Подію не знайдено");
    return;
  }

  const overrides = await loadOverrides(admin.id);
  const nextEnabled = !isEventEnabled(def.type, overrides.get(def.type));
  await prisma.adminNotificationSetting.upsert({
    where: { adminId_eventType: { adminId: admin.id, eventType: def.type } },
    create: { adminId: admin.id, eventType: def.type, enabled: nextEnabled },
    update: { enabled: nextEnabled },
  });
  overrides.set(def.type, nextEnabled);

  await answerTelegramCallback(query.id, `${nextEnabled ? "Увімкнено" : "Вимкнено"}: ${def.label}`);
  await editTelegramKeyboard(chatId, message.message_id, buildSettingsKeyboard(overrides));
}

/** Обробляє оновлення від Telegram. Помилки розбору не повинні повертати не-200 (інакше Telegram повторює). */
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  if (update.message?.text) {
    await handleMessage(update.message);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query);
  }
}
