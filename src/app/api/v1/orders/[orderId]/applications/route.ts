import { ok, fail } from "@/lib/apiResponse";
import { ApiError, prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { listApplicationsForOrder } from "@/services/application.service";

export async function GET(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль замовника");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, customerUserId: true },
    });
    if (!order || order.customerUserId !== user.id) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }

    const items = await listApplicationsForOrder(orderId);
    return ok(req, { items });
  } catch (err) {
    return fail(req, err);
  }
}
