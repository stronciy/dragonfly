import { ok, fail } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { sendTelegramMessage } from "@/lib/telegram/client";
import { ApiError, prisma } from "@/shared";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const admin = await requirePanelAdmin(req);
    const link = await prisma.adminTelegramLink.findUnique({ where: { adminId: admin.id } });
    if (!link) throw new ApiError(409, "CONFLICT", "Спочатку підключіть Telegram");
    const res = await sendTelegramMessage(
      link.chatId,
      "✅ Тестове сповіщення з адмін-панелі Dragonfly. Якщо ви його бачите, зв'язок працює."
    );
    if (!res.ok) throw new ApiError(502, "BAD_GATEWAY", `Telegram: ${res.description}`);
    return ok(req, { sent: true });
  } catch (err) {
    return fail(req, err);
  }
}
