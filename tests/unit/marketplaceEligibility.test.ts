import test from "node:test";
import assert from "node:assert/strict";
import {
  PERFORMER_BLOCKING_ESCROW_STATUSES,
  performerBlockingEscrowWhere,
  performerMarketplaceOrderWhere,
} from "../../src/lib/marketplaceEligibility";

test("marketplace blocks every non-terminal performer escrow state", () => {
  assert.deepEqual([...PERFORMER_BLOCKING_ESCROW_STATUSES], [
    "held",
    "release_pending",
    "refund_pending",
    "forfeit_pending",
  ]);
});

test("performer marketplace query only returns unassigned published orders", () => {
  const where = performerMarketplaceOrderWhere({ userId: "performer-1" });

  assert.equal(where.status, "published");
  assert.equal(where.performerUserId, null);
  assert.deepEqual(where.customerUserId, { not: "performer-1" });
  assert.deepEqual(where.escrowLocks, {
    none: {
      role: "performer",
      status: { in: [...PERFORMER_BLOCKING_ESCROW_STATUSES] },
    },
  });
});

test("performer marketplace query keeps service filters", () => {
  const where = performerMarketplaceOrderWhere({
    userId: "performer-1",
    serviceCategoryId: "1",
    serviceSubCategoryId: "1.2",
  });

  assert.equal(where.serviceCategoryId, "1");
  assert.equal(where.serviceSubCategoryId, "1.2");
});

test("detail-page escrow guard targets only active performer locks", () => {
  assert.deepEqual(performerBlockingEscrowWhere("order-1"), {
    orderId: "order-1",
    role: "performer",
    status: { in: [...PERFORMER_BLOCKING_ESCROW_STATUSES] },
  });
});
