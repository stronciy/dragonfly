import crypto from "crypto";
import { ApiError } from "../lib/errors";

type LiqPayCheckoutParams = {
  public_key: string;
  version: number;
  action: "pay" | "hold";
  amount: string;
  currency: string;
  description: string;
  order_id: string;
  paytypes?: string;
  language?: string;
  sandbox?: 1;
  server_url?: string;
  result_url?: string;
};

function getRequiredEnv(name: "LIQPAY_PUBLIC_KEY" | "LIQPAY_PRIVATE_KEY") {
  const value = process.env[name];
  if (!value) throw new ApiError(503, "INTERNAL_ERROR", "Платіжний провайдер не налаштовано");
  const trimmed = value.trim();
  if (!trimmed) throw new ApiError(503, "INTERNAL_ERROR", "Платіжний провайдер не налаштовано");
  return trimmed;
}

export function getLiqPayCheckoutUrl() {
  return "https://www.liqpay.ua/api/3/checkout";
}

export function getLiqPayApiUrl() {
  return "https://www.liqpay.ua/api/request";
}

export type LiqPayApiResult = {
  result?: string;
  status?: string;
  payment_id?: number;
  action?: string;
  err_code?: string;
  err_description?: string;
  [key: string]: unknown;
};

// Server-to-server виклик LiqPay API (status / refund / hold_completion).
// Кидає ApiError при мережевій помилці або err_code від LiqPay.
export async function liqpayApiRequest(
  action: "status" | "refund" | "hold_completion",
  params: Record<string, string | number | undefined>
): Promise<LiqPayApiResult> {
  const publicKey = getRequiredEnv("LIQPAY_PUBLIC_KEY");
  const data = liqpayEncodeData({ public_key: publicKey, version: 3, action, ...params } as Record<string, unknown> as Parameters<typeof liqpayEncodeData>[0]);
  const signature = liqpaySign(data);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(getLiqPayApiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data, signature }).toString(),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as LiqPayApiResult | null;
    if (!res.ok || !json) {
      throw new ApiError(502, "BAD_GATEWAY", `LiqPay API HTTP ${res.status}`);
    }
    if (json.err_code || json.result === "error") {
      throw new ApiError(502, "BAD_GATEWAY", `LiqPay: ${json.err_description || json.err_code || "request failed"}`);
    }
    return json;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(502, "BAD_GATEWAY", e instanceof Error ? e.message : "LiqPay request failed");
  } finally {
    clearTimeout(timer);
  }
}

// Списання раніше заблокованих коштів (успішне завершення робіт).
export async function captureHold(liqpayOrderId: string, amount?: number) {
  return liqpayApiRequest("hold_completion", {
    order_id: liqpayOrderId,
    ...(amount !== undefined ? { amount } : {}),
  });
}

// Розблокування холда без списання (гроші повертаються на картку).
export async function reverseHold(liqpayOrderId: string) {
  return liqpayApiRequest("hold_completion", { order_id: liqpayOrderId, flag: "reversal" });
}

// Повернення вже списаних коштів (legacy pay-інтенти).
export async function refundCaptured(liqpayOrderId: string, amount?: number) {
  return liqpayApiRequest("refund", {
    order_id: liqpayOrderId,
    ...(amount !== undefined ? { amount } : {}),
  });
}

export function liqpayEncodeData(params: LiqPayCheckoutParams) {
  return Buffer.from(JSON.stringify(params)).toString("base64");
}

export function liqpaySign(dataBase64: string) {
  const privateKey = getRequiredEnv("LIQPAY_PRIVATE_KEY");
  const input = `${privateKey}${dataBase64}${privateKey}`;
  return crypto.createHash("sha1").update(input).digest("base64");
}

export function liqpayVerifySignature(dataBase64: string, signature: string) {
  const expected = liqpaySign(dataBase64);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function liqpayDecodeData(dataBase64: string) {
  const json = Buffer.from(dataBase64, "base64").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

export function createLiqPayCheckout(args: {
  orderId: string;
  amount: number;
  currency: string;
  description: string;
  method?: "card" | "apple-pay" | "google-pay" | "bank-transfer";
  serverUrl?: string;
  resultUrl?: string;
}) {
  const publicKey = getRequiredEnv("LIQPAY_PUBLIC_KEY");
  const sandbox = String(process.env.LIQPAY_SANDBOX || "").toLowerCase() === "true";

  const paytypes =
    args.method === "apple-pay"
      ? "applepay"
      : args.method === "google-pay"
        ? "gpay"
        : args.method === "bank-transfer"
          ? "privat24"
          : args.method === "card"
            ? "card"
            : undefined;

  const params: LiqPayCheckoutParams = {
    public_key: publicKey,
    version: 3,
    action: "hold",
    amount: args.amount.toFixed(2),
    currency: args.currency,
    description: args.description,
    order_id: args.orderId,
    paytypes,
    ...(args.serverUrl ? { server_url: args.serverUrl } : {}),
    ...(args.resultUrl ? { result_url: args.resultUrl } : {}),
    ...(sandbox ? { sandbox: 1 } : {}),
  };

  const data = liqpayEncodeData(params);
  const signature = liqpaySign(data);

  return {
    checkoutUrl: getLiqPayCheckoutUrl(),
    data,
    signature,
  };
}
