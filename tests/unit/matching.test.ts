import test from "node:test";
import assert from "node:assert/strict";
import { formatOrderDateRange, serviceTypeMatches } from "../../src/lib/matching";

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
