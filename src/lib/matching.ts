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
