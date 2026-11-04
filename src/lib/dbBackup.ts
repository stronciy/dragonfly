import { spawn } from "node:child_process";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/shared";

/**
 * Pre-reset database backups.
 *
 * The admin panel can wipe every business table in one click, so the reset
 * endpoint always dumps the database first. `pg_dump` is installed in the
 * runtime image (see Dockerfile); dumps land in `BACKUP_DIR` (default
 * `/app/backups`) and only the newest `BACKUP_KEEP` files are kept.
 */
export type DatabaseBackup = {
  /** File name only — never expose absolute container paths to the panel. */
  file: string;
  bytes: number;
  durationMs: number;
};

const DEFAULT_BACKUP_DIR = "/app/backups";
const DEFAULT_KEEP = 5;
const PG_DUMP_TIMEOUT_MS = 10 * 60 * 1000;
const FILE_PREFIX = "dragonfly-";
const FILE_SUFFIX = ".dump";

export function backupDir(): string {
  const configured = process.env.BACKUP_DIR?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_BACKUP_DIR;
}

export function backupKeepCount(): number {
  const raw = Number(process.env.BACKUP_KEEP ?? DEFAULT_KEEP);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_KEEP;
  return Math.floor(raw);
}

/** `dragonfly-20261104-183000.dump` (UTC, sortable). */
export function backupFileName(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${FILE_PREFIX}${stamp}${FILE_SUFFIX}`;
}

/**
 * Prisma connection strings carry parameters libpq does not understand
 * (`schema`, `connection_limit`, …). Keep only TLS options.
 */
export function toPgDumpUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const allowed = new URLSearchParams();
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) {
    const value = url.searchParams.get(key);
    if (value) allowed.set(key, value);
  }
  url.search = allowed.toString();
  return url.toString();
}

function runPgDump(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pg_dump", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ApiError(503, "SERVICE_UNAVAILABLE", "Резервне копіювання перевищило ліміт часу"));
    }, timeoutMs);

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") {
        reject(
          new ApiError(
            503,
            "SERVICE_UNAVAILABLE",
            "pg_dump не встановлено в контейнері бекенду — скидання заблоковано, щоб не втратити дані без копії"
          )
        );
        return;
      }
      reject(new ApiError(500, "INTERNAL_ERROR", `Не вдалося запустити pg_dump: ${error.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
      reject(
        new ApiError(
          500,
          "INTERNAL_ERROR",
          detail ? `pg_dump завершився з кодом ${code}: ${detail}` : `pg_dump завершився з кодом ${code}`
        )
      );
    });
  });
}

async function pruneOldBackups(dir: string, keep: number): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const dumps = entries.filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX)).sort();
  const stale = dumps.slice(0, Math.max(0, dumps.length - keep));
  await Promise.all(stale.map((name) => unlink(path.join(dir, name)).catch(() => undefined)));
}

export async function createDatabaseBackup(): Promise<DatabaseBackup> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "DATABASE_URL не налаштовано");
  }

  const dir = backupDir();
  await mkdir(dir, { recursive: true }).catch((error: Error) => {
    throw new ApiError(500, "INTERNAL_ERROR", `Не вдалося створити теку для бекапів: ${error.message}`);
  });

  const file = backupFileName();
  const target = path.join(dir, file);
  const startedAt = Date.now();

  await runPgDump(
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--file",
      target,
      "--dbname",
      toPgDumpUrl(databaseUrl),
    ],
    PG_DUMP_TIMEOUT_MS
  );

  const info = await stat(target);
  if (info.size === 0) {
    await unlink(target).catch(() => undefined);
    throw new ApiError(500, "INTERNAL_ERROR", "pg_dump створив порожній файл — скидання скасовано");
  }

  await pruneOldBackups(dir, backupKeepCount());

  return { file, bytes: info.size, durationMs: Date.now() - startedAt };
}
