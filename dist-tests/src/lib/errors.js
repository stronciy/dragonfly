"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiError = exports.HTTP_STATUS = void 0;
exports.createRetryableError = createRetryableError;
exports.createNonRetryableError = createNonRetryableError;
exports.infrastructureError = infrastructureError;
exports.gatewayTimeoutError = gatewayTimeoutError;
exports.badGatewayError = badGatewayError;
exports.asApiError = asApiError;
/**
 * Standardized HTTP status codes for error handling:
 * - 503 Service Unavailable: Infrastructure issues (database, Redis, external services) - safe to retry
 * - 504 Gateway Timeout: Upstream service timeout - safe to retry
 * - 502 Bad Gateway: Application-level crash during request processing - do NOT retry blindly
 * - 500 Internal Server Error: Unexpected application errors - do NOT retry blindly
 */
exports.HTTP_STATUS = {
    SERVICE_UNAVAILABLE: 503,
    GATEWAY_TIMEOUT: 504,
    BAD_GATEWAY: 502,
    INTERNAL_ERROR: 500,
};
class ApiError extends Error {
    status;
    code;
    details;
    retryable;
    constructor(status, code, message, details, 
    /**
     * Whether this error is safe to retry.
     * - true: Transient error, retry may succeed
     * - false: Non-transient error, retry will likely fail again
     */
    retryable = false) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
        this.retryable = retryable;
    }
}
exports.ApiError = ApiError;
/**
 * Create a retryable error for infrastructure/transient failures.
 * Clients can safely retry these requests (preferably with idempotency keys for state-changing ops).
 */
function createRetryableError(status, code, message, details) {
    return new ApiError(status, code, message, details, true);
}
/**
 * Create a non-retryable error for application-level failures.
 * Clients should NOT retry these blindly; they indicate logical errors or unexpected crashes.
 */
function createNonRetryableError(status, code, message, details) {
    return new ApiError(status, code, message, details, false);
}
/**
 * Infrastructure errors (database, Redis, external APIs) - retryable with 503
 */
function infrastructureError(message, details) {
    return createRetryableError(exports.HTTP_STATUS.SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE", message, details);
}
/**
 * Gateway timeout errors - retryable with 504
 */
function gatewayTimeoutError(message, details) {
    return createRetryableError(exports.HTTP_STATUS.GATEWAY_TIMEOUT, "GATEWAY_TIMEOUT", message, details);
}
/**
 * Application-level crash during request processing - NOT retryable with 502
 */
function badGatewayError(message, details) {
    return createNonRetryableError(exports.HTTP_STATUS.BAD_GATEWAY, "BAD_GATEWAY", message, details);
}
function asApiError(err) {
    if (err instanceof ApiError)
        return err;
    if (err instanceof Error) {
        // Default to non-retryable for unexpected application errors
        return new ApiError(500, "INTERNAL_ERROR", err.message, undefined, false);
    }
    return new ApiError(500, "INTERNAL_ERROR", "Unknown error", undefined, false);
}
