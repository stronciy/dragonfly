import test from "node:test";
import assert from "node:assert/strict";
import { backupFileName, toPgDumpUrl } from "../../src/lib/dbBackup";

test("backup file name is UTC, sortable and unique per second", () => {
  const name = backupFileName(new Date("2026-11-04T18:30:05Z"));
  assert.equal(name, "dragonfly-20261104-183005.dump");
});

test("backup file names sort chronologically", () => {
  const names = [
    backupFileName(new Date("2026-11-04T18:30:05Z")),
    backupFileName(new Date("2026-11-04T09:05:00Z")),
    backupFileName(new Date("2026-12-01T00:00:00Z")),
  ].sort();
  assert.deepEqual(names, [
    "dragonfly-20261104-090500.dump",
    "dragonfly-20261104-183005.dump",
    "dragonfly-20261201-000000.dump",
  ]);
});

test("pg_dump url drops Prisma-only query params but keeps TLS options", () => {
  const url = toPgDumpUrl(
    "postgresql://user:pass@db:5432/dragonfly?schema=public&connection_limit=5&sslmode=require"
  );
  assert.equal(url, "postgresql://user:pass@db:5432/dragonfly?sslmode=require");
});

test("pg_dump url has no query string when only Prisma params are present", () => {
  const url = toPgDumpUrl("postgresql://user:pass@db:5432/dragonfly?schema=public");
  assert.equal(url, "postgresql://user:pass@db:5432/dragonfly");
});
