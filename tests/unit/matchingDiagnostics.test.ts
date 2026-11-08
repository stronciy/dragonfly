import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePerformer, haversineKm, matchServiceLevel, type DiagnosticOrder } from "../../src/lib/matchingDiagnostics";

const KYIV = { lat: 50.4501, lng: 30.5234 };
const order: DiagnosticOrder = {
  serviceCategoryId: "1",
  serviceSubCategoryId: "1.1",
  serviceTypeId: null,
  lat: KYIV.lat + 149 / 111.195,
  lng: KYIV.lng,
  customerUserId: "customer-1",
};
const base = {
  userId: "p1",
  email: "p1@test.local",
  baseLatitude: KYIV.lat,
  baseLongitude: KYIV.lng,
  coverageMode: "radius",
  coverageRadiusKm: 150,
  services: ["1"],
};
const free = { refused: false, blockedByEscrow: false };

test("категорія виконавця покриває заказ її підкатегорії", () => {
  assert.deepEqual(matchServiceLevel(order, ["1"]), { matchedBy: "category", serviceId: "1" });
  assert.deepEqual(matchServiceLevel(order, ["1.1"]), { matchedBy: "subcategory", serviceId: "1.1" });
  assert.deepEqual(matchServiceLevel(order, ["2.1.2"]), { matchedBy: null, serviceId: null });
});

test("тип має пріоритет над підкатегорією", () => {
  const typed = { ...order, serviceTypeId: "1.1.1" };
  assert.equal(matchServiceLevel(typed, ["1.1.1", "1.1"]).matchedBy, "type");
});

test("радіус 150 км: 149 км підходить, 151 км ні", () => {
  assert.equal(evaluatePerformer(order, base, free).eligible, true);
  const far = { ...order, lat: KYIV.lat + 151 / 111.195 };
  const check = evaluatePerformer(far, base, free);
  assert.equal(check.eligible, false);
  assert.match(check.reasons.join(" "), /радіус 150 км/);
});

test("режим «вся Україна» не залежить від відстані", () => {
  const check = evaluatePerformer(order, { ...base, coverageMode: "country", coverageRadiusKm: null, baseLatitude: null, baseLongitude: null }, free);
  assert.equal(check.eligible, true);
});

test("радіус без базової точки не проходить з явною причиною", () => {
  const check = evaluatePerformer(order, { ...base, baseLatitude: null }, free);
  assert.equal(check.eligible, false);
  assert.match(check.reasons.join(" "), /базової точки/);
});

test("відмовлений і заблокований виконавець не підбирається", () => {
  assert.match(evaluatePerformer(order, base, { refused: true, blockedByEscrow: false }).reasons.join(" "), /відмовився/);
  assert.match(evaluatePerformer(order, base, { refused: false, blockedByEscrow: true }).reasons.join(" "), /застава/);
});

test("заказчик не отримує власний заказ", () => {
  const check = evaluatePerformer(order, { ...base, userId: "customer-1" }, free);
  assert.equal(check.eligible, false);
  assert.equal(check.isCustomer, true);
});

test("відстань Haversine: Київ — Полтава близько 300 км", () => {
  const d = haversineKm(50.4501, 30.5234, 49.5883, 34.5514);
  assert.ok(d > 290 && d < 320, `отримано ${d}`);
});
