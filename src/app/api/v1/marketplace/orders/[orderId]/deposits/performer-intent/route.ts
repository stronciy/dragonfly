import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import { getStripe } from "@/services/stripe.service";

const schema = z.object({
  method: z.enum(["card", "apple-pay", "google-pay"]),
});

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Performer role required");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.status !== "published") throw new ApiError(404, "NOT_FOUND", "Order not found");
    if (order.performerUserId) throw new ApiError(409, "CONFLICT", "Order already accepted");

    const match = await prisma.orderMatch.findUnique({
      where: { uniq_performer_order_match: { performerUserId: user.id, orderId } },
    });
    if (!match) throw new ApiError(403, "FORBIDDEN", "Order not available for you");

    const amount = Number(order.budget) * 0.1;
    const amountMinor = Math.max(1, Math.round(amount * 100));

    const stripe = getStripe();
    const pi = await stripe.paymentIntents.create({
      amount: amountMinor,
      currency: order.currency.toLowerCase(),
      metadata: { orderId: order.id, role: "performer", method: body.method, userId: user.id },
      automatic_payment_methods: { enabled: true },
    });

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: user.id,
        provider: "stripe",
        providerIntentId: pi.id,
        status: "requires_action",
        amount,
        currency: order.currency,
        raw: pi as any,
      },
      select: { id: true, amount: true, currency: true },
    });

    return ok(req, { paymentIntent: { id: payment.id, amount: Number(payment.amount), currency: payment.currency, provider: "stripe", clientSecret: pi.client_secret } }, { message: "Created" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
