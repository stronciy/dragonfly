import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { performerUserId: true } });
    if (!order || order.performerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Order not found");

    return ok(req, { report: { orderId, status: "submitted" } }, { message: "Submitted" });
  } catch (err) {
    return fail(req, err);
  }
}
