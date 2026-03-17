CREATE EXTENSION IF NOT EXISTS postgis;

CREATE OR REPLACE FUNCTION set_geography_point_from_lat_lng(lat numeric, lng numeric)
RETURNS geography AS $$
  SELECT ST_SetSRID(ST_MakePoint(lng::double precision, lat::double precision), 4326)::geography;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION orders_sync_location_geo()
RETURNS trigger AS $$
BEGIN
  NEW.location_geo := set_geography_point_from_lat_lng(NEW.lat, NEW.lng);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orders_sync_location_geo ON orders;
CREATE TRIGGER trg_orders_sync_location_geo
BEFORE INSERT OR UPDATE OF lat, lng ON orders
FOR EACH ROW
EXECUTE FUNCTION orders_sync_location_geo();

CREATE OR REPLACE FUNCTION performer_settings_sync_base_geo()
RETURNS trigger AS $$
BEGIN
  NEW.base_geo := set_geography_point_from_lat_lng(NEW.base_lat, NEW.base_lng);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_performer_settings_sync_base_geo ON performer_settings;
CREATE TRIGGER trg_performer_settings_sync_base_geo
BEFORE INSERT OR UPDATE OF base_lat, base_lng ON performer_settings
FOR EACH ROW
EXECUTE FUNCTION performer_settings_sync_base_geo();

CREATE OR REPLACE FUNCTION fields_sync_centroid_geo()
RETURNS trigger AS $$
BEGIN
  IF NEW.centroid_lat IS NULL OR NEW.centroid_lng IS NULL THEN
    NEW.centroid_geo := NULL;
  ELSE
    NEW.centroid_geo := set_geography_point_from_lat_lng(NEW.centroid_lat, NEW.centroid_lng);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fields_sync_centroid_geo ON fields;
CREATE TRIGGER trg_fields_sync_centroid_geo
BEFORE INSERT OR UPDATE OF centroid_lat, centroid_lng ON fields
FOR EACH ROW
EXECUTE FUNCTION fields_sync_centroid_geo();

CREATE INDEX IF NOT EXISTS idx_orders_location_geo_gist
ON orders USING GIST (location_geo);

CREATE INDEX IF NOT EXISTS idx_performer_settings_base_geo_gist
ON performer_settings USING GIST (base_geo);

CREATE INDEX IF NOT EXISTS idx_fields_centroid_geo_gist
ON fields USING GIST (centroid_geo);

ALTER TABLE orders
  ADD CONSTRAINT chk_orders_budget_positive CHECK (budget > 0),
  ADD CONSTRAINT chk_orders_area_positive CHECK (area_ha > 0);

ALTER TABLE performer_settings
  ADD CONSTRAINT chk_radius_km_range CHECK (radius_km IS NULL OR (radius_km >= 0 AND radius_km <= 500));
