"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLiqPayCheckoutUrl = getLiqPayCheckoutUrl;
exports.liqpayEncodeData = liqpayEncodeData;
exports.liqpaySign = liqpaySign;
exports.liqpayVerifySignature = liqpayVerifySignature;
exports.liqpayDecodeData = liqpayDecodeData;
exports.createLiqPayCheckout = createLiqPayCheckout;
const crypto_1 = __importDefault(require("crypto"));
const errors_1 = require("@/lib/errors");
function getRequiredEnv(name) {
    const value = process.env[name];
    if (!value)
        throw new errors_1.ApiError(503, "INTERNAL_ERROR", "Payments provider not configured");
    const trimmed = value.trim();
    if (!trimmed)
        throw new errors_1.ApiError(503, "INTERNAL_ERROR", "Payments provider not configured");
    return trimmed;
}
function getLiqPayCheckoutUrl() {
    return "https://www.liqpay.ua/api/3/checkout";
}
function liqpayEncodeData(params) {
    return Buffer.from(JSON.stringify(params)).toString("base64");
}
function liqpaySign(dataBase64) {
    const privateKey = getRequiredEnv("LIQPAY_PRIVATE_KEY");
    const input = `${privateKey}${dataBase64}${privateKey}`;
    return crypto_1.default.createHash("sha1").update(input).digest("base64");
}
function liqpayVerifySignature(dataBase64, signature) {
    const expected = liqpaySign(dataBase64);
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature || ""));
    if (a.length !== b.length)
        return false;
    return crypto_1.default.timingSafeEqual(a, b);
}
function liqpayDecodeData(dataBase64) {
    const json = Buffer.from(dataBase64, "base64").toString("utf8");
    return JSON.parse(json);
}
function createLiqPayCheckout(args) {
    const publicKey = getRequiredEnv("LIQPAY_PUBLIC_KEY");
    const sandbox = String(process.env.LIQPAY_SANDBOX || "").toLowerCase() === "true";
    const paytypes = args.method === "apple-pay"
        ? "applepay"
        : args.method === "google-pay"
            ? "gpay"
            : args.method === "bank-transfer"
                ? "privat24"
                : args.method === "card"
                    ? "card"
                    : undefined;
    const params = Object.assign(Object.assign(Object.assign({ public_key: publicKey, version: 3, action: "pay", amount: args.amount.toFixed(2), currency: args.currency, description: args.description, order_id: args.orderId, paytypes }, (args.serverUrl ? { server_url: args.serverUrl } : {})), (args.resultUrl ? { result_url: args.resultUrl } : {})), (sandbox ? { sandbox: 1 } : {}));
    const data = liqpayEncodeData(params);
    const signature = liqpaySign(data);
    return {
        checkoutUrl: getLiqPayCheckoutUrl(),
        data,
        signature,
    };
}
