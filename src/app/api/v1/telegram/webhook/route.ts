import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { handleTelegramUpdate, type TelegramUpdate } from "@/lib/telegram/bot";

export const runtime = "nodejs";

function secretMatches(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Вебхук Telegram-бота. Telegram надсилає секрет у заголовку
 * X-Telegram-Bot-Api-Secret-Token (задається при setWebhook).
 * Завжди відповідаємо 200 після перевірки, інакше Telegram повторює оновлення.
 */
export async function POST(req: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!expected) return NextResponse.json({ error: "telegram_disabled" }, { status: 503 });

  const received = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secretMatches(received, expected)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    await handleTelegramUpdate(update);
  } catch (err) {
    process.stderr.write(
      JSON.stringify({ level: "error", msg: "telegram_update_failed", err: err instanceof Error ? err.message : String(err) }) + "\n"
    );
  }
  return NextResponse.json({ ok: true });
}
