"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.retryAfterMiddleware = retryAfterMiddleware;
exports.addRetryAfterHeader = addRetryAfterHeader;
const server_1 = require("next/server");
const ioredis_1 = __importDefault(require("ioredis"));
const RATE_LIMIT_KEY_PREFIX = "ratelimit:";
const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
let redisClient = null;
let redisInitAttempted = false;
function getRedisClient() {
    if (redisInitAttempted)
        return redisClient;
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        redisInitAttempted = true;
        return null;
    }
    try {
        redisClient = new ioredis_1.default(redisUrl, {
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
    }
    catch {
        redisInitAttempted = true;
        return null;
    }
}
function getRequestId(req) {
    return req.headers.get("x-request-id") ?? crypto.randomUUID();
}
function getClientIdentifier(req) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
        const ips = forwarded.split(",");
        return ips[0]?.trim() ?? "unknown";
    }
    return req.headers.get("x-real-ip") ?? "unknown";
}
async function getUserId(req) {
    try {
        const authHeader = req.headers.get("authorization");
        if (authHeader?.startsWith("Bearer ")) {
            const { jwtVerify } = await Promise.resolve().then(() => __importStar(require("jose")));
            const secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET || "");
            const token = authHeader.slice("Bearer ".length);
            const { payload } = await jwtVerify(token, secret);
            if (payload && typeof payload.userId === "string") {
                return payload.userId;
            }
        }
    }
    catch {
        // Token verification failed
    }
    return null;
}
function getRateLimitKey(identifier, userId) {
    return userId
        ? `${RATE_LIMIT_KEY_PREFIX}user:${userId}`
        : `${RATE_LIMIT_KEY_PREFIX}ip:${identifier}`;
}
async function checkRateLimit(key, windowSeconds = DEFAULT_WINDOW_SECONDS, maxRequests = DEFAULT_MAX_REQUESTS) {
    const redis = getRedisClient();
    if (!redis) {
        return { allowed: true, remaining: maxRequests, resetAt: Date.now() + windowSeconds * 1000 };
    }
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = now - windowMs;
    const multi = redis.multi();
    multi.zremrangebyscore(key, 0, windowStart);
    multi.zadd(key, now, `${now}-${crypto.randomUUID()}`);
    multi.zcard(key);
    multi.expire(key, windowSeconds);
    const results = await multi.exec();
    const count = results?.[2]?.[1] ?? 0;
    const remaining = Math.max(0, maxRequests - count);
    const resetAt = now + windowMs;
    if (count >= maxRequests) {
        const oldestMember = await redis.zrange(key, 0, 0);
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
async function retryAfterMiddleware(req, next) {
    const requestId = getRequestId(req);
    const identifier = getClientIdentifier(req);
    const userId = await getUserId(req);
    const rateLimitKey = getRateLimitKey(identifier, userId);
    const rateLimitResult = await checkRateLimit(rateLimitKey);
    if (!rateLimitResult.allowed) {
        if (process.env.NODE_ENV !== "production") {
            console.warn(`[ratelimit] Rate limit exceeded requestId=${requestId} identifier=${identifier} retryAfter=${rateLimitResult.retryAfter}`);
        }
        const headers = new Headers();
        headers.set("x-request-id", requestId);
        headers.set("retry-after", String(rateLimitResult.retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS));
        headers.set("x-ratelimit-limit", String(DEFAULT_MAX_REQUESTS));
        headers.set("x-ratelimit-remaining", "0");
        headers.set("x-ratelimit-reset", String(rateLimitResult.resetAt));
        return server_1.NextResponse.json({
            success: false,
            code: "SERVICE_UNAVAILABLE",
            error: { type: "RateLimitExceeded" },
            message: "Too many requests. Please retry after the specified time.",
            timestamp: new Date().toISOString(),
            requestId,
        }, { status: 429, headers });
    }
    try {
        const response = await next();
        const headers = response.headers;
        headers.set("x-ratelimit-limit", String(DEFAULT_MAX_REQUESTS));
        headers.set("x-ratelimit-remaining", String(rateLimitResult.remaining));
        headers.set("x-ratelimit-reset", String(rateLimitResult.resetAt));
        if (response.status === 429 || response.status === 503) {
            const existingRetryAfter = headers.get("retry-after");
            if (!existingRetryAfter) {
                headers.set("retry-after", String(DEFAULT_RETRY_AFTER_SECONDS));
            }
        }
        return response;
    }
    catch (err) {
        const headers = new Headers();
        headers.set("x-request-id", requestId);
        headers.set("x-ratelimit-limit", String(DEFAULT_MAX_REQUESTS));
        headers.set("x-ratelimit-remaining", String(rateLimitResult.remaining));
        headers.set("x-ratelimit-reset", String(rateLimitResult.resetAt));
        throw err;
    }
}
function addRetryAfterHeader(response, retryAfterSeconds = DEFAULT_RETRY_AFTER_SECONDS) {
    response.headers.set("retry-after", String(retryAfterSeconds));
    return response;
}
