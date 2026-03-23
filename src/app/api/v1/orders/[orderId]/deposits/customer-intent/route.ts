import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth/requireAuth";
import type { InputJsonValue } from "@/generated/prisma/internal/prismaNamespace";
import { createLiqPayCheckout } from "@/services/liqpay.service";

const schema = z.object({
  method: z.enum(["card", "apple-pay", "google-pay", "bank-transfer"]),
});

function getRequestOrigin(req: Request) {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Customer role required");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.customerUserId !== user.id) throw new ApiError(404, "NOT_FOUND", "Order not found");
    
    // Дозволяємо оплату для requires_confirmation та accepted (для зворотної сумісності)
    if (order.status !== "requires_confirmation" && order.status !== "accepted") {
      throw new ApiError(409, "CONFLICT", "Customer deposit is not available for this status. Available statuses: requires_confirmation, accepted");
    }

    // Сума: 10% від бюджету (гарантійна сума)
    const amount = Number(order.budget) * 0.1;

    const providerIntentId = `liqpay_${crypto.randomUUID()}`;
    const origin = getRequestOrigin(req);
    const checkout = createLiqPayCheckout({
      orderId: providerIntentId,
      amount,
      currency: order.currency,
      description: `Customer deposit for order ${order.id}`,
      method: body.method,
      serverUrl: `${origin}/api/v1/payments/liqpay/webhook`,
      resultUrl: `${origin}/`,
    });

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        userId: user.id,
        provider: "liqpay",
        providerIntentId,
        status: "requires_action",
        amount,
        currency: order.currency,
        raw: { method: body.method, liqpay: checkout } as unknown as InputJsonValue,
      },
      select: { id: true, amount: true, currency: true },
    });

    return ok(
      req,
      {
        paymentIntent: {
          id: payment.id,
          provider: "liqpay",
          checkoutUrl: checkout.checkoutUrl,
          data: checkout.data,
          signature: checkout.signature,
          orderId: providerIntentId,
          amount: Number(payment.amount),
          currency: payment.currency,
          availableMethods: ["card", "apple-pay", "google-pay", "bank-transfer"],
        },
        order: { id: order.id, status: order.status },
      },
      { message: "Created" }
    );
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
