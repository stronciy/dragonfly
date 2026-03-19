"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const matching_1 = require("../../src/lib/matching");
(0, node_test_1.default)("serviceTypeMatches should_match_when_performer_type_is_null", () => {
    strict_1.default.equal((0, matching_1.serviceTypeMatches)(null, "standard"), true);
});
(0, node_test_1.default)("serviceTypeMatches should_match_when_order_type_is_null", () => {
    strict_1.default.equal((0, matching_1.serviceTypeMatches)("standard", null), true);
});
(0, node_test_1.default)("serviceTypeMatches should_match_when_equal", () => {
    strict_1.default.equal((0, matching_1.serviceTypeMatches)("standard", "standard"), true);
});
(0, node_test_1.default)("serviceTypeMatches should_not_match_when_different", () => {
    strict_1.default.equal((0, matching_1.serviceTypeMatches)("standard", "reinforced"), false);
});
(0, node_test_1.default)("formatOrderDateRange should_return_null_when_both_null", () => {
    strict_1.default.equal((0, matching_1.formatOrderDateRange)(null, null), null);
});
(0, node_test_1.default)("formatOrderDateRange should_format_from_only", () => {
    strict_1.default.equal((0, matching_1.formatOrderDateRange)(new Date("2026-03-19T10:30:00Z"), null), "2026-03-19");
});
(0, node_test_1.default)("formatOrderDateRange should_format_to_only", () => {
    strict_1.default.equal((0, matching_1.formatOrderDateRange)(null, new Date("2026-03-20T10:30:00Z")), "2026-03-20");
});
(0, node_test_1.default)("formatOrderDateRange should_format_range", () => {
    strict_1.default.equal((0, matching_1.formatOrderDateRange)(new Date("2026-03-19T10:30:00Z"), new Date("2026-03-20T10:30:00Z")), "2026-03-19–2026-03-20");
});
