import { prisma } from "@/shared";
import { isTelegramConfigured, sendWithRetry } from "@/lib/telegram/client";
import { isEventEnabled } from "./catalog";
import type { AdminEvent } from "./events";
import { formatAdminEvent } from "./format";

/**
 * Розсилає події активним адміністраторам з прив'язаним Telegram, яким цей тип
 * увімкнено у вибірці. Помилки відправки логуються і не зупиняють інші сповіщення.
 */
export async function deliverAdminEvents(events: AdminEvent[]): Promise<number> {
  if (events.length === 0 || !isTelegramConfigured()) return 0;

  const links = await prisma.adminTelegramLink.findMany({
    where: { admin: { active: true } },
    select: { adminId: true, chatId: true },
  });
  if (links.length === 0) return 0;

  const settings = await prisma.adminNotificationSetting.findMany({
    where: { adminId: { in: links.map((link) => link.adminId) } },
    select: { adminId: true, eventType: true, enabled: true },
  });
  const overrides = new Map(settings.map((s) => [`${s.adminId}|${s.eventType}`, s.enabled]));

  const panelUrl = process.env.ADMIN_PANEL_URL?.trim() || undefined;
  let sent = 0;
  for (const event of events) {
    const text = formatAdminEvent(event, panelUrl);
    for (const link of links) {
      const enabled = isEventEnabled(event.type, overrides.get(`${link.adminId}|${event.type}`));
      if (!enabled) continue;
      const res = await sendWithRetry(link.chatId, text);
      if (res.ok) {
        sent += 1;
      } else {
        process.stderr.write(
          JSON.stringify({
            level: "error",
            msg: "admin_telegram_send_failed",
            eventType: event.type,
            adminId: link.adminId,
            status: res.status,
            description: res.description,
          }) + "\n"
        );
      }
    }
  }
  return sent;
}
