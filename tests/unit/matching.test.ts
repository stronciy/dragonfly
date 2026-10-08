import test from "node:test";
import assert from "node:assert/strict";
import { formatOrderDateRange, performerCoversOrderSpecs, serviceTypeMatches } from "../../src/shared";
import { validatePerformerServiceSpecs } from "../../services-tree";

test("serviceTypeMatches should_match_when_performer_type_is_null", () => {
  assert.equal(serviceTypeMatches(null, "standard"), true);
});

test("serviceTypeMatches should_match_when_order_type_is_null", () => {
  assert.equal(serviceTypeMatches("standard", null), true);
});

test("serviceTypeMatches should_match_when_equal", () => {
  assert.equal(serviceTypeMatches("standard", "standard"), true);
});

test("serviceTypeMatches should_not_match_when_different", () => {
  assert.equal(serviceTypeMatches("standard", "reinforced"), false);
});

test("formatOrderDateRange should_return_null_when_both_null", () => {
  assert.equal(formatOrderDateRange(null, null), null);
});

test("formatOrderDateRange should_format_from_only", () => {
  assert.equal(formatOrderDateRange(new Date("2026-03-19T10:30:00Z"), null), "2026-03-19");
});

test("formatOrderDateRange should_format_to_only", () => {
  assert.equal(formatOrderDateRange(null, new Date("2026-03-20T10:30:00Z")), "2026-03-20");
});

test("formatOrderDateRange should_format_range", () => {
  assert.equal(
    formatOrderDateRange(new Date("2026-03-19T10:30:00Z"), new Date("2026-03-20T10:30:00Z")),
    "2026-03-19–2026-03-20"
  );
});

const ORDER_32 = {
  orderServiceTypeId: null as string | null,
  orderServiceSubCategoryId: "3.2",
  orderServiceCategoryId: "3",
  orderSpecs: { "Ширина внесення штанги (м)": 30, "Кліренс (см)": 175 },
};

test("performerCoversOrderSpecs wildcard when performer has no specs", () => {
  assert.equal(
    performerCoversOrderSpecs({ ...ORDER_32, performerServices: [{ serviceId: "3.2", specs: {} }] }),
    true
  );
  assert.equal(performerCoversOrderSpecs({ ...ORDER_32, performerServices: [] }), true);
});

test("performerCoversOrderSpecs true on exact cover", () => {
  assert.equal(
    performerCoversOrderSpecs({
      ...ORDER_32,
      performerServices: [
        { serviceId: "3.2", specs: { "Ширина внесення штанги (м)": 30, "Кліренс (см)": 175 } },
      ],
    }),
    true
  );
});

test("performerCoversOrderSpecs false on mismatch and missing key", () => {
  assert.equal(
    performerCoversOrderSpecs({
      ...ORDER_32,
      performerServices: [
        { serviceId: "3.2", specs: { "Ширина внесення штанги (м)": 18, "Кліренс (см)": 175 } },
      ],
    }),
    false
  );
  assert.equal(
    performerCoversOrderSpecs({
      ...ORDER_32,
      performerServices: [{ serviceId: "3.2", specs: { "Ширина внесення штанги (м)": 30 } }],
    }),
    false
  );
});

test("performerCoversOrderSpecs true when order has no required specs", () => {
  assert.equal(
    performerCoversOrderSpecs({
      orderServiceTypeId: null,
      orderServiceSubCategoryId: "1.1",
      orderServiceCategoryId: "1",
      orderSpecs: {},
      performerServices: [{ serviceId: "1.1", specs: {} }],
    }),
    true
  );
});

test("validatePerformerServiceSpecs accepts valid specs", () => {
  assert.deepEqual(
    validatePerformerServiceSpecs("3.2", { "Ширина внесення штанги (м)": 30, "Кліренс (см)": 175 }),
    []
  );
});

test("validatePerformerServiceSpecs rejects bad option and unknown id", () => {
  assert.ok(
    validatePerformerServiceSpecs("3.2", { "Ширина внесення штанги (м)": 31, "Кліренс (см)": 175 }).length > 0
  );
  assert.ok(validatePerformerServiceSpecs("9.9", {}).length > 0);
});

test("validatePerformerServiceSpecs rejects specs on category", () => {
  assert.ok(validatePerformerServiceSpecs("1", { foo: 1 }).length > 0);
  assert.deepEqual(validatePerformerServiceSpecs("1", {}), []);
});
