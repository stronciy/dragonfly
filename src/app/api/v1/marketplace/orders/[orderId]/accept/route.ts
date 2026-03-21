import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import { publishDomainEvent } from "@/realtime/publishDomainEvent";

const schema = z.object({
  paymentIntentId: z.string().min(1),
});

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const [order, payment, existingMatches] = await prisma.$transaction([
      prisma.order.findUnique({ where: { id: orderId } }),
      prisma.payment.findUnique({ where: { id: body.paymentIntentId } }),
      prisma.orderMatch.findMany({ where: { orderId }, select: { performerUserId: true } }),
    ]);

    if (!order) throw new ApiError(404, "NOT_FOUND", "Order not found");
    
    // Якщо замовлення вже прийнято (requires_confirmation або далі) - повертаємо успіх
    if (order.status === "requires_confirmation" && order.performerUserId === user.id) {
      // Вже прийнято цим виконавцем
      return ok(req, { order: { id: order.id, status: "requires_confirmation" }, agreementId: null }, { message: "Already accepted" });
    }
    
    if (order.status !== "published") throw new ApiError(404, "NOT_FOUND", "Order not found");
    if (order.performerUserId) throw new ApiError(409, "CONFLICT", "Order already accepted");
    if (!payment || payment.userId !== user.id || payment.orderId !== order.id) throw new ApiError(404, "NOT_FOUND", "Payment not found");
    if (payment.status !== "succeeded") throw new ApiError(409, "CONFLICT", "Performer deposit not paid");

    const lock = await prisma.escrowLock.findFirst({ where: { orderId: order.id, role: "performer", userId: user.id, status: "locked" } });
    if (!lock) throw new ApiError(409, "CONFLICT", "Performer deposit not locked");

    const acceptedAt = new Date();
    const depositDeadline = new Date(acceptedAt.getTime() + 12 * 60 * 60 * 1000);

    await prisma.$transaction(async (tx) => {
      const match = await tx.orderMatch.findUnique({
        where: { uniq_performer_order_match: { performerUserId: user.id, orderId: order.id } },
        select: { id: true },
      });
      if (!match) throw new ApiError(403, "FORBIDDEN", "Order is not available for this performer");

      const updated = await tx.order.updateMany({
        where: { id: order.id, status: "published", performerUserId: null },
        data: {
          performerUserId: user.id,
          status: "requires_confirmation",
          acceptedAt,
          depositDeadline,
        },
      });
      if (updated.count !== 1) throw new ApiError(409, "CONFLICT", "Order already accepted");

      await tx.orderStatusEvent.create({ data: { orderId: order.id, fromStatus: "published", toStatus: "requires_confirmation", note: null } });
      await tx.orderMatch.deleteMany({ where: { orderId: order.id } });
    });

    const matchRecipients = Array.from(new Set(existingMatches.map((m) => m.performerUserId)));
    if (matchRecipients.length) {
      await publishDomainEvent({
        type: "marketplace.match_removed",
        requestId,
        targets: { userIds: matchRecipients },
        data: { orderId: order.id },
      });
    }

    await publishDomainEvent({
      type: "agreement.assigned",
      requestId,
      targets: { userIds: [order.customerUserId, user.id] },
      data: { orderId: order.id, customerId: order.customerUserId, performerId: user.id },
    });

    await publishDomainEvent({
      type: "order.status_changed",
      requestId,
      targets: { userIds: [order.customerUserId, user.id] },
      data: { orderId: order.id, fromStatus: "published", toStatus: "requires_confirmation" },
    });

    return ok(req, { order: { id: order.id, status: "requires_confirmation" }, agreementId: null }, { message: "Accepted" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
