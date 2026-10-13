/**
 * Performer-facing marketplace visibility gating.
 *
 * A performer browsing the marketplace (or holding only an `orderMatch` row)
 * must NOT see the customer's exact address, coordinates, or identity before
 * the order is committed (deposit paid → `confirmed`). Pre-confirm they see
 * only a COARSE location label derived from region/settlement + `distanceKm`.
 *
 * IMPORTANT (T21): in this schema `Order.locationLabel` IS the exact address
 * (both create/update routes store `body.location.addressLabel` into it).
 * Therefore masked payloads MUST NOT echo `locationLabel` — they use
 * `coarseLocationLabel()` instead, which is derived ONLY from
 * `regionName`/`settlementName`. The raw address is never emitted in any field
 * pre-confirm.
 *
 * Enforced at the payload level (server-side) — never rely on the app to hide
 * fields that were already sent.
 */

/**
 * Order statuses for which the assigned performer may see the full address and
 * coordinates. Everything else (draft/published/accepted/requires_confirmation/
 * cancelled) is coarse-only.
 *
 * NOTE: `confirmed` is the gate — it is reached only after the customer pays
 * their first deposit, i.e. the deal is real. `en_route`/`started`/`completed`/
 * `arbitration` are post-confirm lifecycle states.
 */
export const PERFORMER_LOCATION_REVEAL_STATUSES = [
  "confirmed",
  "en_route",
  "started",
  "completed",
  "arbitration",
] as const;

export type PerformerLocationRevealStatus =
  (typeof PERFORMER_LOCATION_REVEAL_STATUSES)[number];

export function isPerformerLocationRevealed(status: string): boolean {
  return (PERFORMER_LOCATION_REVEAL_STATUSES as readonly string[]).includes(
    status
  );
}

export interface MarketplaceLocationSource {
  status: string;
  locationLabel: string;
  regionName: string | null;
  settlementName?: string | null;
  lat: number;
  lng: number;
}

/** Fallback shown when an order has neither a region nor a settlement. */
export const MASKED_LOCATION_LABEL_FALLBACK =
  "Місце приховано до підтвердження застави";

export interface CoarseLocationSource {
  regionName: string | null;
  settlementName?: string | null;
}

/**
 * The single source of truth for the pre-confirm (coarse) location label.
 *
 * Derived ONLY from `regionName` + `settlementName` — NEVER from
 * `locationLabel`, which in this schema is the exact street address. Both the
 * marketplace masks (`maskOrderLocationForMarketplace`) and the order-detail
 * read model (`buildLocation`) call this, so the derivation cannot drift.
 *
 * Product decision: a settlement (населений пункт) is treated as coarse — the
 * exact address is the street/house held in `locationLabel`. If that is ever
 * deemed sensitive, dropping `settlementName` here narrows every masked payload
 * to `regionName` only (see `.sisyphus/notepads/deal-flow-rework/decisions.md`).
 */
export function coarseLocationLabel(source: CoarseLocationSource): string {
  const parts = [source.regionName, source.settlementName]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(", ") : MASKED_LOCATION_LABEL_FALLBACK;
}

export interface MarketplaceLocationView {
  locationLabel: string;
  regionName: string | null;
  addressLabel?: string;
  location: {
    locationLabel: string;
    regionName: string | null;
    addressLabel?: string;
    lat?: number;
    lng?: number;
  };
}

export interface MaskOrderLocationOptions {
  /**
   * Whether the requester is the order's assigned performer. A matched-but-not-
   * assigned performer (marketplace discovery) must stay masked even if the
   * order later reaches a reveal status. Defaults to `true` (status-driven).
   */
  assigned?: boolean;
}

/**
 * Build the marketplace-visible location block for an order.
 *
 * - Not revealed (status pre-confirm, or `assigned: false`): only the COARSE
 *   label (`coarseLocationLabel`) + `regionName` — no `addressLabel`, no
 *   `lat`/`lng` (the keys are omitted entirely, so they never appear in the
 *   JSON), and `locationLabel` is the coarse label, NOT the exact address.
 * - Revealed (assigned performer AND status ∈ reveal set): full block incl.
 *   `addressLabel` + coordinates; `locationLabel` is the exact address.
 *
 * `addressLabel` is derived from `locationLabel` (the schema has no separate
 * exact-address column); pre-confirm it is dropped regardless.
 */
export function maskOrderLocationForMarketplace(
  order: MarketplaceLocationSource,
  options: MaskOrderLocationOptions = {}
): MarketplaceLocationView {
  const regionName = order.regionName ?? null;
  const revealed =
    (options.assigned ?? true) && isPerformerLocationRevealed(order.status);

  if (!revealed) {
    const locationLabel = coarseLocationLabel(order);
    return {
      locationLabel,
      regionName,
      location: {
        locationLabel,
        regionName,
      },
    };
  }

  const addressLabel = order.locationLabel;
  return {
    locationLabel: order.locationLabel,
    regionName,
    addressLabel,
    location: {
      locationLabel: order.locationLabel,
      regionName,
      addressLabel,
      lat: Number(order.lat),
      lng: Number(order.lng),
    },
  };
}

/**
 * Great-circle distance in km (haversine), matching the SQL formula used by
 * the matcher:
 *   6371 * acos(cos(lat1)*cos(lat2)*cos(lng2-lng1) + sin(lat1)*sin(lat2))
 *
 * Distance is a coarse, intentionally-retained signal pre-confirm — it never
 * reveals the exact point, only how far the order is from the performer's base.
 */
export function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const a =
    sinLat * sinLat +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * sinLng * sinLng;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distance from the performer's base to the order, rounded to 2 decimals.
 * Returns `null` when the performer has no base coordinates (country coverage).
 */
export function marketplaceDistanceKm(
  base: { baseLatitude: number | null; baseLongitude: number | null },
  target: { lat: number; lng: number }
): number | null {
  if (base.baseLatitude == null || base.baseLongitude == null) return null;
  return (
    Math.round(
      haversineKm(base.baseLatitude, base.baseLongitude, target.lat, target.lng) *
        100
    ) / 100
  );
}
