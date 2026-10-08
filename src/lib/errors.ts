export type ApiErrorCode =
  | "SUCCESS"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "SERVICE_UNAVAILABLE"
  | "GATEWAY_TIMEOUT"
  | "BAD_GATEWAY"
  | "INTERNAL_ERROR";

/**
 * Standardized HTTP status codes for error handling:
 * - 503 Service Unavailable: Infrastructure issues (database, Redis, external services) - safe to retry
 * - 504 Gateway Timeout: Upstream service timeout - safe to retry
 * - 502 Bad Gateway: Application-level crash during request processing - do NOT retry blindly
 * - 500 Internal Server Error: Unexpected application errors - do NOT retry blindly
 */
export const HTTP_STATUS = {
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
  BAD_GATEWAY: 502,
  INTERNAL_ERROR: 500,
} as const;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
    public details?: unknown,
    /**
     * Whether this error is safe to retry.
     * - true: Transient error, retry may succeed
     * - false: Non-transient error, retry will likely fail again
     */
    public retryable: boolean = false
  ) {
    super(message);
  }
}

/**
 * Create a retryable error for infrastructure/transient failures.
 * Clients can safely retry these requests (preferably with idempotency keys for state-changing ops).
 */
export function createRetryableError(
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: unknown
): ApiError {
  return new ApiError(status, code, message, details, true);
}

/**
 * Create a non-retryable error for application-level failures.
 * Clients should NOT retry these blindly; they indicate logical errors or unexpected crashes.
 */
export function createNonRetryableError(
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: unknown
): ApiError {
  return new ApiError(status, code, message, details, false);
}

/**
 * Infrastructure errors (database, Redis, external APIs) - retryable with 503
 */
export function infrastructureError(message: string, details?: unknown): ApiError {
  return createRetryableError(
    HTTP_STATUS.SERVICE_UNAVAILABLE,
    "SERVICE_UNAVAILABLE",
    message,
    details
  );
}

/**
 * Gateway timeout errors - retryable with 504
 */
export function gatewayTimeoutError(message: string, details?: unknown): ApiError {
  return createRetryableError(
    HTTP_STATUS.GATEWAY_TIMEOUT,
    "GATEWAY_TIMEOUT",
    message,
    details
  );
}

/**
 * Application-level crash during request processing - NOT retryable with 502
 */
export function badGatewayError(message: string, details?: unknown): ApiError {
  return createNonRetryableError(
    HTTP_STATUS.BAD_GATEWAY,
    "BAD_GATEWAY",
    message,
    details
  );
}

export function asApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof Error) {
    // Default to non-retryable for unexpected application errors
    return new ApiError(500, "INTERNAL_ERROR", err.message, undefined, false);
  }
  return new ApiError(500, "INTERNAL_ERROR", "Unknown error", undefined, false);
}
