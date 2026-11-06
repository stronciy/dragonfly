import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { LIQPAY_NOT_PAID_FINAL_STATUSES, syncPaymentIntentWithProvider } from "@/services/depositSync";

export async function POST(req: Request, ctx: { params: Promise<{ paymentIntentId: string }> }) {
  try {
    const requestId = getRequestId(req);
    const user = await requireUser(req);
    const { paymentIntentId } = await ctx.params;

    const intent = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      include: { order: { select: { customerUserId: true, performerUserId: true } } },
    });
    if (!intent) throw new ApiError(404, "NOT_FOUND", "Платіж не знайдено");

    const isParty =
      intent.order.customerUserId === user.id || intent.order.performerUserId === user.id;
    if (!isParty) throw new ApiError(404, "NOT_FOUND", "Платіж не знайдено");

    if (intent.status === "paid") {
      throw new ApiError(409, "CONFLICT", "Оплату вже проведено, скасувати неможливо");
    }

    if (intent.status === "pending" || intent.status === "cancelled") {
      // Гроші могли вже списатись, поки застосунок не отримав колбек. Спочатку
      // питаємо LiqPay: проведений платіж зараховуємо, а не скасовуємо.
      const sync = await syncPaymentIntentWithProvider(intent.id, requestId);
      if (sync.paid) {
        throw new ApiError(409, "CONFLICT", "Оплату вже проведено, скасувати неможливо");
      }
      const notFailed =
        !sync.providerStatus || !LIQPAY_NOT_PAID_FINAL_STATUSES.includes(sync.providerStatus);
      if (notFailed && sync.providerStatus) {
        throw new ApiError(409, "CONFLICT", "Платіж ще обробляється банком. Спробуйте за кілька хвилин.");
      }
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id, status: { in: ["pending", "cancelled"] } },
        data: { status: "cancelled" },
      });
    }

    return ok(req, { paymentIntent: { id: intent.id, status: "cancelled" } }, {
      message: "OK",
    });
  } catch (err) {
    return fail(req, err);
  }
}
