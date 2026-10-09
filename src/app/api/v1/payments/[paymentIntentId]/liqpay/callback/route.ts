import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError } from "@/shared";
import { prisma } from "@/shared";
import { assertIntentRole, confirmDeposit, emitDepositPaidNotifications } from "@/shared";
import { liqpayDecodeData } from "@/shared";

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

export async function POST(req: Request, ctx: { params: Promise<{ paymentIntentId: string }> }) {
  const requestId = getRequestId(req);
  let paymentIntentId = "unknown";
  try {
    paymentIntentId = (await ctx.params).paymentIntentId;
    const { data, signature } = await readCallbackPayload(req);
    if (!data || !signature) throw new ApiError(400, "VALIDATION_ERROR", "Missing data or signature");

    const decoded = liqpayDecodeData(data) as { status?: string };
    // hold-чекауты подтверждаются статусом hold_wait, sandbox — sandbox,
    // legacy pay-чекауты — success. Остальное (failure/error/wait_accept) — игнор.
    if (decoded.status !== "success" && decoded.status !== "hold_wait" && decoded.status !== "sandbox") {
      process.stdout.write(
        JSON.stringify({ level: "info", msg: "liqpay_callback_ignored", paymentIntentId, providerStatus: decoded.status ?? null, requestId }) + "\n"
      );
      return ok(req, { ignored: true, providerStatus: decoded.status ?? null });
    }

    const { order, intent, duplicate } = await prisma.$transaction((tx) =>
      confirmDeposit(tx, { paymentIntentId, data, signature })
    );

    // LiqPay retries server callbacks: skip re-notify on duplicates.
    if (!duplicate) {
      assertIntentRole(intent.role);
      await emitDepositPaidNotifications({
        requestId,
        order,
        role: intent.role,
        amount: intent.amount,
        currency: intent.currency,
        providerStatus: decoded.status ?? null,
      });
    }

    return ok(req, {
      order: { id: order.id, status: order.status },
      paymentIntent: { id: intent.id, status: intent.status },
    });
  } catch (err) {
    if (err instanceof ApiError && err.message === "Invalid payment signature") {
      process.stderr.write(
        JSON.stringify({ level: "error", msg: "liqpay_callback_bad_signature", paymentIntentId, requestId }) + "\n"
      );
    }
    return fail(req, err);
  }
}
