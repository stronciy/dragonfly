import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import Redis from "ioredis";
import { jwtVerify } from "jose";

const RATE_LIMIT_KEY_PREFIX = "ratelimit:";
const DEFAULT_WINDOW_SECONDS = 60;
const USER_MAX_REQUESTS = 600; // 10 req/s sustained для авторизованих користувачів
const IP_MAX_REQUESTS = 180;   // 3 req/s для неавторизованих IP
const DEV_MAX_REQUESTS = 3000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

let cachedJwtSecret: Uint8Array | null = null;
function getJwtSecret(): Uint8Array {
  if (!cachedJwtSecret) {
    cachedJwtSecret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET || "");
  }
  return cachedJwtSecret;
}

let redisClient: Redis | null = null;
let redisInitAttempted = false;

function getRedisClient(): Redis | null {
  if (redisInitAttempted) return redisClient;
  
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    redisInitAttempted = true;
    return null;
  }

  try {
    redisClient = new Redis(redisUrl, {
      enableReadyCheck: true,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    
    redisClient.on("error", () => {
      redisClient = null;
    });
    
    redisInitAttempted = true;
    return redisClient;
  } catch {
    redisInitAttempted = true;
    return null;
  }
}

function getRequestId(req: NextRequest): string {
  return req.headers.get("x-request-id") ?? crypto.randomUUID();
}

function getClientIdentifier(req: NextRequest): string {
  // Security: rate-limit bucket must not be client-rotatable. X-Real-IP is
  // (re)set by our edge proxy and the client cannot forge it, while the head
  // of X-Forwarded-For is fully client-controlled when the proxy appends.
  const realIp = req.headers.get("x-real-ip");
  if (realIp && realIp.trim()) return realIp.trim();
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    // Right-most entry is appended by our own proxy — unforgeable from outside.
    if (ips.length > 0) return ips[ips.length - 1];
  }
  return "unknown";
}

async function getUserId(req: NextRequest): Promise<string | null> {
  try {
    const authHeader = req.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const secret = getJwtSecret();
      if (!secret.length) return null;
      const token = authHeader.slice("Bearer ".length);
      const { payload } = await jwtVerify(token, secret);
      if (payload && typeof payload.userId === "string") {
        return payload.userId;
      }
    }
  } catch {
    // Token verification failed
  }
  return null;
}

function getRateLimitKey(identifier: string, userId?: string | null): string {
  return userId
    ? `${RATE_LIMIT_KEY_PREFIX}user:${userId}`
    : `${RATE_LIMIT_KEY_PREFIX}ip:${identifier}`;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

async function checkRateLimit(
  key: string,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
  maxRequests: number = USER_MAX_REQUESTS
): Promise<RateLimitResult> {
  const redis = getRedisClient();
  if (!redis) {
    return { allowed: true, remaining: maxRequests, resetAt: Date.now() + windowSeconds * 1000 };
  }

  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const windowStart = now - windowMs;
  const memberId = `${now}-${crypto.randomUUID()}`;

  const multi = redis.multi();
  multi.zremrangebyscore(key, 0, windowStart);
  multi.zadd(key, now, memberId);
  multi.zcard(key);
  multi.expire(key, windowSeconds);

  const results = await multi.exec();
  const count = results?.[2]?.[1] as number ?? 0;
  const remaining = Math.max(0, maxRequests - count);
  const resetAt = now + windowMs;

  if (count > maxRequests) {
    // ВАЖЛИВО: видаляємо щойно доданий запис з Redis, щоб заблоковані запити
    // не збільшували лічильник нескінченно і не продовжували блокування
    await redis.zrem(key, memberId).catch(() => {});

    const oldestMember = await redis.zrange(key, 0, 0) as string[];
    const oldestTimestamp = oldestMember?.[0] ? parseFloat(oldestMember[0].split("-")[0]) : now;
    const retryAfter = Math.ceil((oldestTimestamp + windowMs - now) / 1000);

    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfter: Math.max(1, retryAfter),
    };
  }

  return { allowed: true, remaining, resetAt };
}

export async function retryAfterMiddleware(
  req: NextRequest,
  next: () => Promise<NextResponse>
): Promise<NextResponse> {
  const requestId = getRequestId(req);
  const identifier = getClientIdentifier(req);
  const userId = await getUserId(req);
  const rateLimitKey = getRateLimitKey(identifier, userId);

  const isDev = process.env.NODE_ENV !== "production";
  const maxRequests = isDev ? DEV_MAX_REQUESTS : (userId ? USER_MAX_REQUESTS : IP_MAX_REQUESTS);

  const rateLimitResult = await checkRateLimit(rateLimitKey, DEFAULT_WINDOW_SECONDS, maxRequests);

  if (!rateLimitResult.allowed) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[ratelimit] Rate limit exceeded requestId=${requestId} identifier=${identifier} userId=${userId || 'none'} retryAfter=${rateLimitResult.retryAfter}`
      );
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("retry-after", String(rateLimitResult.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS));
    headers.set("x-ratelimit-limit", String(maxRequests));
    headers.set("x-ratelimit-remaining", "0");
    headers.set("x-ratelimit-reset", String(rateLimitResult.resetAt));

    return NextResponse.json(
      {
        success: false,
        code: "SERVICE_UNAVAILABLE",
        error: { type: "RateLimitExceeded" },
        message: "Забагато запитів. Повторіть спробу пізніше.",
        timestamp: new Date().toISOString(),
        requestId,
      },
      { status: 429, headers }
    );
  }

  try {
    const response = await next();

    const headers = response.headers;
    headers.set("x-ratelimit-limit", String(maxRequests));
    headers.set("x-ratelimit-remaining", String(rateLimitResult.remaining));
    headers.set("x-ratelimit-reset", String(rateLimitResult.resetAt));

    if (response.status === 429 || response.status === 503) {
      const existingRetryAfter = headers.get("retry-after");
      if (!existingRetryAfter) {
        headers.set("retry-after", String(DEFAULT_RETRY_AFTER_SECONDS));
      }
    }

    return response;
  } catch (err) {
    const headers = new Headers();
    headers.set("x-request-id", requestId);
    headers.set("x-ratelimit-limit", String(maxRequests));
    headers.set("x-ratelimit-remaining", String(rateLimitResult.remaining));
    headers.set("x-ratelimit-reset", String(rateLimitResult.resetAt));

    throw err;
  }
}

export function addRetryAfterHeader(
  response: NextResponse,
  retryAfterSeconds: number = DEFAULT_RETRY_AFTER_SECONDS
): NextResponse {
  response.headers.set("retry-after", String(retryAfterSeconds));
  return response;
}
