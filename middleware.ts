import { NextResponse, type NextRequest } from "next/server";
import { idempotencyMiddleware } from "@/lib/middleware/idempotency";
import { retryAfterMiddleware } from "@/lib/middleware/retryAfter";

const allowedOrigins = new Set([
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://192.168.0.136:8081",
  "http://localhost:19006",
  "http://127.0.0.1:19006",
  "http://192.168.0.136:19006",
]);

function getCorsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie, X-Requested-With, X-Request-Id, X-Idempotency-Key",
    Vary: "Origin",
  };
}

async function runMiddlewareChain(req: NextRequest): Promise<NextResponse> {
  // Innermost handler - just proceed to the route
  const next = async () => NextResponse.next();

  // Build middleware chain (executed in reverse order for wrapping)
  // 1. Idempotency middleware wraps the route handler
  // 2. Retry-after middleware wraps idempotency
  const withIdempotency = async () => idempotencyMiddleware(req, next);
  const withRetryAfter = async () => retryAfterMiddleware(req, withIdempotency);

  return withRetryAfter();
}

export async function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");

  if (!origin || !allowedOrigins.has(origin)) {
    return runMiddlewareChain(req);
  }

  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: getCorsHeaders(origin) });
  }

  const response = await runMiddlewareChain(req);
  const headers = getCorsHeaders(origin);
  for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
