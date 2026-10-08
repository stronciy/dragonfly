-- Repair migration for the one-time P3005 baseline (commit f254cb6), which ran
-- `prisma migrate resolve --applied` for ALL migrations WITHOUT executing their
-- SQL. These migrations were recorded as applied but never ran on prod:
--   20261003090000_add_avatar_url
--   20261005055443_add_order_media
--   20261005055505_backfill_order_media
--   20261005082439_add_early_start_requests
--   20261005084136_progress_reviews_arbitration
-- Every statement below is idempotent, so this migration is safe to apply
-- whether the objects already exist or not. After `migrate deploy` runs this,
-- the database matches prisma/schema.prisma again.
-- Symptom it fixes: `The column users.avatar_url does not exist` (500 on all
-- authenticated endpoints), plus missing order_media / early_start_requests /
-- work_progress_updates / arbitration_resolutions / reviews.customer_user_id.

-- ---------------------------------------------------------------------------
-- 1) users.avatar_url (20261003090000_add_avatar_url)
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_url" TEXT;

-- ---------------------------------------------------------------------------
-- 2) OrderMediaKind enum (20261005055443_add_order_media, plus the 'progress'
--    value from 20261005084136_progress_reviews_arbitration)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 3) order_media table (20261005055443_add_order_media, plus progress_id
--    from 20261005084136_progress_reviews_arbitration)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 4) early_start_requests table (20261005082439_add_early_start_requests)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5) work_progress_updates + arbitration_resolutions tables
--    (20261005084136_progress_reviews_arbitration)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 6) reviews: customer_user_id + performer_user_id nullable
--    (20261005084136_progress_reviews_arbitration)
-- ---------------------------------------------------------------------------
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "customer_user_id" TEXT;
ALTER TABLE "reviews" ALTER COLUMN "performer_user_id" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 7) Indexes (all IF NOT EXISTS)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "order_media_order_id_created_at_idx" ON "order_media"("order_id", "created_at");
CREATE INDEX IF NOT EXISTS "order_media_user_id_kind_created_at_idx" ON "order_media"("user_id", "kind", "created_at");
CREATE INDEX IF NOT EXISTS "order_media_progress_id_idx" ON "order_media"("progress_id");
CREATE INDEX IF NOT EXISTS "early_start_requests_order_id_created_at_idx" ON "early_start_requests"("order_id", "created_at");
CREATE INDEX IF NOT EXISTS "work_progress_updates_order_id_created_at_idx" ON "work_progress_updates"("order_id", "created_at");
CREATE INDEX IF NOT EXISTS "arbitration_resolutions_order_id_created_at_idx" ON "arbitration_resolutions"("order_id", "created_at");
CREATE INDEX IF NOT EXISTS "reviews_customer_user_id_created_at_idx" ON "reviews"("customer_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "reviews_order_id_author_user_id_idx" ON "reviews"("order_id", "author_user_id");

-- ---------------------------------------------------------------------------
-- 8) Foreign keys (only if the constraint does not exist yet)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_media_order_id_fkey') THEN
    ALTER TABLE "order_media" ADD CONSTRAINT "order_media_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_media_user_id_fkey') THEN
    ALTER TABLE "order_media" ADD CONSTRAINT "order_media_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_media_progress_id_fkey') THEN
    ALTER TABLE "order_media" ADD CONSTRAINT "order_media_progress_id_fkey" FOREIGN KEY ("progress_id") REFERENCES "work_progress_updates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'early_start_requests_order_id_fkey') THEN
    ALTER TABLE "early_start_requests" ADD CONSTRAINT "early_start_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'early_start_requests_requested_by_id_fkey') THEN
    ALTER TABLE "early_start_requests" ADD CONSTRAINT "early_start_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_progress_updates_order_id_fkey') THEN
    ALTER TABLE "work_progress_updates" ADD CONSTRAINT "work_progress_updates_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_progress_updates_author_id_fkey') THEN
    ALTER TABLE "work_progress_updates" ADD CONSTRAINT "work_progress_updates_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'arbitration_resolutions_order_id_fkey') THEN
    ALTER TABLE "arbitration_resolutions" ADD CONSTRAINT "arbitration_resolutions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'arbitration_resolutions_proposed_by_id_fkey') THEN
    ALTER TABLE "arbitration_resolutions" ADD CONSTRAINT "arbitration_resolutions_proposed_by_id_fkey" FOREIGN KEY ("proposed_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviews_customer_user_id_fkey') THEN
    ALTER TABLE "reviews" ADD CONSTRAINT "reviews_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 9) Backfill order_media from legacy notification rows
--    (20261005055505_backfill_order_media, made idempotent)
-- ---------------------------------------------------------------------------
WITH moved AS (
  INSERT INTO "order_media" ("id", "order_id", "user_id", "kind", "name", "mime_type", "size", "url", "caption", "created_at")
  SELECT
    n."id",
    n."data"->>'orderId',
    n."user_id",
    CASE WHEN n."type" = 'report' THEN 'report' ELSE 'arbitration' END::"OrderMediaKind",
    NULLIF(n."data"->>'name', ''),
    NULLIF(n."data"->>'mimeType', ''),
    CASE WHEN n."data"->>'size' ~ '^[0-9]+$' THEN (n."data"->>'size')::integer ELSE NULL END,
    n."data"->>'url',
    NULLIF(n."data"->>'caption', ''),
    n."created_at"
  FROM "notifications" n
  WHERE (n."type" = 'report' OR (n."type" = 'arbitration' AND n."data"->>'url' IS NOT NULL))
    AND n."data"->>'orderId' IS NOT NULL
    AND n."data"->>'url' IS NOT NULL
  ON CONFLICT ("id") DO NOTHING
  RETURNING "id"
)
DELETE FROM "notifications" n USING moved m WHERE n."id" = m."id";
