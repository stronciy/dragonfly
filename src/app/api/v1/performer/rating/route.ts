import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

    const [agg, rows] = await prisma.$transaction([
      prisma.review.aggregate({
        where: { performerUserId: user.id },
        _avg: { rating: true },
        _count: { rating: true },
      }),
      prisma.review.findMany({
        where: { performerUserId: user.id },
        select: { rating: true },
      }),
    ]);

    const counts: Record<"1" | "2" | "3" | "4" | "5", number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    for (const row of rows) {
      const key = String(row.rating) as keyof typeof counts;
      if (counts[key] != null) counts[key] += 1;
    }

    const avg = agg._avg.rating == null ? 0 : Number(Number(agg._avg.rating).toFixed(2));
    const count = agg._count.rating;

    return ok(req, { rating: { avg, count, breakdown: counts } });
  } catch (err) {
    return fail(req, err);
  }
}
