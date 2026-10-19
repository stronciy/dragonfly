import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { ApiError, prisma } from "@/shared";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type AuditCursor = { createdAt: Date; id: string };

/**
 * Курсор — пара «createdAt|id», а не один id: порядок журнала задаёт createdAt,
 * и фильтр только по id мог пропустить или повторить записи на границе страниц
 * (id и createdAt не гарантированно монотонны относительно друг друга).
 */
function parseCursor(raw: string | null): AuditCursor | null {
  if (!raw) return null;
  const separator = raw.indexOf("|");
  if (separator <= 0) return null;
  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (!id || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

/** AUD-1/AUD-2: журнал действий администраторов. Курсорная пагинация. */
export async function GET(req: Request) {
  try {
    await requirePanelAdmin(req);

    const url = new URL(req.url);
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : DEFAULT_LIMIT));
    const cursorRaw = url.searchParams.get("cursor")?.trim() ?? null;
    const cursor = parseCursor(cursorRaw);
    if (cursorRaw && !cursor) {
      throw new ApiError(400, "VALIDATION_ERROR", "Некоректний курсор журналу");
    }
    const action = url.searchParams.get("action")?.trim();
    const entityId = url.searchParams.get("entityId")?.trim();

    const rows = await prisma.adminAuditLog.findMany({
      where: {
        ...(action ? { action } : {}),
        ...(entityId ? { entityId } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];

    return ok(req, {
      items,
      nextCursor: hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    });
  } catch (err) {
    return fail(req, err);
  }
}
