import { ok, fail } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { ADMIN_EVENT_DEFINITIONS, ADMIN_EVENT_GROUPS, isEventEnabled } from "@/lib/adminNotifications/catalog";
import { isTelegramConfigured } from "@/lib/telegram/client";
import { prisma } from "@/shared";

export const runtime = "nodejs";

/** Стан Telegram-прив'язки адміна та його вибірка подій. */
export async function GET(req: Request) {
  try {
    const admin = await requirePanelAdmin(req);
    const [link, settings] = await Promise.all([
      prisma.adminTelegramLink.findUnique({ where: { adminId: admin.id } }),
      prisma.adminNotificationSetting.findMany({
        where: { adminId: admin.id },
        select: { eventType: true, enabled: true },
      }),
    ]);
    const overrides = new Map(settings.map((s) => [s.eventType, s.enabled]));

    return ok(req, {
      configured: isTelegramConfigured(),
      botUsername: process.env.TELEGRAM_BOT_USERNAME?.trim() || null,
      linked: Boolean(link),
      username: link?.username ?? null,
      linkedAt: link?.linkedAt ?? null,
      groups: ADMIN_EVENT_GROUPS,
      events: ADMIN_EVENT_DEFINITIONS.map((def) => ({
        type: def.type,
        group: def.group,
        label: def.label,
        enabled: isEventEnabled(def.type, overrides.get(def.type)),
      })),
    });
  } catch (err) {
    return fail(req, err);
  }
}
