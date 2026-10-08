-- Drop legacy performer_services columns breaking createMany on prod
-- (PUT /api/v1/performer/settings 500 `Null constraint violation`).
--
-- History: 20260329_hierarchical_performer_services replaced
-- (service_category_id, service_subcategory_id, service_type_id) with
-- (service_id, service_level), but the P3005 baseline skipped its SQL while
-- the previous repair deliberately kept the old columns (data preservation).
-- The old columns are NOT NULL without defaults, while the app now writes
-- only the new ones via deleteMany + createMany — every insert violates the
-- NOT NULL constraint. Verified: no code reads the legacy columns anymore
-- (matching uses psvc.service_id; o.service_* hits belong to orders).
-- IF EXISTS keeps this safe on DBs where the original migration already ran.

ALTER TABLE "performer_services"
  DROP COLUMN IF EXISTS "service_category_id",
  DROP COLUMN IF EXISTS "service_subcategory_id",
  DROP COLUMN IF EXISTS "service_type_id";
