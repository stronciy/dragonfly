import { ok, fail } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { createLinkCode } from "@/lib/telegram/linking";
import { ApiError } from "@/shared";

export const runtime = "nodejs";

/** Одноразовий код прив'язки (15 хв). Адмін надсилає його боту командою /start КОД. */
export async function POST(req: Request) {
  try {
    const admin = await requirePanelAdmin(req);
    const botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim();
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim() || !botUsername) {
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Telegram-бот не налаштовано (TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME)");
    }
    const { code, expiresAt } = await createLinkCode(admin.id);
    return ok(req, {
      code,
      expiresAt,
      deeplink: `https://t.me/${botUsername}?start=${code}`,
    });
  } catch (err) {
    return fail(req, err);
  }
}
