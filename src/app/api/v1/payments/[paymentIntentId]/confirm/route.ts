import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import { getStripe } from "@/services/stripe.service";

const schema = z.object({
  providerPayload: z.record(z.string(), z.any()),
});

function mapStripeStatus(status: string) {
  if (status === "succeeded") return "succeeded";
  if (status === "processing") return "processing";
  if (status === "canceled") return "canceled";
  return "requires_action";
}

export async function POST(req: Request, ctx: { params: Promise<{ paymentIntentId: string }> }) {
  try {
    const user = await requireUser(req);
    const { paymentIntentId } = await ctx.params;
    schema.parse(await req.json().catch(() => ({})));

    const payment = await prisma.payment.findUnique({ where: { id: paymentIntentId } });
    if (!payment || payment.userId !== user.id) throw new ApiError(404, "NOT_FOUND", "Payment not found");

    const stripe = getStripe();
    const pi = await stripe.paymentIntents.retrieve(payment.providerIntentId);
    const nextStatus = mapStripeStatus(pi.status);

    const updated = await prisma.payment.update({
      where: { id: paymentIntentId },
      data: { status: nextStatus as any, paidAt: nextStatus === "succeeded" ? new Date() : null, raw: pi as any },
      select: { id: true, status: true, amount: true, currency: true, paidAt: true, orderId: true },
    });

    const response: any = { payment: { id: updated.id, status: updated.status, amount: Number(updated.amount), currency: updated.currency, paidAt: updated.paidAt } };

    if (updated.status === "succeeded") {
      const [order, dbUser] = await prisma.$transaction([
        prisma.order.findUnique({ where: { id: updated.orderId }, select: { id: true, status: true } }),
        prisma.user.findUnique({ where: { id: user.id }, select: { role: true } }),
      ]);

      if (order && dbUser) {
        const role = dbUser.role === "performer" ? "performer" : "customer";
        await prisma.escrowLock.upsert({
          where: { uniq_order_role_lock: { orderId: order.id, role: role as any } },
          update: { status: "locked" },
          create: {
            orderId: order.id,
            userId: user.id,
            role: role as any,
            status: "locked",
            amount: updated.amount,
            currency: updated.currency,
            provider: "stripe",
            providerRef: payment.providerIntentId,
          },
        });

        if (order.status === "accepted") {
          const customerLock = await prisma.escrowLock.findFirst({ where: { orderId: order.id, role: "customer", status: "locked" } });
          const performerLock = await prisma.escrowLock.findFirst({ where: { orderId: order.id, role: "performer", status: "locked" } });
          if (customerLock && performerLock) {
            await prisma.$transaction([
              prisma.order.update({ where: { id: order.id }, data: { status: "confirmed" } }),
              prisma.orderStatusEvent.create({ data: { orderId: order.id, fromStatus: "accepted", toStatus: "confirmed", note: null } }),
              prisma.orderMatch.deleteMany({ where: { orderId: order.id } }),
            ]);
            response.order = { id: order.id, status: "confirmed" };
          }
        }
      }
    }

    return ok(req, response, { message: "Confirmed" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
