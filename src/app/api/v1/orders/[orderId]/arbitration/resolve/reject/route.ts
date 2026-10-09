import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, orderRef } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { notifyUser } from "@/shared";
import {
  getLatestArbitrationResolution,
  serializeArbitrationResolution,
} from "@/shared";

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

    const pending = await getLatestArbitrationResolution(orderId);
    if (!pending || pending.status !== "pending") {
      throw new ApiError(409, "CONFLICT", "Немає активної пропозиції");
    }

    const decided = await prisma.arbitrationResolution.update({
      where: { id: pending.id },
      data: { status: "rejected", decidedAt: new Date() },
    });

    await notifyUser({
      userId: order.customerUserId,
      type: "arbitration",
      title: "Рішення відхилено",
      message: `Замовлення ${await orderRef(orderId)}. Виконавець відхилив запропоноване рішення спору. Спір лишається відкритим.`,
      data: { orderId, type: "arbitration_resolve_rejected", role: "customer" },
    });
    await publishDomainEvent({
      type: "order.updated",
      requestId,
      targets: { userIds: [order.customerUserId] },
      data: { orderId },
    });

    return ok(req, { resolution: serializeArbitrationResolution(decided) }, { message: "Пропозицію відхилено" });
  } catch (err) {
    return fail(req, err);
  }
}
