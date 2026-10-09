import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { publishDomainEvent } from "@/shared";
import { claimOrderForPerformer, createDepositIntent, ensureIntentServerUrl, findPendingIntent, serializePaymentIntent, buildDepositCallbackUrl } from "@/shared";

const schema = z.object({
  method: z.enum(["card", "apple-pay", "google-pay", "bank-transfer"]).optional(),
  wallet: z.string().max(256).optional(),
  resultUrl: z.string().max(2048).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const { order, freshClaim, intent } = await prisma.$transaction(async (tx) => {
      const claim = await claimOrderForPerformer(tx, {
        orderId,
        performerUserId: user.id,
      });
      const pending = await findPendingIntent(tx, { orderId, role: "performer" });
      if (pending) return { intent: await ensureIntentServerUrl(tx, pending, req), checkout: null as null, amount: pending.amount };
      const intentId = crypto.randomUUID();
      const created = await createDepositIntent(tx, {
        orderId,
        role: "performer",
        method: body.method,
        wallet: body.wallet,
        resultUrl: body.resultUrl,
        serverUrl: buildDepositCallbackUrl(intentId, req),
        intentId,
      });
      return { order: claim.order, freshClaim: claim.freshClaim, intent: created.intent };
    });

    if (freshClaim) {
      const targets = { userIds: [order.customerUserId, user.id] };
      await publishDomainEvent({
        type: "agreement.assigned",
        requestId,
        targets,
        data: { orderId: order.id, performerId: user.id },
      });
      await publishDomainEvent({
        type: "order.status_changed",
        requestId,
        targets,
        data: { orderId: order.id, fromStatus: "published", toStatus: "accepted" },
      });
      await publishDomainEvent({
        type: "order.accepted",
        requestId,
        targets,
        data: { orderId: order.id, performerId: user.id },
      });
      await publishDomainEvent({
        type: "order:accepted",
        requestId,
        targets,
        data: { orderId: order.id, performerId: user.id },
      });
    }

    return ok(req, { paymentIntent: serializePaymentIntent(intent) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
