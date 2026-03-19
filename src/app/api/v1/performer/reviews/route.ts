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

    const where = { performerUserId: user.id };
    const [items, totalCount] = await prisma.$transaction([
      prisma.review.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        select: {
          id: true,
          orderId: true,
          rating: true,
          text: true,
          createdAt: true,
          author: { select: { id: true, name: true } },
        },
      }),
      prisma.review.count({ where }),
    ]);

    return ok(req, {
      items: items.map((r) => ({
        id: r.id,
        orderId: r.orderId,
        author: r.author,
        rating: r.rating,
        text: r.text,
        createdAt: r.createdAt.toISOString(),
      })),
      page: makePage(limit, offset, totalCount),
    });
  } catch (err) {
    return fail(req, err);
  }
}
