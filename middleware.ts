import { NextResponse, type NextRequest } from "next/server";

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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie, X-Requested-With, X-Request-Id",
    Vary: "Origin",
  };
}

export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");

  if (!origin || !allowedOrigins.has(origin)) {
    return NextResponse.next();
  }

  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: getCorsHeaders(origin) });
  }

  const res = NextResponse.next();
  const headers = getCorsHeaders(origin);
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: ["/api/:path*"],
};
