import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import {
  buildOrderDetailEscrow,
  buildOrderDetailPayload,
  isOrderDetailGeoMasked,
  resolveOrderDetailViewerRole,
  performerDepositAmount,
  type OrderDetailOrderInput,
} from "../../src/shared";
import { MASKED_LOCATION_LABEL_FALLBACK } from "../../src/lib/marketplaceVisibility";

const BUDGET = new Prisma.Decimal("100000");
const FULL_DEPOSIT = performerDepositAmount(BUDGET);
const PERFORMER_AMOUNT = performerDepositAmount(BUDGET);

function makeOrder(status: string): OrderDetailOrderInput {
  return {
    id: "o1",
    orderNumber: "DF-1",
    status,
    serviceCategoryId: "1",
    serviceSubCategoryId: "1.1",
    serviceTypeId: null,
    areaHa: 12.5,
    lat: 49.5883,
    lng: 34.5514,
    locationLabel: "Поле біля Полтави",
    regionName: "Полтавська",
    settlementName: null,
    dateFrom: new Date("2026-01-01T00:00:00Z"),
    dateTo: null,
    budget: BUDGET,
    acceptedAt: new Date("2026-01-02T00:00:00Z"),
    depositDeadline: null,
    performerUserId: "p1",
    comment: "коментар",
  };
}

function build(args: {
  viewerRole: "customer" | "performer";
  status: string;
  lock: { amount: Prisma.Decimal | number | string; status: string } | null;
  intents?: { part: number; status: string }[];
}) {
  return buildOrderDetailPayload({
    order: makeOrder(args.status),
    viewerRole: args.viewerRole,
    lock: args.lock,
    intents: args.intents ?? [],
    timeline: [{ status: args.status, createdAt: new Date("2026-01-03T00:00:00Z"), note: null }],
    confirmationReview: null,
  });
}

test("resolveOrderDetailViewerRole: owner is customer, otherwise performer", () => {
  const order = { customerUserId: "c1", performerUserId: "p1" };
  assert.equal(resolveOrderDetailViewerRole(order, "c1"), "customer");
  assert.equal(resolveOrderDetailViewerRole(order, "p1"), "performer");
});

test("isOrderDetailGeoMasked: performer masked until confirmed; customer never masked", () => {
  for (const status of ["draft", "published", "accepted", "requires_confirmation", "cancelled"]) {
    assert.equal(isOrderDetailGeoMasked(status, "performer"), true, `performer/${status}`);
    assert.equal(isOrderDetailGeoMasked(status, "customer"), false, `customer/${status}`);
  }
  for (const status of ["confirmed", "en_route", "started", "completed", "arbitration"]) {
    assert.equal(isOrderDetailGeoMasked(status, "performer"), false, `performer/${status}`);
  }
});

test("customer payload exposes depositCustomer and NO performer escrow field", () => {
  const payload = build({
    viewerRole: "customer",
    status: "confirmed",
    lock: { amount: FULL_DEPOSIT, status: "held" },
    intents: [{ part: 1, status: "paid" }],
  });

  assert.equal("depositPerformer" in payload, false);
  assert.ok(payload.depositCustomer);
  assert.equal(payload.depositCustomer.part1Paid, true);
  assert.equal(payload.depositCustomer.part2Paid, false);
  assert.equal(payload.depositCustomer.amount, Number(FULL_DEPOSIT));
  assert.equal(payload.escrowAmount, Number(FULL_DEPOSIT));
});

test("performer payload exposes depositPerformer and NO customer escrow field", () => {
  const payload = build({
    viewerRole: "performer",
    status: "confirmed",
    lock: { amount: PERFORMER_AMOUNT, status: "held" },
    intents: [],
  });

  assert.equal("depositCustomer" in payload, false);
  assert.ok(payload.depositPerformer);
  assert.equal(payload.depositPerformer.amount, Number(PERFORMER_AMOUNT));
  assert.equal(payload.depositPerformer.held, true);

  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("depositCustomer"), false);
});

test("buildOrderDetailEscrow: performer held=false when lock missing", () => {
  const view = buildOrderDetailEscrow({ viewerRole: "performer", lock: null, intents: [] });
  assert.equal(view.depositPerformer?.amount, 0);
  assert.equal(view.depositPerformer?.held, false);
  assert.equal(view.escrowAmount, 0);
});

test("performer pre-confirm (accepted/requires_confirmation): no lat/lng/addressLabel/region", () => {
  for (const status of ["accepted", "requires_confirmation"]) {
    const payload = build({
      viewerRole: "performer",
      status,
      lock: { amount: PERFORMER_AMOUNT, status: "held" },
    });
    assert.equal("lat" in payload.location, false, `${status} lat`);
    assert.equal("lng" in payload.location, false, `${status} lng`);
    assert.equal("addressLabel" in payload.location, false, `${status} addressLabel`);
    assert.equal("addressLabel" in payload, false, `${status} top-level addressLabel`);
    assert.equal("regionName" in payload.location, false, `${status} regionName`);
    assert.equal(payload.location.locationLabel, MASKED_LOCATION_LABEL_FALLBACK);
  }
});

test("performer pre-confirm payload never leaks the exact address (T21)", () => {
  const order: OrderDetailOrderInput = {
    ...makeOrder("accepted"),
    locationLabel: "вул. Тестова 1, Полтава",
    regionName: "Полтавська область",
    settlementName: "Полтава",
  };
  const buildFor = (status: string) =>
    buildOrderDetailPayload({
      order: { ...order, status },
      viewerRole: "performer",
      lock: { amount: PERFORMER_AMOUNT, status: "held" },
      intents: [],
      timeline: [],
      confirmationReview: null,
    });

  for (const status of ["draft", "published", "accepted", "requires_confirmation", "cancelled"]) {
    const json = JSON.stringify(buildFor(status));
    assert.equal(json.includes("Тестова"), false, status);
    assert.equal(json.includes("вул."), false, status);
    assert.equal(json.includes(order.locationLabel), false, status);
  }

  for (const status of ["confirmed", "en_route", "started", "completed", "arbitration"]) {
    const payload = buildFor(status);
    const json = JSON.stringify(payload);
    assert.equal(json.includes("Тестова"), true, status);
    assert.equal(payload.location.addressLabel, "вул. Тестова 1, Полтава", status);
  }
});

test("performer post-confirm: exact geo/address are present", () => {
  for (const status of ["confirmed", "en_route", "started"]) {
    const payload = build({
      viewerRole: "performer",
      status,
      lock: { amount: PERFORMER_AMOUNT, status: "held" },
    });
    assert.equal(payload.location.lat, 49.5883, `${status} lat`);
    assert.equal(payload.location.lng, 34.5514, `${status} lng`);
    assert.equal(payload.location.addressLabel, "Поле біля Полтави", `${status} addressLabel`);
  }
});

test("customer always sees exact geo, even pre-confirm", () => {
  const payload = build({
    viewerRole: "customer",
    status: "accepted",
    lock: null,
  });
  assert.equal(payload.location.lat, 49.5883);
  assert.equal(payload.location.lng, 34.5514);
  assert.equal(payload.location.addressLabel, "Поле біля Полтави");
});
