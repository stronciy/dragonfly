import type { Prisma } from "@prisma/client";
import { safeDepositAmount } from "./deposit";
import { MASKED_LOCATION_LABEL_FALLBACK } from "./marketplaceVisibility";

/**
 * Order-detail read model (T12). Security invariants of the
 * `GET /api/v1/orders/[orderId]` payload:
 *  - escrow is never cross-role — a customer sees only the customer's own
 *    intents/lock, a performer only the performer's own, so the counterparty's
 *    frozen amount is physically absent;
 *  - a performer sees exact geo/address only once the order is `confirmed`.
 */

// Exact geo is revealed to a performer from these statuses onward. `en_route`
// sits after `confirmed` in the status machine (T3).
export const ORDER_DETAIL_GEO_REVEALED_STATUSES = [
  "confirmed",
  "en_route",
  "started",
  "completed",
  "arbitration",
] as const;

const GEO_REVEALED = new Set<string>(ORDER_DETAIL_GEO_REVEALED_STATUSES);

export type OrderDetailViewerRole = "customer" | "performer";

export interface OrderDetailEscrowLock {
  amount: Prisma.Decimal | number | string;
  status: string;
}

export interface OrderDetailIntent {
  part: number;
  status: string;
}

export interface OrderDetailLocationInput {
  lat: Prisma.Decimal | number | string;
  lng: Prisma.Decimal | number | string;
  locationLabel: string;
  regionName: string | null;
  settlementName?: string | null;
}

export interface OrderDetailOrderInput extends OrderDetailLocationInput {
  id: string;
  orderNumber: string | null;
  status: string;
  serviceCategoryId: string;
  serviceSubCategoryId: string;
  serviceTypeId: string | null;
  areaHa: Prisma.Decimal | number | string;
  dateFrom: Date | null;
  dateTo: Date | null;
  budget: Prisma.Decimal;
  acceptedAt: Date | null;
  depositDeadline: Date | null;
  performerUserId: string | null;
  comment: string | null;
}

export interface OrderDetailTimelineItem {
  status: string | null;
  createdAt: Date;
  note: string | null;
}

export interface OrderDetailReviewInput {
  rating: number;
  text: string | null;
  createdAt: Date;
}

export interface CustomerDepositView {
  part1Paid: boolean;
  part2Paid: boolean;
  amount: number;
}

export interface PerformerDepositView {
  amount: number;
  held: boolean;
}

export interface OrderDetailEscrowView {
  // Caller's OWN open escrow total — never the counterparty's.
  escrowAmount: number;
  depositCustomer?: CustomerDepositView;
  depositPerformer?: PerformerDepositView;
}

// Callers MUST have already passed the ownership check; a user is never both
// sides of the same order.
export function resolveOrderDetailViewerRole(
  order: { customerUserId: string; performerUserId: string | null },
  userId: string
): OrderDetailViewerRole {
  return order.customerUserId === userId ? "customer" : "performer";
}

export function isOrderDetailGeoMasked(status: string, viewerRole: OrderDetailViewerRole): boolean {
  if (viewerRole !== "performer") return false;
  return !GEO_REVEALED.has(status);
}

// `lock`/`intents` MUST already be filtered to the viewer's own role by the
// caller — this function never receives the counterparty's rows.
export function buildOrderDetailEscrow(args: {
  viewerRole: OrderDetailViewerRole;
  lock: OrderDetailEscrowLock | null;
  intents: OrderDetailIntent[];
}): OrderDetailEscrowView {
  const amount = args.lock ? Number(args.lock.amount) : 0;

  if (args.viewerRole === "customer") {
    return {
      escrowAmount: amount,
      depositCustomer: {
        part1Paid: args.intents.some((i) => i.part === 1 && i.status === "paid"),
        part2Paid: args.intents.some((i) => i.part === 2 && i.status === "paid"),
        amount,
      },
    };
  }

  return {
    escrowAmount: amount,
    depositPerformer: {
      amount,
      held: args.lock?.status === "held",
    },
  };
}

function buildLocation(
  order: OrderDetailLocationInput,
  masked: boolean
): Record<string, unknown> {
  if (masked) {
    return {
      locationLabel: MASKED_LOCATION_LABEL_FALLBACK,
    };
  }
  return {
    lat: Number(order.lat),
    lng: Number(order.lng),
    locationLabel: order.locationLabel,
    addressLabel: order.locationLabel,
    regionName: order.regionName,
  };
}

export function buildOrderDetailPayload(args: {
  order: OrderDetailOrderInput;
  viewerRole: OrderDetailViewerRole;
  lock: OrderDetailEscrowLock | null;
  intents: OrderDetailIntent[];
  timeline: OrderDetailTimelineItem[];
  confirmationReview: OrderDetailReviewInput | null;
}) {
  const { order, viewerRole } = args;
  const masked = isOrderDetailGeoMasked(order.status, viewerRole);
  const escrow = buildOrderDetailEscrow({
    viewerRole,
    lock: args.lock,
    intents: args.intents,
  });

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    serviceCategoryId: order.serviceCategoryId,
    serviceSubCategoryId: order.serviceSubCategoryId,
    serviceTypeId: order.serviceTypeId,
    areaHa: Number(order.areaHa),
    location: buildLocation(order, masked),
    dateFrom: order.dateFrom,
    dateTo: order.dateTo,
    budget: Number(order.budget),
    acceptedAt: order.acceptedAt,
    depositDeadline: order.depositDeadline,
    depositAmount: Number(safeDepositAmount(order.budget)),
    ...escrow,
    performerUserId: order.performerUserId,
    comment: order.comment,
    completionConfirmedAt: args.confirmationReview?.createdAt ?? null,
    rating: args.confirmationReview?.rating ?? null,
    completionComment: args.confirmationReview?.text ?? null,
    timeline: args.timeline.map((t) => ({ status: t.status, at: t.createdAt, note: t.note })),
  };
}
