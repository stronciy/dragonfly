export type DomainEventType =
  | "order.created"
  | "order.updated"
  | "order.deleted"
  | "order.status_changed"
  | "marketplace.match_added"
  | "marketplace.match_removed"
  | "agreement.assigned"
  | "escrow.changed"
  | "deposit.performer_paid"
  | "deposit.customer_required"
  | "deposit.timeout";

export type DomainEvent<T extends DomainEventType = DomainEventType, D = unknown> = {
  eventId: string;
  type: T;
  version: "1.0";
  timestamp: string;
  requestId?: string;
  targets: {
    userIds: string[];
  };
  data: D;
};

