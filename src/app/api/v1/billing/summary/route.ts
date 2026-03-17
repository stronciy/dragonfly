import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");

    const [ordersTotalAgg, reservedAgg] = await prisma.$transaction([
      prisma.order.aggregate({
        where: { customerUserId: user.id },
        _sum: { budget: true },
      }),
      prisma.escrowLock.aggregate({
        where: { userId: user.id, role: "customer", status: "locked" },
        _sum: { amount: true },
      }),
    ]);

    return ok(req, {
      summary: {
        ordersTotal: Number(ordersTotalAgg._sum.budget ?? 0),
        reservedDeposits: Number(reservedAgg._sum.amount ?? 0),
        currency: "UAH",
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}
