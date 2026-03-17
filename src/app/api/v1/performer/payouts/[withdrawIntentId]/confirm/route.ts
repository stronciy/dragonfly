import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request, ctx: { params: Promise<{ withdrawIntentId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");
    const { withdrawIntentId } = await ctx.params;

    const payout = await prisma.payout.findUnique({ where: { id: withdrawIntentId } });
    if (!payout || payout.performerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Payout not found");

    const updated = await prisma.payout.update({
      where: { id: withdrawIntentId },
      data: { status: "paid", paidAt: new Date() },
      select: { id: true, status: true },
    });

    return ok(req, { payout: updated }, { message: "Confirmed" });
  } catch (err) {
    return fail(req, err);
  }
}
