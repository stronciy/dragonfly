import { ok, fail } from "@/lib/apiResponse";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";

type ActivityItem = {
  type: "order_created" | "order_accepted" | "order_completed";
  regionName: string | null;
  at: string;
};

const WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_ITEMS = 10;

const CACHE_MS = 30_000;
let cache: { data: { items: ActivityItem[] }; at: number } | null = null;

export async function GET(req: Request) {
  try {
    await requireUser(req);

    if (cache && Date.now() - cache.at < CACHE_MS) {
      return ok(req, cache.data);
    }

    const since = new Date(Date.now() - WINDOW_MS);

    const orders = await prisma.order.findMany({
      where: {
        OR: [
          { createdAt: { gte: since }, status: { not: "draft" } },
          { acceptedAt: { gte: since } },
          { completedAt: { gte: since } },
        ],
      },
      select: {
        regionName: true,
        createdAt: true,
        acceptedAt: true,
        completedAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    const items: ActivityItem[] = [];
    for (const o of orders) {
      if (o.createdAt >= since) {
        items.push({ type: "order_created", regionName: o.regionName, at: o.createdAt.toISOString() });
      }
      if (o.acceptedAt && o.acceptedAt >= since) {
        items.push({ type: "order_accepted", regionName: o.regionName, at: o.acceptedAt.toISOString() });
      }
      if (o.completedAt && o.completedAt >= since) {
        items.push({ type: "order_completed", regionName: o.regionName, at: o.completedAt.toISOString() });
      }
    }

    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    const data = { items: items.slice(0, MAX_ITEMS) };
    cache = { data, at: Date.now() };
    return ok(req, data);
  } catch (err) {
    return fail(req, err);
  }
}
