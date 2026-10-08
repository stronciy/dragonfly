-- Spatial functions and triggers removed

ALTER TABLE orders
  ADD CONSTRAINT chk_orders_budget_positive CHECK (budget > 0),
  ADD CONSTRAINT chk_orders_area_positive CHECK (area_ha > 0);

ALTER TABLE performer_settings
  ADD CONSTRAINT chk_radius_km_range CHECK (radius_km IS NULL OR (radius_km >= 0 AND radius_km <= 500));
