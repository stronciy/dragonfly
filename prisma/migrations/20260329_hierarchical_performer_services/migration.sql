-- AlterTable
-- Drop old columns and add new service_id column
ALTER TABLE "performer_services" 
  DROP COLUMN "service_category_id",
  DROP COLUMN "service_subcategory_id",
  DROP COLUMN "service_type_id";

ALTER TABLE "performer_services" 
  ADD COLUMN "service_id" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "service_level" INTEGER NOT NULL DEFAULT 3;

-- Remove old unique constraint and index (if they exist)
DROP INDEX IF EXISTS "performer_services_performer_user_id_service_category_id_se_key";
DROP INDEX IF EXISTS "performer_services_service_category_id_service_subcategory__idx";
DROP INDEX IF EXISTS "performer_services_performer_user_id_service_id_key";
DROP INDEX IF EXISTS "performer_services_service_id_idx";
DROP INDEX IF EXISTS "performer_services_performer_user_id_idx";

-- Create new unique constraint and indexes
CREATE UNIQUE INDEX "performer_services_performer_user_id_service_id_key" 
  ON "performer_services"("performer_user_id", "service_id");

CREATE INDEX "performer_services_service_id_idx" 
  ON "performer_services"("service_id");

CREATE INDEX "performer_services_performer_user_id_idx" 
  ON "performer_services"("performer_user_id");

-- Set default for service_level based on service_id format
-- Level 1 = category only (e.g., "1")
-- Level 2 = subcategory (e.g., "1.1")  
-- Level 3 = type (e.g., "1.1.1")
UPDATE "performer_services" 
SET service_level = 
  CASE 
    WHEN service_id ~ '^\d+$' THEN 1
    WHEN service_id ~ '^\d+\.\d+$' THEN 2
    WHEN service_id ~ '^\d+\.\d+\.\d+$' THEN 3
    ELSE 3
  END;
