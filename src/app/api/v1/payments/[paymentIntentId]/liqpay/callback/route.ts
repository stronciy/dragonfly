import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { assertIntentRole, confirmDeposit, emitDepositPaidNotifications } from "@/shared";
import { liqpayDecodeData } from "@/shared";

type LiqPayDecoded = {
  status?: unknown;
  order_id?: unknown;
  payment_id?: unknown;
  amount?: unknown;
  currency?: unknown;
  action?: unknown;
  description?: unknown;
  sender_phone?: unknown;
  sender_card_mask2?: unknown;
  err_code?: unknown;
  err_description?: unknown;
};

async function readCallbackPayload(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    return {
      data: String(form.get("data") ?? ""),
      signature: String(form.get("signature") ?? ""),
    };
  }
  const json = (await req.json().catch(() => null)) as {
    data?: unknown;
    signature?: unknown;
  } | null;
  return {
    data: typeof json?.data === "string" ? json.data : "",
    signature: typeof json?.signature === "string" ? json.signature : "",
  };
}

function log(payload: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ level: "info", ...payload }) + "\n");
}

export async function POST(req: Request, ctx: { params: Promise<{ paymentIntentId: string }> }) {
  const requestId = getRequestId(req);
  let paymentIntentId = "unknown";
  try {
    paymentIntentId = (await ctx.params).paymentIntentId;
    const { data, signature } = await readCallbackPayload(req);
    if (!data || !signature) throw new ApiError(400, "VALIDATION_ERROR", "Відсутні data або signature");

    const decoded = liqpayDecodeData(data) as LiqPayDecoded;

    // Full hook details, so it is visible in logs whether the hold went through.
    log({
      msg: "liqpay_callback_received",
      requestId,
      paymentIntentId,
      hook: {
        status: decoded.status ?? null,
        action: decoded.action ?? null,
        orderId: decoded.order_id ?? null,
        paymentId: decoded.payment_id ?? null,
        amount: decoded.amount ?? null,
        currency: decoded.currency ?? null,
        description: decoded.description ?? null,
        senderPhone: decoded.sender_phone ?? null,
        cardMask: decoded.sender_card_mask2 ?? null,
        errCode: decoded.err_code ?? null,
        errDescription: decoded.err_description ?? null,
      },
    });

    // hold-чекауты подтверждаются статусом hold_wait, sandbox — sandbox,
    // legacy pay-чекауты — success. Остальное (failure/error/wait_accept) — игнор.
    if (decoded.status !== "success" && decoded.status !== "hold_wait" && decoded.status !== "sandbox") {
      log({
        msg: "liqpay_callback_ignored",
        requestId,
        paymentIntentId,
        providerStatus: decoded.status ?? null,
        errCode: decoded.err_code ?? null,
        errDescription: decoded.err_description ?? null,
      });
      return ok(req, { ignored: true, providerStatus: decoded.status ?? null });
    }

    const { order, intent, duplicate } = await prisma.$transaction((tx) =>
      confirmDeposit(tx, { paymentIntentId, data, signature })
    );

    const [customer, performer] = await Promise.all([
      prisma.user.findUnique({
        where: { id: order.customerUserId },
        select: { id: true, name: true, email: true, phone: true },
      }),
      order.performerUserId
        ? prisma.user.findUnique({
            where: { id: order.performerUserId },
            select: { id: true, name: true, email: true, phone: true },
          })
        : Promise.resolve(null),
    ]);

    // Verify (hold/block) succeeded: full payment + order + parties.
    log({
      msg: "liqpay_deposit_succeeded",
      requestId,
      paymentIntentId,
      duplicate,
      providerStatus: decoded.status ?? null,
      payment: {
        id: intent.id,
        role: intent.role,
        status: intent.status,
        amount: Number(intent.amount),
        currency: intent.currency,
        providerOrderId: intent.providerOrderId ?? null,
        liqpayPaymentId: decoded.payment_id ?? null,
        paidAt: intent.paidAt,
      },
      order: {
        id: order.id,
        status: order.status,
        customerUserId: order.customerUserId,
        performerUserId: order.performerUserId ?? null,
        budget: Number(order.budget),
        currency: order.currency,
        areaHa: Number(order.areaHa),
        serviceCategoryId: order.serviceCategoryId,
        serviceSubCategoryId: order.serviceSubCategoryId,
        serviceTypeId: order.serviceTypeId ?? null,
        locationLabel: order.locationLabel,
        orderNumber: order.orderNumber,
        regionName: order.regionName ?? null,
        dateFrom: order.dateFrom,
        dateTo: order.dateTo,
      },
      customer,
      performer,
    });

    // LiqPay retries server callbacks: skip re-notify on duplicates.
    if (!duplicate) {
      assertIntentRole(intent.role);
      await emitDepositPaidNotifications({
        requestId,
        order,
        role: intent.role,
        amount: intent.amount,
        currency: intent.currency,
        providerStatus: typeof decoded.status === "string" ? decoded.status : null,
      });
    }

    return ok(req, {
      order: { id: order.id, status: order.status },
      paymentIntent: { id: intent.id, status: intent.status },
    });
  } catch (err) {
    if (err instanceof ApiError && err.message === "Недійсний підпис оплати") {
      process.stderr.write(
        JSON.stringify({ level: "error", msg: "liqpay_callback_bad_signature", paymentIntentId, requestId }) + "\n"
      );
    }
    return fail(req, err);
  }
}
