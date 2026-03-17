import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { makePage, parsePagination } from "@/lib/pagination";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

    const url = new URL(req.url);
    const { limit, offset } = parsePagination(url);

    const where = { performerUserId: user.id, status: "completed" as const };
    const [items, totalCount] = await prisma.$transaction([
      prisma.order.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: limit,
        skip: offset,
        select: { id: true, locationLabel: true, budget: true, currency: true, updatedAt: true },
      }),
      prisma.order.count({ where }),
    ]);

    return ok(req, {
      items: items.map((o) => ({
        orderId: o.id,
        title: o.locationLabel,
        amount: Number(o.budget),
        currency: o.currency,
        locationLabel: o.locationLabel,
        completedAt: o.updatedAt,
      })),
      page: makePage(limit, offset, totalCount),
    });
  } catch (err) {
    return fail(req, err);
  }
}
