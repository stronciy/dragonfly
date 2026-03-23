import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import Redis from "ioredis";

const IDEMPOTENCY_KEY_PREFIX = "idempotency:";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

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

function getIdempotencyKey(req: NextRequest): string | null {
  return req.headers.get("x-idempotency-key");
}

function getRedisKey(idempotencyKey: string, userId?: string): string {
  return userId
    ? `${IDEMPOTENCY_KEY_PREFIX}${userId}:${idempotencyKey}`
    : `${IDEMPOTENCY_KEY_PREFIX}${idempotencyKey}`;
}

function isStateChangingMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

interface StoredResponse {
  status: number;
  body?: unknown;
  requestId: string;
  createdAt: number;
}

export async function idempotencyMiddleware(
  req: NextRequest,
  next: () => Promise<NextResponse>
): Promise<NextResponse> {
  const method = req.method;
  
  if (!isStateChangingMethod(method)) {
    return next();
  }

  const idempotencyKey = getIdempotencyKey(req);
  if (!idempotencyKey) {
    return next();
  }

  const redis = getRedisClient();
  if (!redis) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[idempotency] Redis not available, skipping idempotency check");
    }
    return next();
  }

  const requestId = getRequestId(req);
  let userId: string | undefined;

  try {
    const authHeader = req.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const { jwtVerify } = await import("jose");
      const secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET || "");
      const token = authHeader.slice("Bearer ".length);
      const { payload } = await jwtVerify(token, secret);
      if (payload && typeof payload.userId === "string") {
        userId = payload.userId;
      }
    }
  } catch {
    // Token verification failed, proceed without userId scoping
  }

  const redisKey = getRedisKey(idempotencyKey, userId);

  try {
    const stored = await redis.get(redisKey);
    if (stored) {
      const parsed: StoredResponse = JSON.parse(stored);
      
      if (process.env.NODE_ENV !== "production") {
        console.info(
          `[idempotency] Cache hit requestId=${requestId} idempotencyKey=${idempotencyKey} status=${parsed.status}`
        );
      }

      const headers = new Headers();
      headers.set("x-request-id", parsed.requestId);
      headers.set("x-idempotency-hit", "true");
      headers.set("x-idempotency-key", idempotencyKey);

      if (parsed.status === 204 || parsed.status === 205) {
        return new NextResponse(null, { status: parsed.status, headers });
      }

      return NextResponse.json(parsed.body, { status: parsed.status, headers });
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[idempotency] Redis GET error, proceeding with request", err);
    }
  }

  // Process the request
  const response = await next();

  // Store the response for future idempotent requests
  try {
    const status = response.status;
    let body: unknown;

    if (status !== 204 && status !== 205) {
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        const cloned = response.clone();
        body = await cloned.json().catch(() => undefined);
      }
    }

    const stored: StoredResponse = {
      status,
      body,
      requestId,
      createdAt: Date.now(),
    };

    await redis.setex(redisKey, DEFAULT_TTL_SECONDS, JSON.stringify(stored));

    if (process.env.NODE_ENV !== "production") {
      console.info(
        `[idempotency] Response cached requestId=${requestId} idempotencyKey=${idempotencyKey} status=${status}`
      );
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[idempotency] Redis SET error, response not cached", err);
    }
  }

  return response;
}
