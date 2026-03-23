import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, infrastructureError, gatewayTimeoutError, badGatewayError, HTTP_STATUS, asApiError } from "../../src/lib/errors";

test("ApiError should have retryable flag defaulting to false", () => {
  const err = new ApiError(500, "INTERNAL_ERROR", "Test error");
  assert.equal(err.retryable, false);
});

test("ApiError should allow retryable flag to be set to true", () => {
  const err = new ApiError(503, "SERVICE_UNAVAILABLE", "Test error", undefined, true);
  assert.equal(err.retryable, true);
});

test("infrastructureError should create retryable 503 error", () => {
  const err = infrastructureError("Database connection failed");
  assert.equal(err.status, HTTP_STATUS.SERVICE_UNAVAILABLE);
  assert.equal(err.code, "SERVICE_UNAVAILABLE");
  assert.equal(err.retryable, true);
  assert.equal(err.message, "Database connection failed");
});

test("infrastructureError should include details when provided", () => {
  const details = { host: "db.example.com", port: 5432 };
  const err = infrastructureError("Database connection failed", details);
  assert.deepEqual(err.details, details);
});

test("gatewayTimeoutError should create retryable 504 error", () => {
  const err = gatewayTimeoutError("Upstream service timeout");
  assert.equal(err.status, HTTP_STATUS.GATEWAY_TIMEOUT);
  assert.equal(err.code, "GATEWAY_TIMEOUT");
  assert.equal(err.retryable, true);
  assert.equal(err.message, "Upstream service timeout");
});

test("badGatewayError should create non-retryable 502 error", () => {
  const err = badGatewayError("Application crash during request processing");
  assert.equal(err.status, HTTP_STATUS.BAD_GATEWAY);
  assert.equal(err.code, "BAD_GATEWAY");
  assert.equal(err.retryable, false);
  assert.equal(err.message, "Application crash during request processing");
});

test("asApiError should preserve ApiError instances", () => {
  const original = infrastructureError("Test");
  const converted = asApiError(original);
  assert.strictEqual(converted, original);
  assert.equal(converted.retryable, true);
});

test("asApiError should convert Error to non-retryable ApiError", () => {
  const original = new Error("Unexpected error");
  const converted = asApiError(original);
  assert.equal(converted.status, 500);
  assert.equal(converted.code, "INTERNAL_ERROR");
  assert.equal(converted.retryable, false);
  assert.equal(converted.message, "Unexpected error");
});

test("asApiError should handle unknown error types", () => {
  const converted = asApiError(null);
  assert.equal(converted.status, 500);
  assert.equal(converted.code, "INTERNAL_ERROR");
  assert.equal(converted.retryable, false);
});
