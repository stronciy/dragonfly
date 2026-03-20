-- Drop spatial triggers
DROP TRIGGER IF EXISTS trg_orders_sync_location_geo ON orders;
DROP TRIGGER IF EXISTS trg_performer_settings_sync_base_geo ON performer_settings;
DROP TRIGGER IF EXISTS trg_fields_sync_centroid_geo ON fields;

-- Drop spatial functions
DROP FUNCTION IF EXISTS orders_sync_location_geo();
DROP FUNCTION IF EXISTS performer_settings_sync_base_geo();
DROP FUNCTION IF EXISTS fields_sync_centroid_geo();
DROP FUNCTION IF EXISTS set_geography_point_from_lat_lng(numeric, numeric);

-- Drop spatial columns and indices
ALTER TABLE "fields" DROP COLUMN IF EXISTS "centroid_geo";
ALTER TABLE "orders" DROP COLUMN IF EXISTS "location_geo";
ALTER TABLE "performer_settings" DROP COLUMN IF EXISTS "base_geo";

-- Drop PostGIS extension
DROP EXTENSION IF EXISTS postgis;
