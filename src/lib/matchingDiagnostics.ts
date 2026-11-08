/**
 * Діагностика підбору заказу: для кожного виконавця показує, який саме критерій
 * не пройдено. Логіка повторює правила воркера matchNewOrder (послуга за
 * ієрархією тип → підкатегорія → категорія, покриття країна або радіус, не
 * відмовився, немає заблокованої застави). Характеристики техники тут не
 * перевіряються.
 */
export type DiagnosticOrder = {
  serviceCategoryId: string;
  serviceSubCategoryId: string;
  serviceTypeId: string | null;
  lat: number;
  lng: number;
  customerUserId: string;
};

export type DiagnosticPerformer = {
  userId: string;
  email: string;
  baseLatitude: number | null;
  baseLongitude: number | null;
  coverageMode: string | null;
  coverageRadiusKm: number | null;
  services: string[];
};

export type PerformerCheck = {
  performerUserId: string;
  email: string;
  eligible: boolean;
  reasons: string[];
  service: { matchedBy: "type" | "subcategory" | "category" | null; serviceId: string | null };
  coverage: { ok: boolean; mode: string | null; radiusKm: number | null; distanceKm: number | null };
  isCustomer: boolean;
  refused: boolean;
  blockedByEscrow: boolean;
  services: string[];
};

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function matchServiceLevel(
  order: Pick<DiagnosticOrder, "serviceCategoryId" | "serviceSubCategoryId" | "serviceTypeId">,
  services: string[]
): { matchedBy: PerformerCheck["service"]["matchedBy"]; serviceId: string | null } {
  const set = new Set(services);
  if (order.serviceTypeId && set.has(order.serviceTypeId)) return { matchedBy: "type", serviceId: order.serviceTypeId };
  if (set.has(order.serviceSubCategoryId)) return { matchedBy: "subcategory", serviceId: order.serviceSubCategoryId };
  if (set.has(order.serviceCategoryId)) return { matchedBy: "category", serviceId: order.serviceCategoryId };
  return { matchedBy: null, serviceId: null };
}

export function evaluatePerformer(
  order: DiagnosticOrder,
  performer: DiagnosticPerformer,
  state: { refused: boolean; blockedByEscrow: boolean }
): PerformerCheck {
  const reasons: string[] = [];
  const isCustomer = performer.userId === order.customerUserId;
  if (isCustomer) reasons.push("це заказчик цього заказу");

  const service = matchServiceLevel(order, performer.services);
  if (!service.matchedBy) reasons.push("немає потрібної послуги (тип, підкатегорія або категорія)");

  const mode = performer.coverageMode;
  const radiusKm = performer.coverageRadiusKm;
  let distanceKm: number | null = null;
  let coverageOk = false;
  if (mode === "country") {
    coverageOk = true;
  } else if (mode === "radius") {
    if (performer.baseLatitude == null || performer.baseLongitude == null) {
      reasons.push("немає базової точки для радіусу");
    } else if (radiusKm == null) {
      reasons.push("не задано радіус покриття");
    } else {
      distanceKm = haversineKm(performer.baseLatitude, performer.baseLongitude, order.lat, order.lng);
      coverageOk = distanceKm <= radiusKm;
      if (!coverageOk) reasons.push(`заказ за ${distanceKm.toFixed(1)} км, радіус ${radiusKm} км`);
    }
  } else {
    reasons.push(`невідомий режим покриття: ${mode ?? "не задано"}`);
  }

  if (state.refused) reasons.push("виконавець уже відмовився від цього заказу");
  if (state.blockedByEscrow) reasons.push("застава виконавця по заказу ще заблокована");

  return {
    performerUserId: performer.userId,
    email: performer.email,
    eligible: reasons.length === 0,
    reasons,
    service,
    coverage: { ok: coverageOk, mode, radiusKm, distanceKm: distanceKm == null ? null : Math.round(distanceKm * 10) / 10 },
    isCustomer,
    refused: state.refused,
    blockedByEscrow: state.blockedByEscrow,
    services: performer.services,
  };
}
