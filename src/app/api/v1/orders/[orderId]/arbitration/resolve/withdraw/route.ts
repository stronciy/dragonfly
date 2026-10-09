import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import {
  getLatestArbitrationResolution,
  serializeArbitrationResolution,
} from "@/shared";

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль замовника");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.customerUserId !== user.id) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }

    const pending = await getLatestArbitrationResolution(orderId);
    if (!pending || pending.status !== "pending" || pending.proposedById !== user.id) {
      throw new ApiError(409, "CONFLICT", "Немає активної пропозиції для відкликання");
    }

    const decided = await prisma.arbitrationResolution.update({
      where: { id: pending.id },
      data: { status: "withdrawn", decidedAt: new Date() },
    });

    await publishDomainEvent({
      type: "order.updated",
      requestId,
      targets: { userIds: order.performerUserId ? [order.performerUserId] : [] },
      data: { orderId },
    });

    return ok(req, { resolution: serializeArbitrationResolution(decided) }, { message: "Пропозицію відкликано" });
  } catch (err) {
    return fail(req, err);
  }
}
