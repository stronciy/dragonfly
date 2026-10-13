import Redis from "ioredis";

const RESET_LIMIT_PREFIX = "ratelimit:password-reset:";
const WINDOW_SECONDS = 15 * 60;
const MAX_PER_IP = 5;
const MAX_PER_EMAIL = 3;

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

export function getClientIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip");
  if (realIp && realIp.trim()) return realIp.trim();
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const ips = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    if (ips.length > 0) return ips[ips.length - 1];
  }
  return "unknown";
}

async function consume(key: string, limit: number): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return true;

  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SECONDS);
    return count <= limit;
  } catch {
    return true;
  }
}

export async function checkPasswordResetRateLimit(ip: string, email: string): Promise<boolean> {
  const ipAllowed = await consume(`${RESET_LIMIT_PREFIX}ip:${ip}`, MAX_PER_IP);
  const emailAllowed = await consume(
    `${RESET_LIMIT_PREFIX}email:${email.trim().toLowerCase()}`,
    MAX_PER_EMAIL
  );
  return ipAllowed && emailAllowed;
}
