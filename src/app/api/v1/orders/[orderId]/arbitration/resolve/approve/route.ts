import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { notifyUser } from "@/shared";
import { releaseEscrowForOrder, settleProviderHolds, emitEscrowChanged } from "@/shared";
import { recomputePerformerRating } from "@/shared";
import {
  getLatestArbitrationResolution,
  serializeArbitrationResolution,
} from "@/shared";

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");
    const { orderId } = await ctx.params;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.performerUserId !== user.id) {
      throw new ApiError(404, "NOT_FOUND", "Order not found");
    }
    if (order.status !== "arbitration") {
      throw new ApiError(409, "CONFLICT", "Order is not in arbitration");
    }

    const pending = await getLatestArbitrationResolution(orderId);
    if (!pending || pending.status !== "pending") {
      throw new ApiError(409, "CONFLICT", "No pending resolution proposal");
    }
    const withFine = pending.decision === "close_fine";

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: "completed", completedAt: new Date() },
      });
      await tx.orderStatusEvent.create({
        data: {
          orderId,
          status: "completed",
          note: withFine ? "Арбітраж закрито зі штрафом (за згодою сторін)" : "Арбітраж закрито без штрафу (за згодою сторін)",
        },
      });
      if (pending.rating && order.performerUserId) {
        const alreadyReviewed = await tx.review.findFirst({
          where: { orderId, authorUserId: pending.proposedById },
          select: { id: true },
        });
        if (!alreadyReviewed) {
          await tx.review.create({
            data: {
              orderId,
              performerUserId: order.performerUserId,
              authorUserId: pending.proposedById,
              rating: pending.rating,
              text: pending.comment,
            },
          });
        }
      }
      if (withFine) {
        await releaseEscrowForOrder(tx, { orderId, role: "performer", to: "forfeited" });
        await releaseEscrowForOrder(tx, { orderId, role: "customer", to: "released" });
      } else {
        await releaseEscrowForOrder(tx, { orderId, to: "released" });
      }
      await tx.arbitrationResolution.update({
        where: { id: pending.id },
        data: { status: "approved", decidedAt: new Date() },
      });
    });

    if (order.performerUserId) await recomputePerformerRating(order.performerUserId).catch(() => {});
    if (withFine) {
      await settleProviderHolds({ orderId, role: "performer", to: "forfeited" }).catch(() => {});
      await settleProviderHolds({ orderId, role: "customer", to: "released" }).catch(() => {});
    } else {
      await settleProviderHolds({ orderId, to: "released" }).catch(() => {});
    }

    await emitEscrowChanged({
      requestId,
      orderId,
      customerUserId: order.customerUserId,
      performerUserId: order.performerUserId,
      roles: ["performer", "customer"],
      orderStatus: "completed",
    });

    await notifyUser({
      userId: order.customerUserId,
      type: "arbitration",
      title: "Спір закрито",
      message: withFine
        ? `Замовлення #${orderId.slice(-6)}. Виконавець погодився закрити спір зі штрафом.`
        : `Замовлення #${orderId.slice(-6)}. Виконавець погодився закрити спір без штрафу.`,
      data: { orderId, type: "arbitration_resolved", role: "customer" },
    });
    await publishDomainEvent({
      type: "arbitration.resolved",
      requestId,
      targets: { userIds: [order.customerUserId, ...(order.performerUserId ? [order.performerUserId] : [])] },
      data: { orderId, decision: pending.decision },
    });

    const decided = await getLatestArbitrationResolution(orderId);
    return ok(req, { resolution: decided ? serializeArbitrationResolution(decided) : null }, { message: "Resolution approved" });
  } catch (err) {
    return fail(req, err);
  }
}
