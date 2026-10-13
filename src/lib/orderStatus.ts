export const ORDER_STATUSES = [
  "draft",
  "published",
  "accepted",
  "requires_confirmation",
  "confirmed",
  "en_route",
  "started",
  "completed",
  "arbitration",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  draft: ["published", "cancelled"],
  published: ["draft", "accepted", "cancelled"],
  accepted: ["requires_confirmation", "cancelled"],
  requires_confirmation: ["confirmed", "published", "cancelled"],
  confirmed: ["en_route", "started", "arbitration", "cancelled"],
  en_route: ["started", "arbitration"],
  started: ["completed", "arbitration"],
  completed: ["arbitration"],
  arbitration: [],
  cancelled: [],
};

export const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> =
  TRANSITIONS;

export function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    typeof value === "string" &&
    (ORDER_STATUSES as readonly string[]).includes(value)
  );
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isExpirableStatus(status: OrderStatus): boolean {
  return status === "accepted" || status === "requires_confirmation";
}

/**
 * Payment-pause semantics.
 *
 * `paymentPaused` is a FLAG on the order, deliberately NOT a status — the
 * persisted status strings stay stable. It is set when the customer's part-2
 * deposit is not paid by `customerPart2Deadline`. While paused the performer
 * may not submit progress; the order itself keeps its current status.
 */
export function isPaymentPaused(order: { paymentPaused?: boolean }): boolean {
  return order.paymentPaused === true;
}

export function canSubmitProgress(order: { paymentPaused?: boolean }): boolean {
  return !isPaymentPaused(order);
}
