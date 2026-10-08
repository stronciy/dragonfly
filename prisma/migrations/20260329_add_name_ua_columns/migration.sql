-- Add missing columns to service tables for new service structure
-- This includes name_ua and icon_key for Ukrainian language support and icons

ALTER TABLE "service_categories" 
  ADD COLUMN IF NOT EXISTS "name_ua" TEXT,
  ADD COLUMN IF NOT EXISTS "icon_key" TEXT;

ALTER TABLE "service_subcategories" 
  ADD COLUMN IF NOT EXISTS "name_ua" TEXT,
  ADD COLUMN IF NOT EXISTS "icon_key" TEXT;

ALTER TABLE "service_types" 
  ADD COLUMN IF NOT EXISTS "name_ua" TEXT;

-- Copy existing names to name_ua for backward compatibility
UPDATE "service_categories" SET name_ua = name WHERE name_ua IS NULL;
UPDATE "service_subcategories" SET name_ua = name WHERE name_ua IS NULL;
UPDATE "service_types" SET name_ua = name WHERE name_ua IS NULL;
