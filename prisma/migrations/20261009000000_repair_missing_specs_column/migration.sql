-- Repair: missing `orders.specs` on prod (GET /api/v1/orders 500).
--
-- Root cause: one-time P3005 baseline (commit f254cb6) ran
-- `prisma migrate resolve --applied` for ALL 30 migrations WITHOUT executing
-- their SQL. Prod was assumed to already match that history, but it did NOT
-- contain `orders.specs` (migration 20260329_add_specs_to_orders) — so the
-- column was recorded as applied yet never created. Prisma then fails with:
--   The column `orders.specs` does not exist in the current database.
-- The Oct repair (20261008210000) fixed avatar_url / order_media / etc but did
-- not cover `specs` (nor other March-era drift), hence this follow-up.
--
-- Every statement below is idempotent (IF NOT EXISTS / existence guards), so it
-- is safe whether prod already has the objects, partially has them, or lacks
-- them entirely. It is purely ADDITIVE — no DROP / DELETE, no data loss.
-- After `migrate deploy` (runs automatically on CapRover startup via Dockerfile
-- CMD) the DB matches prisma/schema.prisma again.

-- ---------------------------------------------------------------------------
-- 0) MAIN FIX: orders.specs (Json, required, default '{}')
-- ---------------------------------------------------------------------------
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "specs" JSONB DEFAULT '{}';

-- Backfill rows that predate the column (or have NULL) so SET NOT NULL succeeds.
UPDATE "orders" SET "specs" = '{}'::jsonb WHERE "specs" IS NULL;

-- Align with schema.prisma: NOT NULL + DEFAULT '{}'.
-- Plain ALTERs are safe here: column now exists and has no NULLs.
-- If already NOT NULL / already has default, these are no-ops.
DO $$ BEGIN
  BEGIN
    ALTER TABLE "orders" ALTER COLUMN "specs" SET DEFAULT '{}'::jsonb;
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    ALTER TABLE "orders" ALTER COLUMN "specs" SET NOT NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- NOTE: 20260329214130_30_march deliberately DROPPED the GIN index
-- "orders_specs_idx", and schema.prisma defines no index on specs.
-- So we do NOT recreate it — column presence is what Prisma needs.

-- ---------------------------------------------------------------------------
-- 1) Defensive: ensure every other Order column from schema.prisma exists.
--    Added as NULLABLE first (never fails on tables with rows); the app +
--    backfills above bring required ones in line. Pure ADD, no drops.
-- ---------------------------------------------------------------------------
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customer_user_id" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "performer_user_id" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "service_category_id" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "service_subcategory_id" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "service_type_id" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "area_ha" DOUBLE PRECISION;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "date_from" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "date_to" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "location_label" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "region_name" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "lat" DOUBLE PRECISION;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "lng" DOUBLE PRECISION;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "comment" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "budget" DECIMAL(12,2);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "currency" TEXT DEFAULT 'UAH';
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'published';
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "radius_km" INTEGER;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "accepted_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deposit_deadline" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3);

-- Backfill textual defaults so required-field reads never see NULL.
UPDATE "orders" SET "currency" = 'UAH' WHERE "currency" IS NULL;
UPDATE "orders" SET "status" = 'published' WHERE "status" IS NULL;

-- Indexes from 20260329214130_30_march (perf only; missing ones don't 500,
-- but recreate if absent so prod matches expected shape).
CREATE INDEX IF NOT EXISTS "orders_customer_user_id_status_created_at_idx" ON "orders"("customer_user_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "orders_performer_user_id_status_created_at_idx" ON "orders"("performer_user_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- ---------------------------------------------------------------------------
-- 2) service catalog i18n columns (20260329_add_name_ua_columns, idempotent)
-- ---------------------------------------------------------------------------
ALTER TABLE "service_categories" ADD COLUMN IF NOT EXISTS "name_ua" TEXT;
ALTER TABLE "service_categories" ADD COLUMN IF NOT EXISTS "icon_key" TEXT;
ALTER TABLE "service_subcategories" ADD COLUMN IF NOT EXISTS "name_ua" TEXT;
ALTER TABLE "service_subcategories" ADD COLUMN IF NOT EXISTS "icon_key" TEXT;
ALTER TABLE "service_types" ADD COLUMN IF NOT EXISTS "name_ua" TEXT;

UPDATE "service_categories" SET name_ua = name WHERE name_ua IS NULL;
UPDATE "service_subcategories" SET name_ua = name WHERE name_ua IS NULL;
UPDATE "service_types" SET name_ua = name WHERE name_ua IS NULL;

-- ---------------------------------------------------------------------------
-- 3) legal_profiles table (20260329_create_legal_profiles_table, idempotent)
--    Was also baselined-without-run; prod may lack the table entirely.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "legal_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "company_name" TEXT,
    "edrpou" TEXT,
    "iban" TEXT,
    "legal_address" TEXT,
    "vat_payer" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "legal_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "legal_profiles_user_id_key" ON "legal_profiles"("user_id");
CREATE INDEX IF NOT EXISTS "legal_profiles_user_id_idx" ON "legal_profiles"("user_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_profiles_user_id_fkey') THEN
    ALTER TABLE "legal_profiles"
    ADD CONSTRAINT "legal_profiles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4) performer_profiles new columns (20260329_update_performer_profile)
-- ---------------------------------------------------------------------------
ALTER TABLE "performer_profiles" ADD COLUMN IF NOT EXISTS "edrpou" TEXT;
ALTER TABLE "performer_profiles" ADD COLUMN IF NOT EXISTS "billing_email" TEXT;
ALTER TABLE "performer_profiles" ADD COLUMN IF NOT EXISTS "iban" TEXT;
ALTER TABLE "performer_profiles" ADD COLUMN IF NOT EXISTS "tax_system" TEXT;
ALTER TABLE "performer_profiles" ADD COLUMN IF NOT EXISTS "vat_payer" BOOLEAN DEFAULT false;
ALTER TABLE "performer_profiles" ADD COLUMN IF NOT EXISTS "legal_address" TEXT;
ALTER TABLE "performer_profiles" ADD COLUMN IF NOT EXISTS "base_location_label" TEXT;
ALTER TABLE "performer_profiles" ADD COLUMN IF NOT EXISTS "base_latitude" DOUBLE PRECISION;
ALTER TABLE "performer_profiles" ADD COLUMN IF NOT EXISTS "base_longitude" DOUBLE PRECISION;
ALTER TABLE "performer_profiles" ADD COLUMN IF NOT EXISTS "coverage_mode" TEXT DEFAULT 'radius';
ALTER TABLE "performer_profiles" ADD COLUMN IF NOT EXISTS "coverage_radius_km" INTEGER DEFAULT 50;
ALTER TABLE "performer_profiles" ADD COLUMN IF NOT EXISTS "avg_rating" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "performer_profiles" ADD COLUMN IF NOT EXISTS "review_count" INTEGER DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 5) performer_services hierarchical service_id (20260329_hierarchical_…)
--    Only ADDITIVE part: ensure new columns exist. We deliberately do NOT drop
--    legacy columns here (a baselined prod may or may not have them; dropping
--    is unsafe in a repair).
-- ---------------------------------------------------------------------------
ALTER TABLE "performer_services" ADD COLUMN IF NOT EXISTS "service_id" TEXT DEFAULT '';
ALTER TABLE "performer_services" ADD COLUMN IF NOT EXISTS "service_level" INTEGER DEFAULT 3;

CREATE UNIQUE INDEX IF NOT EXISTS "performer_services_performer_user_id_service_id_key"
  ON "performer_services"("performer_user_id", "service_id");
CREATE INDEX IF NOT EXISTS "performer_services_service_id_idx"
  ON "performer_services"("service_id");
CREATE INDEX IF NOT EXISTS "performer_services_performer_user_id_idx"
  ON "performer_services"("performer_user_id");

-- ---------------------------------------------------------------------------
-- 6) payments + escrow (20260330_payments_escrow, FK made idempotent)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "payment_intents" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UAH',
    "provider" TEXT NOT NULL DEFAULT 'liqpay',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider_order_id" TEXT,
    "data" TEXT,
    "signature" TEXT,
    "server_url" TEXT,
    "result_url" TEXT,
    "provider_raw" JSONB,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "payment_intents_order_id_idx" ON "payment_intents"("order_id");
CREATE INDEX IF NOT EXISTS "payment_intents_status_idx" ON "payment_intents"("status");

CREATE TABLE IF NOT EXISTS "escrow_locks" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'held',
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "escrow_locks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_order_role_lock" ON "escrow_locks"("order_id", "role");
CREATE INDEX IF NOT EXISTS "escrow_locks_user_id_idx" ON "escrow_locks"("user_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_intents_order_id_fkey') THEN
    ALTER TABLE "payment_intents"
    ADD CONSTRAINT "payment_intents_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'escrow_locks_order_id_fkey') THEN
    ALTER TABLE "escrow_locks"
    ADD CONSTRAINT "escrow_locks_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7) Re-ensure Oct objects (in case 20261008 repair hasn't applied yet on some
--    env, or partially failed). Duplicating IF NOT EXISTS guards is harmless.
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrderMediaKind') THEN
    CREATE TYPE "OrderMediaKind" AS ENUM ('report', 'arbitration', 'progress');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'OrderMediaKind' AND e.enumlabel = 'progress'
  ) THEN
    ALTER TYPE "OrderMediaKind" ADD VALUE 'progress';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "order_media" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "OrderMediaKind" NOT NULL,
    "name" TEXT,
    "mime_type" TEXT,
    "size" INTEGER,
    "url" TEXT NOT NULL,
    "caption" TEXT,
    "progress_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_media_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "order_media" ADD COLUMN IF NOT EXISTS "progress_id" TEXT;

CREATE TABLE IF NOT EXISTS "early_start_requests" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    CONSTRAINT "early_start_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "work_progress_updates" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "percent" INTEGER,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "work_progress_updates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "arbitration_resolutions" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "proposed_by_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "rating" INTEGER,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    CONSTRAINT "arbitration_resolutions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "customer_user_id" TEXT;

DO $$ BEGIN
  BEGIN
    ALTER TABLE "reviews" ALTER COLUMN "performer_user_id" DROP NOT NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;
