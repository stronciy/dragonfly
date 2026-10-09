import { fail, ok } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");

    await prisma.orderMatch.upsert({
      where: {
        uniq_performer_order_match: { performerUserId: user.id, orderId },
      },
      create: { performerUserId: user.id, orderId, status: "ignored" },
      update: { status: "ignored" },
    });

    return ok(req, { orderId, hidden: true });
  } catch (err) {
    return fail(req, err);
  }
}
