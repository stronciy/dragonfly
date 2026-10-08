-- Repair drift missing on prod (PUT /api/v1/performer/settings 500:
-- `column service_id of performer_services does not exist`).
--
-- History: the P3005 baseline (f254cb6) marked the March profile/service
-- migrations applied without running their SQL. PUT settings does
-- deleteMany + createMany with (performerUserId, serviceId, serviceLevel),
-- so the missing columns 500 every save.
-- Rules learned from previous P3009s, applied here: purely additive
-- (no DROP/DELETE), no UNIQUE indexes (duplicate data would fail the build),
-- no ALTER TYPE, no ON CONFLICT, no static reference to maybe-missing
-- columns. Deliberately does NOT drop the legacy
-- (service_category_id/subcategory_id/type_id) columns — data preservation.

-- ---------------------------------------------------------------------------
-- 0) performer_services: hierarchical service_id/service_level
-- ---------------------------------------------------------------------------
ALTER TABLE "performer_services" ADD COLUMN IF NOT EXISTS "service_id" TEXT DEFAULT '';
ALTER TABLE "performer_services" ADD COLUMN IF NOT EXISTS "service_level" INTEGER DEFAULT 3;

-- Backfill level from hierarchical id format (1=category, 2=subcategory, 3=type)
UPDATE "performer_services"
SET service_level =
  CASE
    WHEN service_id ~ '^\d+$' THEN 1
    WHEN service_id ~ '^\d+\.\d+$' THEN 2
    WHEN service_id ~ '^\d+\.\d+\.\d+$' THEN 3
    ELSE 3
  END
WHERE service_id IS NOT NULL AND service_id <> '';

-- Non-unique helper indexes only (UNIQUE skipped on purpose: pre-existing
-- duplicate rows would fail the migration; runtime uses deleteMany+createMany
-- which needs no unique constraint).
CREATE INDEX IF NOT EXISTS "performer_services_service_id_idx"
  ON "performer_services"("service_id");
CREATE INDEX IF NOT EXISTS "performer_services_performer_user_id_idx"
  ON "performer_services"("performer_user_id");

-- ---------------------------------------------------------------------------
-- 1) performer_profiles: columns added after init (all nullable/defaulted,
--    safe on populated tables)
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
-- 2) legal_profiles table (missing when baselined)
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
-- 3) Re-ensure small drift (harmless repeats if other repairs applied first).
--    Table-existence guards: this file must also pass on DBs where the seed
--    migration has not run yet (migrations after a failed seed still need a
--    green file for `migrate resolve` + retry flows and local shape tests).
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" TEXT;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'service_categories') THEN
    ALTER TABLE "service_categories" ADD COLUMN IF NOT EXISTS "name_ua" TEXT;
    ALTER TABLE "service_categories" ADD COLUMN IF NOT EXISTS "icon_key" TEXT;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'service_subcategories') THEN
    ALTER TABLE "service_subcategories" ADD COLUMN IF NOT EXISTS "name_ua" TEXT;
    ALTER TABLE "service_subcategories" ADD COLUMN IF NOT EXISTS "icon_key" TEXT;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'service_types') THEN
    ALTER TABLE "service_types" ADD COLUMN IF NOT EXISTS "name_ua" TEXT;
  END IF;
END $$;
