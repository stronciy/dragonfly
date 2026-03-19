import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";

const schema = z.object({
  paymentIntentId: z.string().min(1),
});

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const [order, payment] = await prisma.$transaction([
      prisma.order.findUnique({ where: { id: orderId } }),
      prisma.payment.findUnique({ where: { id: body.paymentIntentId } }),
    ]);

    if (!order || order.status !== "published") throw new ApiError(404, "NOT_FOUND", "Order not found");
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
          status: "accepted",
          acceptedAt,
          depositDeadline,
        },
      });
      if (updated.count !== 1) throw new ApiError(409, "CONFLICT", "Order already accepted");

      await tx.orderStatusEvent.create({ data: { orderId: order.id, fromStatus: "published", toStatus: "accepted", note: null } });
      await tx.orderMatch.deleteMany({ where: { orderId: order.id } });
    });

    return ok(req, { order: { id: order.id, status: "accepted" }, agreementId: null }, { message: "Accepted" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
