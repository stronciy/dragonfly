import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");

    const mine = await prisma.review.findMany({
      where: { performerUserId: user.id },
      select: { orderId: true, rating: true },
    });
    let visible = mine;
    if (mine.length > 0) {
      const orderIds = Array.from(new Set(mine.map((r) => r.orderId)));
      const authors = await prisma.review.findMany({
        where: { orderId: { in: orderIds } },
        select: { orderId: true, authorUserId: true },
        distinct: ["orderId", "authorUserId"],
      });
      const counts = new Map<string, number>();
      for (const a of authors) counts.set(a.orderId, (counts.get(a.orderId) ?? 0) + 1);
      visible = mine.filter((r) => (counts.get(r.orderId) ?? 0) >= 2);
    }

    const counts: Record<"1" | "2" | "3" | "4" | "5", number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    for (const row of visible) {
      const key = String(row.rating) as keyof typeof counts;
      if (counts[key] != null) counts[key] += 1;
    }

    const avg = visible.length === 0 ? 0 : Number((visible.reduce((s, r) => s + r.rating, 0) / visible.length).toFixed(2));
    const count = visible.length;

    return ok(req, { rating: { avg, count, breakdown: counts } });
  } catch (err) {
    return fail(req, err);
  }
}
