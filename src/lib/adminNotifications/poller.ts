import { prisma } from "@/shared";
import { isTelegramConfigured } from "@/lib/telegram/client";
import { deliverAdminEvents } from "./deliver";
import { EVENT_SOURCES } from "./sources";
import { advanceCursor, parseSeenMarks, selectFresh, sinceFor, type CursorState } from "./cursor";

const POLL_INTERVAL_MS = 15_000;

async function loadCursor(source: string): Promise<CursorState | null> {
  const row = await prisma.adminEventCursor.findUnique({ where: { source } });
  if (!row) return null;
  return { at: row.at, ids: parseSeenMarks(row.ids) };
}

async function saveCursor(source: string, state: CursorState): Promise<void> {
  const data = { at: state.at, ids: state.ids };
  await prisma.adminEventCursor.upsert({
    where: { source },
    create: { source, ...data },
    update: data,
  });
}

function logError(msg: string, err: unknown) {
  process.stderr.write(
    JSON.stringify({ level: "error", msg, err: err instanceof Error ? err.message : String(err) }) + "\n"
  );
}

/**
 * Один цикл опитування всіх джерел. Перший запуск лише фіксує поточний момент —
 * історія не розсилається. Далі шлемо нові записи і рухаємо курсор.
 */
export async function pollAdminEventsOnce(now: Date = new Date()): Promise<void> {
  for (const source of EVENT_SOURCES) {
    try {
      const saved = await loadCursor(source.name);
      if (!saved) {
        await saveCursor(source.name, { at: now, ids: [] });
        continue;
      }
      const rows = await source.fetch(sinceFor(saved));
      const fresh = selectFresh(rows, saved).sort((a, b) => a.at.getTime() - b.at.getTime());
      await deliverAdminEvents(fresh);
      await saveCursor(source.name, advanceCursor(rows, saved, now));
    } catch (err) {
      logError(`admin_event_source_failed:${source.name}`, err);
    }
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Запускається з instrumentation.ts при старті сервера. Без TELEGRAM_BOT_TOKEN не працює,
 * тож події не накопичуються в курсорах до появи бота.
 */
export function startAdminEventPoller(intervalMs: number = POLL_INTERVAL_MS): void {
  if (timer || !isTelegramConfigured()) return;
  let running = false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    pollAdminEventsOnce()
      .catch((err) => logError("admin_event_poll_failed", err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}
