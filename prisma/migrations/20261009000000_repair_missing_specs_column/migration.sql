-- Minimal repair: missing `orders.specs` on prod (GET /api/v1/orders 500).
--
-- History: the P3005 baseline (f254cb6) marked 20260329_add_specs_to_orders as
-- applied without running its SQL, so prod lacks the column. The first version
-- of this migration additionally created UNIQUE indexes and ran
-- ALTER TYPE ... ADD VALUE inside the deploy transaction, and failed (P3009).
-- This rewrite keeps ONLY the additive specs fix; everything else moves to
-- later migrations. Re-apply is safe: Postgres rolled the failed attempt back
-- atomically, and each statement here is idempotent. Unblocked via
-- `migrate resolve --rolled-back 20261009000000_repair_missing_specs_column`
-- (runs automatically once on CapRover startup, see Dockerfile CMD).

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "specs" JSONB DEFAULT '{}';
UPDATE "orders" SET "specs" = '{}'::jsonb WHERE "specs" IS NULL;
ALTER TABLE "orders" ALTER COLUMN "specs" SET DEFAULT '{}'::jsonb;
ALTER TABLE "orders" ALTER COLUMN "specs" SET NOT NULL;
