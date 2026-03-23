import { NextResponse } from "next/server";
import { asApiError, ApiError } from "./errors";

type SuccessBody<T> = {
  success: true;
  code: "SUCCESS";
  data: T;
  message: string;
  timestamp: string;
  requestId: string;
};

type ErrorBody = {
  success: false;
  code: string;
  error?: {
    type: string;
    details?: unknown;
  };
  message: string;
  timestamp: string;
  requestId: string;
};

export function getRequestId(req: Request) {
  return req.headers.get("x-request-id") ?? crypto.randomUUID();
}

export function ok<T>(
  req: Request,
  data: T,
  init?: { status?: number; message?: string; headers?: HeadersInit }
) {
  const requestId = getRequestId(req);
  const status = init?.status ?? 200;
  const headers = new Headers(init?.headers);
  headers.set("x-request-id", requestId);

  if (status === 204 || status === 205) {
    return new NextResponse(null, { status, headers });
  }

  const body: SuccessBody<T> = {
    success: true,
    code: "SUCCESS",
    data,
    message: init?.message ?? "OK",
    timestamp: new Date().toISOString(),
    requestId,
  };
  return NextResponse.json(body, { status, headers });
}

/**
 * Default retry-after seconds for retryable errors.
 * Clients can use this as a baseline for exponential backoff.
 */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export function fail(req: Request, err: unknown) {
  const requestId = getRequestId(req);
  const apiErr = asApiError(err);

  const body: ErrorBody = {
    success: false,
    code: apiErr.code,
    error: {
      type: apiErr.name || "Error",
      details: apiErr.details,
    },
    message: apiErr.message,
    timestamp: new Date().toISOString(),
    requestId,
  };

  if (process.env.NODE_ENV !== "production" && apiErr.code === "VALIDATION_ERROR") {
    console.warn(`[api] ${req.method} ${new URL(req.url).pathname} ${apiErr.status} ${apiErr.code} requestId=${requestId}`, apiErr.details);
  }

  const headers = new Headers();
  
  // Add Retry-After header for retryable errors (503, 504, 429)
  if (apiErr instanceof ApiError && apiErr.retryable) {
    headers.set("retry-after", String(DEFAULT_RETRY_AFTER_SECONDS));
  } else if (apiErr.status === 429 || apiErr.status === 503) {
    headers.set("retry-after", String(DEFAULT_RETRY_AFTER_SECONDS));
  }

  // Add header to indicate if error is retryable
  if (apiErr instanceof ApiError) {
    headers.set("x-error-retryable", String(apiErr.retryable));
  }

  return NextResponse.json(body, { status: apiErr.status, headers });
}
