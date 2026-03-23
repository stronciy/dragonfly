"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const errors_1 = require("../../src/lib/errors");
(0, node_test_1.default)("ApiError should have retryable flag defaulting to false", () => {
    const err = new errors_1.ApiError(500, "INTERNAL_ERROR", "Test error");
    strict_1.default.equal(err.retryable, false);
});
(0, node_test_1.default)("ApiError should allow retryable flag to be set to true", () => {
    const err = new errors_1.ApiError(503, "SERVICE_UNAVAILABLE", "Test error", undefined, true);
    strict_1.default.equal(err.retryable, true);
});
(0, node_test_1.default)("infrastructureError should create retryable 503 error", () => {
    const err = (0, errors_1.infrastructureError)("Database connection failed");
    strict_1.default.equal(err.status, errors_1.HTTP_STATUS.SERVICE_UNAVAILABLE);
    strict_1.default.equal(err.code, "SERVICE_UNAVAILABLE");
    strict_1.default.equal(err.retryable, true);
    strict_1.default.equal(err.message, "Database connection failed");
});
(0, node_test_1.default)("infrastructureError should include details when provided", () => {
    const details = { host: "db.example.com", port: 5432 };
    const err = (0, errors_1.infrastructureError)("Database connection failed", details);
    strict_1.default.deepEqual(err.details, details);
});
(0, node_test_1.default)("gatewayTimeoutError should create retryable 504 error", () => {
    const err = (0, errors_1.gatewayTimeoutError)("Upstream service timeout");
    strict_1.default.equal(err.status, errors_1.HTTP_STATUS.GATEWAY_TIMEOUT);
    strict_1.default.equal(err.code, "GATEWAY_TIMEOUT");
    strict_1.default.equal(err.retryable, true);
    strict_1.default.equal(err.message, "Upstream service timeout");
});
(0, node_test_1.default)("badGatewayError should create non-retryable 502 error", () => {
    const err = (0, errors_1.badGatewayError)("Application crash during request processing");
    strict_1.default.equal(err.status, errors_1.HTTP_STATUS.BAD_GATEWAY);
    strict_1.default.equal(err.code, "BAD_GATEWAY");
    strict_1.default.equal(err.retryable, false);
    strict_1.default.equal(err.message, "Application crash during request processing");
});
(0, node_test_1.default)("asApiError should preserve ApiError instances", () => {
    const original = (0, errors_1.infrastructureError)("Test");
    const converted = (0, errors_1.asApiError)(original);
    strict_1.default.strictEqual(converted, original);
    strict_1.default.equal(converted.retryable, true);
});
(0, node_test_1.default)("asApiError should convert Error to non-retryable ApiError", () => {
    const original = new Error("Unexpected error");
    const converted = (0, errors_1.asApiError)(original);
    strict_1.default.equal(converted.status, 500);
    strict_1.default.equal(converted.code, "INTERNAL_ERROR");
    strict_1.default.equal(converted.retryable, false);
    strict_1.default.equal(converted.message, "Unexpected error");
});
(0, node_test_1.default)("asApiError should handle unknown error types", () => {
    const converted = (0, errors_1.asApiError)(null);
    strict_1.default.equal(converted.status, 500);
    strict_1.default.equal(converted.code, "INTERNAL_ERROR");
    strict_1.default.equal(converted.retryable, false);
});
