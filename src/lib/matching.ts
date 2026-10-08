import { getRequiredSpecs } from "../../services-tree";

export function serviceTypeMatches(performerServiceTypeId: string | null, orderServiceTypeId: string | null) {
  if (performerServiceTypeId == null) return true;
  if (orderServiceTypeId == null) return true;
  return performerServiceTypeId === orderServiceTypeId;
}

export function formatOrderDateRange(dateFrom: Date | null, dateTo: Date | null) {
  if (!dateFrom && !dateTo) return null;
  const from = dateFrom ? dateFrom.toISOString().slice(0, 10) : null;
  const to = dateTo ? dateTo.toISOString().slice(0, 10) : null;
  if (from && to) return `${from}–${to}`;
  return from ?? to;
}

export type PerformerServiceSpecs = {
  serviceId: string;
  specs: Record<string, unknown>;
};

function specValuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return a === b;
}

/**
 * Coverage rule: a performer matches an order's specs when, on the most
 * specific service of theirs covering the order (type > subcategory >
 * category), every spec the order requires is present with an equal value.
 * No specs on any covering service = wildcard (matches anything, keeps
 * pre-specs performers working). A missing order spec value never blocks.
 */
export function performerCoversOrderSpecs(args: {
  orderServiceTypeId: string | null;
  orderServiceSubCategoryId: string;
  orderServiceCategoryId: string;
  orderSpecs: Record<string, unknown>;
  performerServices: PerformerServiceSpecs[];
}): boolean {
  const required = getRequiredSpecs(args.orderServiceTypeId, args.orderServiceSubCategoryId);
  if (required.length === 0) return true;
  const chain = [args.orderServiceTypeId, args.orderServiceSubCategoryId, args.orderServiceCategoryId].filter(
    (v): v is string => !!v
  );
  const byId = new Map(args.performerServices.map((s) => [s.serviceId, s.specs ?? {}]));
  const covering = chain
    .map((id) => byId.get(id))
    .find((specs) => specs && Object.keys(specs).length > 0);
  if (!covering) return true;
  return required.every((spec) => {
    const orderValue = args.orderSpecs[spec.name];
    if (orderValue === undefined || orderValue === null || orderValue === "") return true;
    const performerValue = covering[spec.name];
    if (performerValue === undefined || performerValue === null || performerValue === "") return false;
    return specValuesEqual(performerValue, orderValue);
  });
}
