-- CreateIndex
CREATE INDEX "idx_fields_centroid_geo_gist" ON "fields" USING GIST ("centroid_geo");

-- CreateIndex
CREATE INDEX "idx_orders_location_geo_gist" ON "orders" USING GIST ("location_geo");

-- CreateIndex
CREATE INDEX "idx_performer_settings_base_geo_gist" ON "performer_settings" USING GIST ("base_geo");
