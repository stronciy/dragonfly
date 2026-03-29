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
exports.idempotencyMiddleware = idempotencyMiddleware;
const server_1 = require("next/server");
const ioredis_1 = __importDefault(require("ioredis"));
const IDEMPOTENCY_KEY_PREFIX = "idempotency:";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours
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
    catch (_a) {
        redisInitAttempted = true;
        return null;
    }
}
function getRequestId(req) {
    var _a;
    return (_a = req.headers.get("x-request-id")) !== null && _a !== void 0 ? _a : crypto.randomUUID();
}
function getIdempotencyKey(req) {
    return req.headers.get("x-idempotency-key");
}
function getRedisKey(idempotencyKey, userId) {
    return userId
        ? `${IDEMPOTENCY_KEY_PREFIX}${userId}:${idempotencyKey}`
        : `${IDEMPOTENCY_KEY_PREFIX}${idempotencyKey}`;
}
function isStateChangingMethod(method) {
    return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}
async function idempotencyMiddleware(req, next) {
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
    let userId;
    try {
        const authHeader = req.headers.get("authorization");
        if (authHeader === null || authHeader === void 0 ? void 0 : authHeader.startsWith("Bearer ")) {
            const { jwtVerify } = await Promise.resolve().then(() => __importStar(require("jose")));
            const secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET || "");
            const token = authHeader.slice("Bearer ".length);
            const { payload } = await jwtVerify(token, secret);
            if (payload && typeof payload.userId === "string") {
                userId = payload.userId;
            }
        }
    }
    catch (_a) {
        // Token verification failed, proceed without userId scoping
    }
    const redisKey = getRedisKey(idempotencyKey, userId);
    try {
        const stored = await redis.get(redisKey);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (process.env.NODE_ENV !== "production") {
                console.info(`[idempotency] Cache hit requestId=${requestId} idempotencyKey=${idempotencyKey} status=${parsed.status}`);
            }
            const headers = new Headers();
            headers.set("x-request-id", parsed.requestId);
            headers.set("x-idempotency-hit", "true");
            headers.set("x-idempotency-key", idempotencyKey);
            if (parsed.status === 204 || parsed.status === 205) {
                return new server_1.NextResponse(null, { status: parsed.status, headers });
            }
            return server_1.NextResponse.json(parsed.body, { status: parsed.status, headers });
        }
    }
    catch (err) {
        if (process.env.NODE_ENV !== "production") {
            console.warn("[idempotency] Redis GET error, proceeding with request", err);
        }
    }
    // Process the request
    const response = await next();
    // Store the response for future idempotent requests
    try {
        const status = response.status;
        let body;
        if (status !== 204 && status !== 205) {
            const contentType = response.headers.get("content-type");
            if (contentType === null || contentType === void 0 ? void 0 : contentType.includes("application/json")) {
                const cloned = response.clone();
                body = await cloned.json().catch(() => undefined);
            }
        }
        const stored = {
            status,
            body,
            requestId,
            createdAt: Date.now(),
        };
        await redis.setex(redisKey, DEFAULT_TTL_SECONDS, JSON.stringify(stored));
        if (process.env.NODE_ENV !== "production") {
            console.info(`[idempotency] Response cached requestId=${requestId} idempotencyKey=${idempotencyKey} status=${status}`);
        }
    }
    catch (err) {
        if (process.env.NODE_ENV !== "production") {
            console.warn("[idempotency] Redis SET error, response not cached", err);
        }
    }
    return response;
}
