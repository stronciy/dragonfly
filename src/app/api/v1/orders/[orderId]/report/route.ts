import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";

export async function GET(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  const startedAt = Date.now();
  try {
    const user = await requireUser(req);
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { customerUserId: true, performerUserId: true, reportSubmittedAt: true },
    });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    const canRead =
      order.customerUserId === user.id || order.performerUserId === user.id;
    if (!canRead) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    const rows = await prisma.orderMedia.findMany({
      where: { orderId, kind: { in: ["report", "progress"] } },
      orderBy: { createdAt: "asc" },
      select: { id: true, url: true, mimeType: true, size: true, name: true, caption: true, createdAt: true },
    });

    // Keep the gallery idempotent: legacy clients could upload the same photo
    // several times, and the customer should not see duplicate thumbnails.
    const seen = new Set<string>();
    const uniqueRows = rows.filter((m) => {
      const key = m.url || m.id;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const items = uniqueRows.map((m) => ({
      id: m.id,
      data: { url: m.url, mimeType: m.mimeType, size: m.size, name: m.name, caption: m.caption, orderId },
      createdAt: m.createdAt,
    }));

    console.info(
      `[api] GET /api/v1/orders/${orderId}/report requestId=${getRequestId(req)} userId=${user.id} photos=${items.length} durationMs=${Date.now() - startedAt}`
    );

    return ok(req, {
      report: {
        items,
        submittedAt: order.reportSubmittedAt ? order.reportSubmittedAt.toISOString() : null,
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}
