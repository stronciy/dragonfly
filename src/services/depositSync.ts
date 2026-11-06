import { ApiError, prisma } from "@/shared";
import {
  assertIntentRole,
  buildCallbackFromStatus,
  confirmDeposit,
  emitDepositPaidNotifications,
  liqpayApiRequest,
  liqpayDecodeData,
} from "@/shared";

export const LIQPAY_PAID_STATUSES = ["hold_wait", "success", "sandbox"];
export const LIQPAY_NOT_PAID_FINAL_STATUSES = ["failure", "error", "reversed", "expired"];

function log(payload: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ level: "info", ...payload }) + "\n");
}

export type PaymentIntentSyncResult = {
  paid: boolean;
  providerStatus: string | null;
  order: { id: string; status: string };
  paymentIntent: { id: string; status: string };
};

// Питає LiqPay про реальний стан платежу і, якщо він проведений, підтверджує
// заставу. Використовується і полінгом клієнта (sync), і перед скасуванням
// (cancel), щоб не скасувати інтент, за яким гроші вже списані.
export async function syncPaymentIntentWithProvider(
  paymentIntentId: string,
  requestId: string
): Promise<PaymentIntentSyncResult> {
  const intent = await prisma.paymentIntent.findUnique({
    where: { id: paymentIntentId },
    include: { order: { select: { id: true, status: true } } },
  });
  if (!intent) throw new ApiError(404, "NOT_FOUND", "Платіж не знайдено");

  const order = { id: intent.order.id, status: intent.order.status };

  if (intent.status !== "pending" && intent.status !== "cancelled") {
    return {
      paid: intent.status === "paid",
      providerStatus:
        intent.providerRaw && typeof intent.providerRaw === "object"
          ? ((intent.providerRaw as { status?: unknown }).status as string | null) ?? null
          : null,
      order,
      paymentIntent: { id: intent.id, status: intent.status },
    };
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

  if (!providerStatus || !LIQPAY_PAID_STATUSES.includes(providerStatus)) {
    return {
      paid: false,
      providerStatus,
      order,
      paymentIntent: { id: intent.id, status: intent.status },
    };
  }

  const { data, signature } = buildCallbackFromStatus(statusRes, {
    order_id: providerOrderId,
    amount: String(intent.amount),
    currency: intent.currency,
  });

  const { order: confirmedOrder, intent: paidIntent, duplicate } = await prisma.$transaction(async (tx) => {
    // Скасований інтент, за яким банк уже списав гроші, треба відновити до
    // pending, інакше confirmDeposit його відхилить і платіж не зафіксується.
    if (intent.status === "cancelled") {
      await tx.paymentIntent.updateMany({
        where: { id: intent.id, status: "cancelled" },
        data: { status: "pending" },
      });
    }
    return confirmDeposit(tx, { paymentIntentId, data, signature });
  });

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
    order: { id: confirmedOrder.id, status: confirmedOrder.status },
  });

  if (!duplicate) {
    assertIntentRole(paidIntent.role);
    await emitDepositPaidNotifications({
      requestId,
      order: confirmedOrder,
      role: paidIntent.role,
      amount: paidIntent.amount,
      currency: paidIntent.currency,
      providerStatus,
      part: paidIntent.part,
    });
  }

  return {
    paid: paidIntent.status === "paid",
    providerStatus,
    order: { id: confirmedOrder.id, status: confirmedOrder.status },
    paymentIntent: { id: paidIntent.id, status: paidIntent.status },
  };
}
