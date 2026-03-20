import Redis from "ioredis";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

type HealthCheck = { ok: boolean; latencyMs: number | null; error: string | null };

function withTimeout<T>(promise: Promise<T>, ms: number) {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function checkDb(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 2000);
    return { ok: true, latencyMs: Date.now() - start, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, latencyMs: Date.now() - start, error: message };
  }
}

async function checkRedis(): Promise<HealthCheck> {
  const start = Date.now();
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return { ok: false, latencyMs: null, error: "REDIS_URL is not set" };

  const client = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 0,
    enableReadyCheck: false,
  });

  try {
    await withTimeout(client.connect(), 2000);
    await withTimeout(client.ping(), 2000);
    return { ok: true, latencyMs: Date.now() - start, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, latencyMs: Date.now() - start, error: message };
  } finally {
    try {
      client.disconnect();
    } catch {}
  }
}

export async function GET(req: Request) {
  try {
    const [db, redis] = await Promise.all([checkDb(), checkRedis()]);
    const checks = { db, redis };

    if (!checks.db.ok || !checks.redis.ok) {
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Service unavailable", { checks });
    }

    return ok(req, { status: "ok", uptimeSec: Math.floor(process.uptime()), checks });
  } catch (err) {
    return fail(req, err);
  }
}
