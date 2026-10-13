import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma, reservedEscrowTotal } from "@/shared";

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль замовника");

    const [completedAgg, reservedTotal] = await Promise.all([
      prisma.order.aggregate({ where: { customerUserId: user.id, status: "completed" }, _sum: { budget: true } }),
      reservedEscrowTotal(prisma, { userId: user.id, role: "customer" }),
    ]);

    return ok(req, {
      summary: {
        completedTotal: Number(completedAgg._sum.budget ?? 0),
        reservedTotal,
        currency: "UAH",
      },
    });
  } catch (err) {
    return fail(req, err);
  }
}
