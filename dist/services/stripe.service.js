"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStripe = getStripe;
const stripe_1 = __importDefault(require("stripe"));
const errors_1 = require("@/lib/errors");
function getStripe() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key)
        throw new errors_1.ApiError(503, "INTERNAL_ERROR", "Payments provider not configured");
    return new stripe_1.default(key, {
        apiVersion: "2026-02-25.clover",
        typescript: true,
    });
}
