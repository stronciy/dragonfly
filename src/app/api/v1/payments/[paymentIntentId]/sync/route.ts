import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { syncPaymentIntentWithProvider } from "@/services/depositSync";

// Клієнт викликає при полінгу після оплати: якщо серверний колбек від LiqPay
// не прийшов (немає server_url / LiqPay недоступний), питаємо статус напряму
// і підтверджуємо заставу самі — разом зі сповіщеннями для обох сторін.
export async function POST(req: Request, ctx: { params: Promise<{ paymentIntentId: string }> }) {
  const requestId = getRequestId(req);
  try {
    const paymentIntentId = (await ctx.params).paymentIntentId;
    const user = await requireUser(req);

    const intent = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      include: { order: { select: { customerUserId: true, performerUserId: true } } },
    });
    if (!intent) throw new ApiError(404, "NOT_FOUND", "Платіж не знайдено");
    const allowed =
      (intent.role === "customer" && intent.order.customerUserId === user.id) ||
      (intent.role === "performer" && intent.order.performerUserId === user.id);
    if (!allowed) throw new ApiError(404, "NOT_FOUND", "Платіж не знайдено");

    const result = await syncPaymentIntentWithProvider(paymentIntentId, requestId);
    return ok(req, result);
  } catch (err) {
    return fail(req, err);
  }
}
