import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");

    const [completedAgg, reservedAgg] = await prisma.$transaction([
      prisma.order.aggregate({ where: { performerUserId: user.id, status: "completed" }, _sum: { budget: true } }),
      prisma.escrowLock.aggregate({ where: { userId: user.id, role: "performer", status: "locked" }, _sum: { amount: true } }),
    ]);

    return ok(req, {
      summary: {
        completedTotal: Number(completedAgg._sum.budget ?? 0),
        reservedTotal: Number(reservedAgg._sum.amount ?? 0),
        currency: "UAH",
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}
