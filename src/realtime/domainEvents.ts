export type DomainEventType =
  | "order.created"
  | "order.updated"
  | "order.deleted"
  | "order.status_changed"
  | "order.started"
  | "order.completed"
  | "order.accepted"
  | "order.confirmed"
  | "marketplace.match_added"
  | "marketplace.match_removed"
  | "agreement.assigned"
  | "escrow.changed"
  | "deposit.performer_paid"
  | "deposit.customer_paid"
  | "deposit.customer_required"
  | "deposit.timeout"
  | "order.expired"
  | "order:accepted"
  | "order:confirmed"
  | "payment:required"
  | "order.early_start_requested"
  | "order.early_start_approved"
  | "order.early_start_rejected"
  | "order.early_start_withdrawn"
  | "order.progress_updated"
  | "arbitration.resolve_requested"
  | "arbitration.resolved";

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

