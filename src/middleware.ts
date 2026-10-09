import { NextResponse, type NextRequest } from "next/server";
import { networkInterfaces } from "node:os";
import { idempotencyMiddleware } from "@/lib/middleware/idempotency";
import { retryAfterMiddleware } from "@/lib/middleware/retryAfter";

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function isNetworkOrBroadcastAddress(addr: string, netmask: string): boolean {
  const a = ipToInt(addr);
  const m = ipToInt(netmask);
  if (a === null || m === null) return false;
  if ((a & m) === a) return true;
  if (((a | m) >>> 0) === 0xffffffff) return true;
  return false;
}

function getLocalIPv4Addresses(): Set<string> {
  const ips = new Set<string>();
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family !== "IPv4" || net.internal) continue;
      if (net.netmask && isNetworkOrBroadcastAddress(net.address, net.netmask)) continue;
      ips.add(net.address);
    }
  }
  return ips;
}

const DEV_PORTS = [3000, 3001, 8081, 19006];
const STATIC_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
  "http://localhost:8081",
  "http://127.0.0.1:8081",
  "http://localhost:19006",
  "http://127.0.0.1:19006",
];

const LOCAL_IPS = getLocalIPv4Addresses();
const allowedOrigins = new Set<string>(STATIC_ORIGINS);
for (const ip of LOCAL_IPS) {
  for (const port of DEV_PORTS) {
    allowedOrigins.add(`http://${ip}:${port}`);
  }
}

function isPrivateNetworkOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return true;
    if (LOCAL_IPS.has(host)) return true;
    if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+$/.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

const IS_DEV = process.env.NODE_ENV !== "production";

function isOriginAllowed(origin: string): boolean {
  if (allowedOrigins.has(origin)) return true;
  // Security: RFC1918 fallback is dev-only; production must rely on the explicit allowlist above.
  if (IS_DEV && isPrivateNetworkOrigin(origin)) return true;
  return false;
}

if (IS_DEV && LOCAL_IPS.size > 0) {
  console.info(`[middleware] Detected LAN IPs: ${Array.from(LOCAL_IPS).join(", ")}`);
  console.info(`[middleware] CORS allowlist (incl. RFC1918 dev fallback): ${[...allowedOrigins].join(", ")}`);
}

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

// Node.js runtime is required: node:os (LAN IP detection) and ioredis
// (rate-limit/idempotency storage) are unavailable in the Edge runtime.
export const runtime = "nodejs";

export async function middleware(req: NextRequest) {
  // The config.matcher below scopes us to /api/*, but Node.js middleware
  // matchers are not applied by every Next.js serving path — enforce the
  // scope here so static assets and pages never hit rate-limit bookkeeping.
  if (!req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const origin = req.headers.get("origin");

  if (!origin || !isOriginAllowed(origin)) {
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
