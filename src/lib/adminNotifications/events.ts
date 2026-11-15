export type OrderStatusPayload = {
  orderId: string;
  orderNumber: string | null;
  locationLabel: string;
  budget: number;
  currency: string;
};

export type AdminEventPayloads = {
  "user.registered": { userId: string; name: string; email: string; phone: string | null; role: string };
  "legal_profile.submitted": { userId: string; name: string; email: string; companyName: string | null; edrpou: string | null };
  "order.created": OrderStatusPayload & { areaHa: number; customerName: string };
  "order.accepted": OrderStatusPayload;
  "order.confirmed": OrderStatusPayload;
  "order.started": OrderStatusPayload;
  "order.completed": OrderStatusPayload;
  "order.cancelled": OrderStatusPayload;
  "order.arbitration": OrderStatusPayload;
  "payment.paid": {
    orderId: string;
    orderNumber: string | null;
    role: string;
    part: number;
    amount: number;
    currency: string;
    provider: string;
  };
  "payout.requested": { payoutId: string; userName: string; email: string; amount: number; currency: string; ibanTail: string };
  "arbitration.opened": { caseId: string; orderId: string; orderNumber: string | null; openedByName: string };
  "arbitration.party_message": {
    caseId: string;
    orderNumber: string | null;
    authorName: string;
    channel: string;
    text: string;
    hasAttachments: boolean;
  };
};

export type AdminEventType = keyof AdminEventPayloads;

export type AdminEvent = {
  [K in AdminEventType]: { id: string; at: Date; type: K; data: AdminEventPayloads[K] };
}[AdminEventType];
