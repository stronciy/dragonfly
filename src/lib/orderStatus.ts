export const ORDER_STATUSES = [
  "draft",
  "published",
  "accepted",
  "requires_confirmation",
  "confirmed",
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
  confirmed: ["started", "arbitration", "cancelled"],
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
