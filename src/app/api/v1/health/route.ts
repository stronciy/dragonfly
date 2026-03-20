import Redis from "ioredis";
import fs from "node:fs/promises";
import path from "node:path";
import { ok, fail } from "@/lib/apiResponse";
import { ApiError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

type HealthCheck = { ok: boolean; latencyMs: number | null; error: string | null };

type MigrationRow = {
  migrationName: string;
  startedAt: Date;
  finishedAt: Date | null;
  rolledBackAt: Date | null;
  logs: string | null;
};

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

function normalizeError(err: unknown) {
  if (err instanceof Error) return err.message;
  return "Unknown error";
}

async function checkDb(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 2000);
    return { ok: true, latencyMs: Date.now() - start, error: null };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: normalizeError(err) };
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
    return { ok: false, latencyMs: Date.now() - start, error: normalizeError(err) };
  } finally {
    try {
      client.disconnect();
    } catch {}
  }
}

async function getExpectedMigrations(): Promise<{ ok: true; list: string[] } | { ok: false; error: string }> {
  const migrationsDir = path.join(process.cwd(), "prisma", "migrations");
  try {
    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    const list = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => /^\d+_.+/.test(n))
      .sort();
    return { ok: true, list };
  } catch (err) {
    return { ok: false, error: normalizeError(err) };
  }
}

async function getMigrationRows(): Promise<MigrationRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      migrationName: string;
      startedAt: Date;
      finishedAt: Date | null;
      rolledBackAt: Date | null;
      logs: string | null;
    }>
  >`SELECT migration_name as "migrationName", started_at as "startedAt", finished_at as "finishedAt", rolled_back_at as "rolledBackAt", logs as "logs" FROM _prisma_migrations ORDER BY started_at ASC`;
  return rows;
}

async function checkMigrations() {
  const expected = await getExpectedMigrations();
  const rows = await getMigrationRows();

  const appliedOk = rows.filter((r) => r.finishedAt && !r.rolledBackAt).map((r) => r.migrationName);
  const rolledBack = rows.filter((r) => r.rolledBackAt).map((r) => r.migrationName);
  const failed = rows
    .filter((r) => !r.finishedAt && !r.rolledBackAt)
    .map((r) => ({
      migrationName: r.migrationName,
      startedAt: r.startedAt,
      logs: (r.logs ?? "").slice(0, 2000) || null,
    }));

  const pending = expected.ok ? expected.list.filter((m) => !appliedOk.includes(m)) : [];

  return {
    expected,
    appliedOkCount: appliedOk.length,
    rolledBackCount: rolledBack.length,
    failed,
    pending,
  };
}

async function checkSchema() {
  const [postgisRow, tables, userColumns] = await Promise.all([
    prisma.$queryRaw<Array<{ installed: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'postgis') as installed`,
    prisma.$queryRaw<Array<{ name: string }>>`SELECT table_name as name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
    prisma.$queryRaw<Array<{ column: string }>>`SELECT column_name as column FROM information_schema.columns WHERE table_schema='public' AND table_name='users'`,
  ]);

  const postgisInstalled = postgisRow[0]?.installed ?? false;
  const tableNames = tables.map((t) => t.name);

  const criticalTables = [
    "_prisma_migrations",
    "users",
    "refresh_tokens",
    "customer_profiles",
    "performer_profiles",
    "performer_settings",
    "orders",
    "payments",
    "escrow_locks",
    "devices",
    "notifications",
  ];

  const missingTables = criticalTables.filter((t) => !tableNames.includes(t));

  const expectedUserColumns = [
    "id",
    "role",
    "name",
    "email",
    "phone",
    "password_hash",
    "biometrics_enabled",
    "two_factor_secret",
    "two_factor_enabled_at",
    "created_at",
    "updated_at",
  ];

  const actualUserColumns = new Set(userColumns.map((c) => c.column));
  const missingUserColumns = expectedUserColumns.filter((c) => !actualUserColumns.has(c));

  return {
    postgisInstalled,
    tablesCount: tableNames.length,
    missingTables,
    missingUserColumns,
  };
}

function isDetailedAuthorized(req: Request) {
  if (process.env.NODE_ENV !== "production") return true;
  const token = process.env.HEALTHCHECK_TOKEN;
  if (!token) return false;
  return (req.headers.get("x-health-token") ?? "") === token;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const detailed = ["1", "true", "yes"].includes((url.searchParams.get("detailed") ?? "").toLowerCase());

    const [db, redis] = await Promise.all([checkDb(), checkRedis()]);
    const checks: Record<string, unknown> = { db, redis };

    if (detailed) {
      if (!isDetailedAuthorized(req)) throw new ApiError(404, "NOT_FOUND", "Not found");
      const [migrations, schema] = await Promise.all([checkMigrations(), checkSchema()]);
      checks.migrations = migrations;
      checks.schema = schema;
    }

    if (typeof checks.db === "object" && checks.db && "ok" in checks.db && !(checks.db as HealthCheck).ok) {
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Service unavailable", { checks });
    }
    if (typeof checks.redis === "object" && checks.redis && "ok" in checks.redis && !(checks.redis as HealthCheck).ok) {
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Service unavailable", { checks });
    }
    if (detailed) {
      const schema = checks.schema as Awaited<ReturnType<typeof checkSchema>> | undefined;
      const migrations = checks.migrations as Awaited<ReturnType<typeof checkMigrations>> | undefined;
      const hasFailedMigrations = (migrations?.failed?.length ?? 0) > 0;
      const missingTables = schema ? (schema.missingTables.length > 0 || schema.missingUserColumns.length > 0) : false;
      if (hasFailedMigrations || missingTables || schema?.postgisInstalled === false) {
        throw new ApiError(503, "SERVICE_UNAVAILABLE", "Service unavailable", { checks });
      }
    }

    return ok(req, { status: "ok", uptimeSec: Math.floor(process.uptime()), checks });
  } catch (err) {
    return fail(req, err);
  }
}
