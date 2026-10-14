import test from "node:test";
import assert from "node:assert/strict";
import {
  MASKED_LOCATION_LABEL_FALLBACK,
  PERFORMER_LOCATION_REVEAL_STATUSES,
  coarseLocationLabel,
  haversineKm,
  isPerformerLocationRevealed,
  marketplaceDistanceKm,
  maskOrderLocationForMarketplace,
} from "../../src/lib/marketplaceVisibility";

const PRE_CONFIRM_STATUSES = [
  "draft",
  "published",
  "accepted",
  "requires_confirmation",
  "cancelled",
];

const ORDER = {
  status: "published",
  locationLabel: "Полтавська обл., с. Іванівка, вул. Садова 12",
  regionName: "Полтавська область",
  lat: 49.5883,
  lng: 34.5514,
};

function keys(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>).sort();
}

test("isPerformerLocationRevealed gates exactly the post-confirm statuses", () => {
  for (const status of ["confirmed", "en_route", "started", "completed", "arbitration"]) {
    assert.equal(isPerformerLocationRevealed(status), true, status);
  }
  for (const status of PRE_CONFIRM_STATUSES) {
    assert.equal(isPerformerLocationRevealed(status), false, status);
  }
  assert.deepEqual([...PERFORMER_LOCATION_REVEAL_STATUSES], [
    "confirmed",
    "en_route",
    "started",
    "completed",
    "arbitration",
  ]);
});

test("pre-confirm masking drops addressLabel, coordinates and region from the JSON", () => {
  for (const status of PRE_CONFIRM_STATUSES) {
    const view = maskOrderLocationForMarketplace({ ...ORDER, status });
    const parsed = JSON.parse(JSON.stringify(view));

    assert.equal("addressLabel" in parsed, false, status);
    assert.equal("lat" in parsed.location, false, status);
    assert.equal("lng" in parsed.location, false, status);
    assert.equal("addressLabel" in parsed.location, false, status);

    assert.equal("regionName" in parsed, false, status);
    assert.equal("regionName" in parsed.location, false, status);
    assert.equal(parsed.locationLabel, MASKED_LOCATION_LABEL_FALLBACK, status);
    assert.equal(parsed.location.locationLabel, MASKED_LOCATION_LABEL_FALLBACK, status);
  }
});

test("reveal statuses include full address and coordinates", () => {
  for (const status of PERFORMER_LOCATION_REVEAL_STATUSES) {
    const view = maskOrderLocationForMarketplace({ ...ORDER, status });
    const parsed = JSON.parse(JSON.stringify(view));

    assert.equal(typeof parsed.addressLabel, "string", status);
    assert.equal(parsed.location.lat, ORDER.lat, status);
    assert.equal(parsed.location.lng, ORDER.lng, status);
    assert.equal(parsed.location.addressLabel, ORDER.locationLabel, status);
  }
});

test("matched-but-unassigned performer stays masked even on a confirmed order", () => {
  const view = maskOrderLocationForMarketplace(
    { ...ORDER, status: "confirmed" },
    { assigned: false }
  );
  const parsed = JSON.parse(JSON.stringify(view));
  assert.equal("addressLabel" in parsed, false);
  assert.equal("lat" in parsed.location, false);
  assert.equal("lng" in parsed.location, false);
});

const ADDRESS_ORDER = {
  status: "published",
  locationLabel: "вул. Тестова 1, Полтава",
  regionName: "Полтавська область",
  settlementName: "Полтава",
  lat: 49.5883,
  lng: 34.5514,
};

test("pre-confirm mask never leaks the exact address substring", () => {
  const SECRET = "Тестова";
  const maskedCases: Array<{ status: string; assigned: boolean }> = [
    ...PRE_CONFIRM_STATUSES.map((status) => ({ status, assigned: true })),
    { status: "confirmed", assigned: false },
  ];

  for (const { status, assigned } of maskedCases) {
    const json = JSON.stringify(
      maskOrderLocationForMarketplace({ ...ADDRESS_ORDER, status }, { assigned })
    );
    const label = `${status}/assigned=${assigned}`;
    assert.equal(json.includes(SECRET), false, label);
    assert.equal(json.includes("вул."), false, label);
    assert.equal(json.includes(ADDRESS_ORDER.locationLabel), false, label);
  }

  for (const status of PERFORMER_LOCATION_REVEAL_STATUSES) {
    const json = JSON.stringify(
      maskOrderLocationForMarketplace({ ...ADDRESS_ORDER, status })
    );
    assert.equal(json.includes(SECRET), true, status);
    assert.equal(json.includes(ADDRESS_ORDER.locationLabel), true, status);
  }
});

test("coarseLocationLabel composes region + settlement but the masked view never exposes it", () => {
  assert.equal(
    coarseLocationLabel({ regionName: "Полтавська область", settlementName: "Полтава" }),
    "Полтавська область, Полтава"
  );
  assert.equal(
    coarseLocationLabel({ regionName: null, settlementName: null }),
    MASKED_LOCATION_LABEL_FALLBACK
  );

  const masked = maskOrderLocationForMarketplace(ADDRESS_ORDER, { assigned: false });
  assert.equal(masked.locationLabel, MASKED_LOCATION_LABEL_FALLBACK);
});

test("raw marketplace detail payload: published has no geo, confirmed does", () => {
  const buildPayload = (status: string) => ({
    order: {
      id: "ord_1",
      status,
      budget: 100000,
      distanceKm: 12.5,
      ...maskOrderLocationForMarketplace({ ...ORDER, status }, { assigned: true }),
    },
  });

  const published = JSON.parse(JSON.stringify(buildPayload("published"))).order;
  assert.equal("lat" in published, false);
  assert.equal("lng" in published, false);
  assert.equal("lat" in published.location, false);
  assert.equal("lng" in published.location, false);
  assert.equal("addressLabel" in published, false);
  assert.equal("addressLabel" in published.location, false);
  assert.equal("phone" in published, false);
  assert.equal("customerPhone" in published, false);
  assert.equal(published.locationLabel, MASKED_LOCATION_LABEL_FALLBACK);
  assert.equal("regionName" in published, false);
  assert.equal(published.distanceKm, 12.5);

  const confirmed = JSON.parse(JSON.stringify(buildPayload("confirmed"))).order;
  assert.equal(confirmed.location.lat, ORDER.lat);
  assert.equal(confirmed.location.lng, ORDER.lng);
  assert.equal(typeof confirmed.addressLabel, "string");
  assert.equal(confirmed.addressLabel, ORDER.locationLabel);
});

test("raw marketplace list payload: published row has coarse fields + distance only", () => {
  const item = {
    id: "ord_1",
    orderId: "ord_1",
    status: "published",
    distanceKm: 4.2,
    ...maskOrderLocationForMarketplace({ ...ORDER, status: "published" }, { assigned: false }),
  };
  const parsed = JSON.parse(JSON.stringify(item));
  assert.equal(keys(parsed.location).includes("lat"), false);
  assert.equal(keys(parsed.location).includes("lng"), false);
  assert.equal(keys(parsed).includes("addressLabel"), false);
  assert.equal(parsed.locationLabel, MASKED_LOCATION_LABEL_FALLBACK);
  assert.equal(parsed.distanceKm, 4.2);
});

test("masked view omits regionName and never resurrects coordinates", () => {
  const view = maskOrderLocationForMarketplace({
    ...ORDER,
    status: "published",
    regionName: null,
  });
  assert.equal("regionName" in view, false);
  assert.equal("regionName" in view.location, false);
  assert.equal("lat" in view.location, false);
});

test("haversineKm matches known distances", () => {
  assert.equal(haversineKm(49.5883, 34.5514, 49.5883, 34.5514), 0);
  const oneDegreeLat = haversineKm(0, 0, 1, 0);
  assert.ok(Math.abs(oneDegreeLat - 111.19) < 0.1, `got ${oneDegreeLat}`);
  assert.equal(
    haversineKm(49.5883, 34.5514, 50.4501, 30.5234) > 0,
    haversineKm(50.4501, 30.5234, 49.5883, 34.5514) > 0
  );
  const there = haversineKm(49.5883, 34.5514, 50.4501, 30.5234);
  const back = haversineKm(50.4501, 30.5234, 49.5883, 34.5514);
  assert.ok(Math.abs(there - back) < 1e-9);
});

test("marketplaceDistanceKm rounds and returns null without a base", () => {
  const d = marketplaceDistanceKm(
    { baseLatitude: 49.5883, baseLongitude: 34.5514 },
    { lat: 49.6, lng: 34.5 }
  );
  assert.equal(typeof d, "number");
  assert.equal(d, Math.round((d as number) * 100) / 100);

  assert.equal(
    marketplaceDistanceKm(
      { baseLatitude: null, baseLongitude: 34.5 },
      { lat: 49.6, lng: 34.5 }
    ),
    null
  );
  assert.equal(
    marketplaceDistanceKm(
      { baseLatitude: 49.6, baseLongitude: null },
      { lat: 49.6, lng: 34.5 }
    ),
    null
  );
});
