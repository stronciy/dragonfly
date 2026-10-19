import { fail, ok } from "@/lib/apiResponse";
import { requirePanelAdmin } from "@/lib/adminAuth";
import { prisma } from "@/shared";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** AUD-1/AUD-2: журнал действий администраторов. Курсорная пагинация по created_at. */
export async function GET(req: Request) {
  try {
    await requirePanelAdmin(req);

    const url = new URL(req.url);
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : DEFAULT_LIMIT));
    const cursor = url.searchParams.get("cursor");
    const action = url.searchParams.get("action")?.trim();
    const entityId = url.searchParams.get("entityId")?.trim();

    const rows = await prisma.adminAuditLog.findMany({
      where: {
        ...(action ? { action } : {}),
        ...(entityId ? { entityId } : {}),
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return ok(req, {
      items,
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
    });
  } catch (err) {
    return fail(req, err);
  }
}
