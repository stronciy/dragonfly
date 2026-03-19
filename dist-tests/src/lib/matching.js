"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serviceTypeMatches = serviceTypeMatches;
exports.formatOrderDateRange = formatOrderDateRange;
function serviceTypeMatches(performerServiceTypeId, orderServiceTypeId) {
    if (performerServiceTypeId == null)
        return true;
    if (orderServiceTypeId == null)
        return true;
    return performerServiceTypeId === orderServiceTypeId;
}
function formatOrderDateRange(dateFrom, dateTo) {
    if (!dateFrom && !dateTo)
        return null;
    const from = dateFrom ? dateFrom.toISOString().slice(0, 10) : null;
    const to = dateTo ? dateTo.toISOString().slice(0, 10) : null;
    if (from && to)
        return `${from}–${to}`;
    return from ?? to;
}
