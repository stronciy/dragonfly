import type { Prisma } from "@prisma/client";

/**
 * Escrow states that mean a performer's money is still committed to the order.
 * While any of these rows exist, the order must not be offered to other
 * performers — even if its status was (temporarily) reset to `published`
 * before the refund finished.
 *
 * `released` / `refunded` / `forfeited` are terminal and do not block the
 * marketplace again.
 */
export const PERFORMER_BLOCKING_ESCROW_STATUSES = [
  "held",
  "release_pending",
  "refund_pending",
  "forfeit_pending",
] as const;

export type PerformerBlockingEscrowStatus =
  (typeof PERFORMER_BLOCKING_ESCROW_STATUSES)[number];

/**
 * Prisma filter for the performer marketplace.
 *
 * `status: published` is the primary guard (accepting an order moves it to
 * `accepted`), but it is not enough on its own: a timeout/refund sequence can
 * briefly put the order back to `published` while the previous performer's
 * escrow is still held or being refunded. This filter keeps such an order out
 * of the marketplace until the money is actually settled.
 */
export function performerMarketplaceOrderWhere(args: {
  userId: string;
  serviceCategoryId?: string;
  serviceSubCategoryId?: string;
}): Prisma.OrderWhereInput {
  return {
    status: "published",
    performerUserId: null,
    // Never show your own orders as performer work, even if a stray
    // orderMatch row links them (matching SQL also excludes self).
    customerUserId: { not: args.userId },
    escrowLocks: {
      none: {
        role: "performer",
        status: { in: [...PERFORMER_BLOCKING_ESCROW_STATUSES] },
      },
    },
    ...(args.serviceCategoryId
      ? { serviceCategoryId: args.serviceCategoryId }
      : {}),
    ...(args.serviceSubCategoryId
      ? { serviceSubCategoryId: args.serviceSubCategoryId }
      : {}),
  };
}

/** Active performer escrow for one order, used to hide the detail page too. */
export function performerBlockingEscrowWhere(
  orderId: string
): Prisma.EscrowLockWhereInput {
  return {
    orderId,
    role: "performer",
    status: { in: [...PERFORMER_BLOCKING_ESCROW_STATUSES] },
  };
}
