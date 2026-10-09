import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { assertIntentRole, confirmDeposit, emitDepositPaidNotifications } from "@/shared";

const schema = z.object({
  providerPayload: z.object({
    provider: z.literal("liqpay"),
    data: z.string().min(1),
    signature: z.string().min(1),
  }),
});

export async function POST(req: Request, ctx: { params: Promise<{ paymentIntentId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { paymentIntentId } = await ctx.params;
    const body = schema.parse(await req.json());

    const pre = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      include: { order: { select: { id: true, customerUserId: true, performerUserId: true } } },
    });
    if (!pre) throw new ApiError(404, "NOT_FOUND", "Payment intent not found");
    const allowed =
      (pre.role === "customer" && pre.order.customerUserId === user.id) ||
      (pre.role === "performer" && pre.order.performerUserId === user.id);
    if (!allowed) throw new ApiError(404, "NOT_FOUND", "Payment intent not found");

    const { order, intent, duplicate } = await prisma.$transaction((tx) =>
      confirmDeposit(tx, {
        paymentIntentId,
        data: body.providerPayload.data,
        signature: body.providerPayload.signature,
      })
    );

    if (!duplicate) {
      assertIntentRole(intent.role);
      await emitDepositPaidNotifications({
        requestId,
        order,
        role: intent.role,
        amount: intent.amount,
        currency: intent.currency,
        providerStatus: null,
      });
    }

    return ok(req, {
      order: { id: order.id, status: order.status },
      paymentIntent: { id: intent.id, status: intent.status },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Request validation failed", err.flatten()));
    }
    return fail(req, err);
  }
}
