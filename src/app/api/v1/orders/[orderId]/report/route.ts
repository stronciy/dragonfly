import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { customerUserId: true, performerUserId: true } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");

    const canRead =
      (user.role === "customer" && order.customerUserId === user.id) ||
      (user.role === "performer" && order.performerUserId === user.id);
    if (!canRead) throw new ApiError(404, "NOT_FOUND", "Order not found");

    const items = await prisma.orderReportMedia.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
      select: { id: true, url: true, createdAt: true, metadata: true },
    });

    return ok(req, { report: { items } });
  } catch (err) {
    return fail(req, err);
  }
}
