import crypto from "crypto";
import { ApiError } from "@/lib/errors";

type LiqPayCheckoutParams = {
  public_key: string;
  version: number;
  action: "pay";
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
  if (!value) throw new ApiError(503, "INTERNAL_ERROR", "Payments provider not configured");
  const trimmed = value.trim();
  if (!trimmed) throw new ApiError(503, "INTERNAL_ERROR", "Payments provider not configured");
  return trimmed;
}

export function getLiqPayCheckoutUrl() {
  return "https://www.liqpay.ua/api/3/checkout";
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
    action: "pay",
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
