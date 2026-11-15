/**
 * Курсор опитування джерел подій. Транзакція може закомітитись пізніше свого
 * `createdAt`, тому кожен опит перечитує хвіст вікна LOOKBACK_MS. Уже розіслані
 * id зберігаються в тому ж вікні, щоб не відправити подію двічі.
 */
export const LOOKBACK_MS = 60_000;

export type SeenMark = { id: string; at: string };

export type CursorState = { at: Date; ids: SeenMark[] };

export type Sourced = { id: string; at: Date };

export function parseSeenMarks(raw: unknown): SeenMark[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { id, at } = item as Record<string, unknown>;
    return typeof id === "string" && typeof at === "string" ? [{ id, at }] : [];
  });
}

export function sinceFor(cursor: CursorState): Date {
  return new Date(cursor.at.getTime() - LOOKBACK_MS);
}

/** Ще не розіслані записи з вибірки. */
export function selectFresh<T extends Sourced>(rows: T[], cursor: CursorState): T[] {
  const seen = new Set(cursor.ids.map((m) => m.id));
  return rows.filter((row) => !seen.has(row.id));
}

/** Новий курсор після обробки всіх рядків вибірки (і нових, і вже відомих). */
export function advanceCursor<T extends Sourced>(rows: T[], cursor: CursorState, now: Date): CursorState {
  let newestAt = cursor.at.getTime();
  for (const row of rows) newestAt = Math.max(newestAt, row.at.getTime());
  const at = new Date(Math.min(newestAt, now.getTime()));

  const windowStart = at.getTime() - LOOKBACK_MS;
  const marks = new Map<string, string>();
  for (const mark of cursor.ids) {
    if (new Date(mark.at).getTime() >= windowStart) marks.set(mark.id, mark.at);
  }
  for (const row of rows) {
    if (row.at.getTime() >= windowStart) marks.set(row.id, row.at.toISOString());
  }
  return { at, ids: [...marks].map(([id, markAt]) => ({ id, at: markAt })) };
}
