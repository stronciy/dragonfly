import { ok, fail } from "@/lib/apiResponse";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { countOnlineByRole } from "@/shared";

type StatsPayload = {
  activeOrders: number;
  regionsCount: number;
  customersOnline: number;
  performersOnline: number;
};

const CACHE_MS = 30_000;
let cache: { data: StatsPayload; at: number } | null = null;

export async function GET(req: Request) {
  try {
    await requireUser(req);

    if (cache && Date.now() - cache.at < CACHE_MS) {
      return ok(req, cache.data);
    }

    const [activeOrders, regionGroups, online] = await Promise.all([
      prisma.order.count({ where: { status: "published" } }),
      prisma.order.groupBy({
        by: ["regionName"],
        where: { status: "published", regionName: { not: null } },
      }),
      countOnlineByRole(),
    ]);

    const data: StatsPayload = {
      activeOrders,
      regionsCount: regionGroups.length,
      customersOnline: online.customers,
      performersOnline: online.performers,
    };
    cache = { data, at: Date.now() };
    return ok(req, data);
  } catch (err) {
    return fail(req, err);
  }
}
