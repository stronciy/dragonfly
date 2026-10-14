import { z } from "zod";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { createDepositIntent, ensureIntentServerUrl, findPendingIntent, serializePaymentIntent, buildDepositCallbackUrl } from "@/shared";

const schema = z.object({
  method: z.enum(["card", "apple-pay", "google-pay", "bank-transfer"]).optional(),
  wallet: z.string().max(256).optional(),
  resultUrl: z.string().max(2048).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser(req);
    if (user.role !== "performer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль виконавця");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, performerUserId: true },
    });
    if (!order) throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    if (order.performerUserId !== user.id) {
      throw new ApiError(403, "FORBIDDEN", "Ви не призначені виконавцем для цього замовлення");
    }
    if (order.status !== "accepted") {
      throw new ApiError(409, "CONFLICT", "Замовлення ще не прийнято замовником");
    }

    const intent = await prisma.$transaction(async (tx) => {
      const pending = await findPendingIntent(tx, { orderId, role: "performer" });
      if (pending) return ensureIntentServerUrl(tx, pending, req);
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
      return created.intent;
    });

    return ok(req, { paymentIntent: serializePaymentIntent(intent) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
