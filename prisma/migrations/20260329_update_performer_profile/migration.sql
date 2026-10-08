-- Update performer_profiles table to match new schema
-- Add missing columns for performer profile

ALTER TABLE "performer_profiles" 
ADD COLUMN IF NOT EXISTS "edrpou" TEXT,
ADD COLUMN IF NOT EXISTS "billing_email" TEXT,
ADD COLUMN IF NOT EXISTS "iban" TEXT,
ADD COLUMN IF NOT EXISTS "tax_system" TEXT,
ADD COLUMN IF NOT EXISTS "vat_payer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "legal_address" TEXT,
ADD COLUMN IF NOT EXISTS "base_location_label" TEXT,
ADD COLUMN IF NOT EXISTS "base_latitude" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "base_longitude" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "coverage_mode" TEXT NOT NULL DEFAULT 'radius',
ADD COLUMN IF NOT EXISTS "coverage_radius_km" INTEGER,
ADD COLUMN IF NOT EXISTS "avg_rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "review_count" INTEGER NOT NULL DEFAULT 0;

-- Drop old columns that are no longer needed
ALTER TABLE "performer_profiles" 
DROP COLUMN IF EXISTS "rating",
DROP COLUMN IF EXISTS "jobs_done";
