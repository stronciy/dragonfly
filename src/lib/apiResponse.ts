import { NextResponse } from "next/server";
import { asApiError } from "./errors";

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
  const body: SuccessBody<T> = {
    success: true,
    code: "SUCCESS",
    data,
    message: init?.message ?? "OK",
    timestamp: new Date().toISOString(),
    requestId,
  };
  return NextResponse.json(body, { status: init?.status ?? 200, headers: init?.headers });
}

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

  return NextResponse.json(body, { status: apiErr.status });
}
