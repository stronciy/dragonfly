-- Add specs to performer_services (sync performer capabilities with order specs).
--
-- Performers could only toggle service ids (e.g. "3.2 Причепні") while orders
-- carry required specs (e.g. boom width, clearance), so matching paired
-- performers with equipment they may not have. New Json column mirrors
-- orders.specs; absent performer specs mean wildcard (matches anything,
-- backward compatible). Same proven pattern as the orders.specs repair:
-- ADD IF NOT EXISTS + backfill + SET NOT NULL/DEFAULT (parse-safe, no
-- static reference to maybe-missing columns).

ALTER TABLE "performer_services" ADD COLUMN IF NOT EXISTS "specs" JSONB DEFAULT '{}';

UPDATE "performer_services" SET "specs" = '{}'::jsonb WHERE "specs" IS NULL;

DO $$ BEGIN
  BEGIN
    ALTER TABLE "performer_services" ALTER COLUMN "specs" SET DEFAULT '{}'::jsonb;
  EXCEPTION WHEN others THEN NULL;
  END;
  BEGIN
    ALTER TABLE "performer_services" ALTER COLUMN "specs" SET NOT NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;
