import Stripe from "stripe";
import { ApiError } from "@/lib/errors";

export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ApiError(503, "INTERNAL_ERROR", "Payments provider not configured");

  return new Stripe(key, {
    apiVersion: "2026-02-25.clover",
    typescript: true,
  });
}
