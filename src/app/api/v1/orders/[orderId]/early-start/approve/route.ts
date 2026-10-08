import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { notifyUser } from "@/shared";
import { getLatestEarlyStartRequest, serializeEarlyStartRequest } from "@/shared";

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.customerUserId !== user.id) {
      throw new ApiError(404, "NOT_FOUND", "Order not found");
    }
    if (order.status !== "confirmed") {
      throw new ApiError(409, "CONFLICT", "Order is no longer awaiting start");
    }

    const pending = await getLatestEarlyStartRequest(orderId);
    if (!pending || pending.status !== "pending") {
      throw new ApiError(409, "CONFLICT", "No pending early start request");
    }

    const decided = await prisma.earlyStartRequest.update({
      where: { id: pending.id },
      data: { status: "approved", decidedAt: new Date() },
    });

    if (order.performerUserId) {
      await notifyUser({
        userId: order.performerUserId,
        type: "order",
        title: "Дозволено достроковий старт",
        message: `Замовлення #${orderId.slice(-6)}. Замовник підтвердив достроковий початок робіт — кнопка старту вже активна.`,
        data: { orderId, type: "early_start_approved", role: "performer" },
      });
      await publishDomainEvent({
        type: "order.early_start_approved",
        requestId,
        targets: { userIds: [order.performerUserId] },
        data: { orderId },
      });
    }

    return ok(req, { earlyStart: serializeEarlyStartRequest(decided) }, { message: "Early start approved" });
  } catch (err) {
    return fail(req, err);
  }
}
