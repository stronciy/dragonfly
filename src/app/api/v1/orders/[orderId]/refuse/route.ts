import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { prisma } from "@/shared";
import { publishDomainEvent } from "@/shared";
import { notifyUser } from "@/shared";
import { releaseEscrowForOrder, settleProviderHolds } from "@/shared";
import { enqueueMatchNewOrder } from "@/shared";

const schema = z.object({
  reason: z.string().min(3).max(2000),
});

const REFUSABLE = ["accepted", "requires_confirmation", "confirmed"] as const;

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.performerUserId !== user.id) {
      throw new ApiError(404, "NOT_FOUND", "Order not found");
    }
    if (!(REFUSABLE as readonly string[]).includes(order.status)) {
      throw new ApiError(409, "CONFLICT", "Order cannot be refused in its current status");
    }

    const customerPaid = order.status === "confirmed";

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: "published",
          performerUserId: null,
          acceptedAt: null,
          depositDeadline: null,
        },
      });
      await tx.orderStatusEvent.create({
        data: { orderId, status: "published", note: `Performer refused: ${body.reason}` },
      });
      await releaseEscrowForOrder(tx, {
        orderId,
        role: "performer",
        to: customerPaid ? "forfeited" : "released",
      });
      if (customerPaid) {
        await releaseEscrowForOrder(tx, { orderId, role: "customer", to: "released" });
      }
      await tx.orderMatch.deleteMany({ where: { orderId } });
    });

    await settleProviderHolds({
      orderId,
      role: "performer",
      to: customerPaid ? "forfeited" : "released",
    }).catch(() => {});
    if (customerPaid) {
      await settleProviderHolds({ orderId, role: "customer", to: "released" }).catch(() => {});
    }

    await enqueueMatchNewOrder(orderId).catch(() => {});

    await notifyUser({
      userId: order.customerUserId,
      type: "order",
      title: "Виконавець відмовився",
      message: `Замовлення #${orderId.slice(-6)} повернуто на біржу. Причина: ${body.reason.slice(0, 120)}${
        customerPaid ? " Гарантійна сума виконавця утримана як штраф, ваша застава повернута." : ""
      }`,
      data: {
        orderId,
        type: "order_refused_by_performer",
        role: "customer",
        reason: body.reason,
        forfeited: customerPaid,
      },
    });
    await publishDomainEvent({
      type: "order.status_changed",
      requestId,
      targets: { userIds: [order.customerUserId, user.id] },
      data: { orderId, fromStatus: order.status, toStatus: "published", reason: "refused" },
    });

    return ok(req, { order: { id: orderId, status: "published" }, forfeited: customerPaid });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
