import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { publishDomainEvent } from "@/shared";
import {
  buildDepositCallbackUrl,
  createDepositIntent,
  ensureIntentServerUrl,
  findPendingIntent,
  serializePaymentIntent,
} from "@/shared";

const schema = z.object({
  method: z.enum(["card", "apple-pay", "google-pay", "bank-transfer"]).optional(),
  wallet: z.string().max(256).optional(),
  resultUrl: z.string().max(2048).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    if (user.role !== "customer") throw new ApiError(403, "FORBIDDEN", "Потрібна роль замовника");
    const { orderId } = await ctx.params;
    const body = schema.parse(await req.json());

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.customerUserId !== user.id) {
      throw new ApiError(404, "NOT_FOUND", "Замовлення не знайдено");
    }
    if (order.status !== "requires_confirmation" && order.status !== "accepted") {
      throw new ApiError(400, "VALIDATION_ERROR", "Замовлення не потребує застави замовника");
    }
    if (!order.performerUserId) {
      throw new ApiError(400, "VALIDATION_ERROR", "Виконавця ще не призначено");
    }
    if (order.depositDeadline && order.depositDeadline.getTime() <= Date.now()) {
      throw new ApiError(400, "VALIDATION_ERROR", "Строк внесення застави минув");
    }

    const intent = await prisma.$transaction(async (tx) => {
      const pending = await findPendingIntent(tx, { orderId, role: "customer" });
      if (pending) return ensureIntentServerUrl(tx, pending, req);
      const intentId = crypto.randomUUID();
      const created = await createDepositIntent(tx, {
        orderId,
        role: "customer",
        method: body.method,
        wallet: body.wallet,
        resultUrl: body.resultUrl,
        serverUrl: buildDepositCallbackUrl(intentId, req),
        intentId,
      });
      return created.intent;
    });

    await publishDomainEvent({
      type: "deposit.customer_required",
      requestId,
      targets: { userIds: [user.id] },
      data: { orderId: order.id, status: order.status },
    });

    return ok(req, { paymentIntent: serializePaymentIntent(intent) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "Помилка валідації запиту", err.flatten()));
    }
    return fail(req, err);
  }
}
