import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";

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

    const rows = await prisma.orderMedia.findMany({
      where: { orderId, userId: user.id, kind: "report" },
      orderBy: { createdAt: "asc" },
      select: { id: true, url: true, mimeType: true, size: true, name: true, caption: true, createdAt: true },
    });

    const items = rows.map((m) => ({
      id: m.id,
      data: { url: m.url, mimeType: m.mimeType, size: m.size, name: m.name, caption: m.caption, orderId },
      createdAt: m.createdAt,
    }));

    return ok(req, { report: { items } });
  } catch (err) {
    return fail(req, err);
  }
}
