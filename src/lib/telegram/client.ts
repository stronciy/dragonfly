const API_TIMEOUT_MS = 10_000;

export type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

export type TelegramResult = { ok: true } | { ok: false; status: number; description: string; retryAfterSec?: number };

export function getTelegramBotToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return token ? token : null;
}

export function isTelegramConfigured(): boolean {
  return getTelegramBotToken() !== null;
}

async function callTelegram(method: string, body: Record<string, unknown>): Promise<TelegramResult> {
  const token = getTelegramBotToken();
  if (!token) return { ok: false, status: 0, description: "TELEGRAM_BOT_TOKEN не задано" };

  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, status: 0, description: err instanceof Error ? err.message : "network error" };
  }

  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; description?: string; parameters?: { retry_after?: number } }
    | null;
  if (res.ok && data?.ok) return { ok: true };
  return {
    ok: false,
    status: res.status,
    description: data?.description ?? `HTTP ${res.status}`,
    retryAfterSec: data?.parameters?.retry_after,
  };
}

/** Повідомлення в чат адміна. HTML-розмітка: текст має бути екранований через escapeHtml. */
export function sendTelegramMessage(
  chatId: string,
  text: string,
  options: { replyMarkup?: InlineKeyboard } = {}
): Promise<TelegramResult> {
  return callTelegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
  });
}

export function editTelegramKeyboard(chatId: string, messageId: number, replyMarkup: InlineKeyboard): Promise<TelegramResult> {
  return callTelegram("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

export function answerTelegramCallback(callbackQueryId: string, text?: string): Promise<TelegramResult> {
  return callTelegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

/** Надсилає повідомлення з однією повторною спробою, якщо Telegram попросив зачекати (429). */
export async function sendWithRetry(chatId: string, text: string, options: { replyMarkup?: InlineKeyboard } = {}) {
  const first = await sendTelegramMessage(chatId, text, options);
  if (first.ok || first.status !== 429) return first;
  const waitMs = Math.min((first.retryAfterSec ?? 1) * 1000, 30_000);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return sendTelegramMessage(chatId, text, options);
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
