import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";
import { assertIntentRole, confirmDeposit, emitDepositPaidNotifications } from "@/shared";
import {
  buildCallbackFromStatus,
  liqpayApiRequest,
  liqpayDecodeData,
} from "@/shared";

const PAID_STATUSES = ["hold_wait", "success", "sandbox"];

function log(payload: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ level: "info", ...payload }) + "\n");
}

// Клієнт викликає при полінгу після оплати: якщо серверний колбек від LiqPay
// не прийшов (немає server_url / LiqPay недоступний), питаємо статус напряму
// і підтверджуємо заставу самі — разом зі сповіщеннями для обох сторін.
export async function POST(req: Request, ctx: { params: Promise<{ paymentIntentId: string }> }) {
  const requestId = getRequestId(req);
  let paymentIntentId = "unknown";
  try {
    paymentIntentId = (await ctx.params).paymentIntentId;
    const user = await requireUser(req);

    const intent = await prisma.paymentIntent.findUnique({
      where: { id: paymentIntentId },
      include: { order: { select: { id: true, customerUserId: true, performerUserId: true, status: true } } },
    });
    if (!intent) throw new ApiError(404, "NOT_FOUND", "Платіж не знайдено");
    const allowed =
      (intent.role === "customer" && intent.order.customerUserId === user.id) ||
      (intent.role === "performer" && intent.order.performerUserId === user.id);
    if (!allowed) throw new ApiError(404, "NOT_FOUND", "Платіж не знайдено");

    if (intent.status !== "pending") {
      return ok(req, {
        paid: intent.status === "paid",
        providerStatus:
          intent.providerRaw && typeof intent.providerRaw === "object"
            ? ((intent.providerRaw as { status?: unknown }).status ?? null)
            : null,
        order: { id: intent.order.id, status: intent.order.status },
        paymentIntent: { id: intent.id, status: intent.status },
      });
    }

    let providerOrderId = intent.providerOrderId;
    if (!providerOrderId && intent.data) {
      try {
        const checkout = liqpayDecodeData(intent.data) as { order_id?: unknown };
        if (typeof checkout.order_id === "string") providerOrderId = checkout.order_id;
      } catch {
        providerOrderId = null;
      }
    }
    if (!providerOrderId) throw new ApiError(409, "CONFLICT", "Немає ідентифікатора платежу провайдера");

    let statusRes: Awaited<ReturnType<typeof liqpayApiRequest>>;
    try {
      statusRes = await liqpayApiRequest("status", { order_id: providerOrderId });
    } catch (e) {
      log({
        msg: "liqpay_status_sync_failed",
        requestId,
        paymentIntentId,
        providerOrderId,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
    const providerStatus = typeof statusRes.status === "string" ? statusRes.status : null;

    log({
      msg: "liqpay_status_sync",
      requestId,
      paymentIntentId,
      providerOrderId,
      providerStatus,
      paymentId: typeof statusRes.payment_id === "number" ? statusRes.payment_id : null,
      amount: statusRes.amount ?? null,
      errCode: statusRes.err_code ?? null,
      errDescription: statusRes.err_description ?? null,
    });

    if (!providerStatus || !PAID_STATUSES.includes(providerStatus)) {
      return ok(req, {
        paid: false,
        providerStatus,
        order: { id: intent.order.id, status: intent.order.status },
        paymentIntent: { id: intent.id, status: intent.status },
      });
    }

    const { data, signature } = buildCallbackFromStatus(statusRes, {
      order_id: providerOrderId,
      amount: String(intent.amount),
      currency: intent.currency,
    });

    const { order, intent: paidIntent, duplicate } = await prisma.$transaction((tx) =>
      confirmDeposit(tx, { paymentIntentId, data, signature })
    );

    log({
      msg: "liqpay_deposit_confirmed_via_status",
      requestId,
      paymentIntentId,
      duplicate,
      providerStatus,
      payment: {
        id: paidIntent.id,
        role: paidIntent.role,
        status: paidIntent.status,
        amount: Number(paidIntent.amount),
        currency: paidIntent.currency,
        providerOrderId: paidIntent.providerOrderId ?? null,
        paidAt: paidIntent.paidAt,
      },
      order: { id: order.id, status: order.status },
    });

    if (!duplicate) {
      assertIntentRole(paidIntent.role);
      await emitDepositPaidNotifications({
        requestId,
        order,
        role: paidIntent.role,
        amount: paidIntent.amount,
        currency: paidIntent.currency,
        providerStatus,
      });
    }

    return ok(req, {
      paid: true,
      providerStatus,
      order: { id: order.id, status: order.status },
      paymentIntent: { id: paidIntent.id, status: paidIntent.status },
    });
  } catch (err) {
    return fail(req, err);
  }
}
