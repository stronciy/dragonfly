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
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.performerUserId !== user.id) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }

    const pending = await getLatestEarlyStartRequest(orderId);
    if (!pending || pending.status !== "pending" || pending.requestedById !== user.id) {
      throw new ApiError(409, "CONFLICT", "Немає активного запиту раннього старту для відкликання");
    }

    const decided = await prisma.earlyStartRequest.update({
      where: { id: pending.id },
      data: { status: "withdrawn", decidedAt: new Date() },
    });

    await notifyUser({
      userId: order.customerUserId,
      type: "order",
      title: "Запит на достроковий старт відкликано",
      message: `Замовлення #${orderId.slice(-6)}. Виконавець відкликав прохання почати роботи раніше.`,
      data: { orderId, type: "early_start_withdrawn", role: "customer" },
    });
    await publishDomainEvent({
      type: "order.early_start_withdrawn",
      requestId,
      targets: { userIds: [order.customerUserId] },
      data: { orderId },
    });

    return ok(req, { earlyStart: serializeEarlyStartRequest(decided) }, { message: "Запит відкликано" });
  } catch (err) {
    return fail(req, err);
  }
}
