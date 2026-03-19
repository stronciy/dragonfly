INSERT INTO service_subcategories (id, category_id, name, sort, price_per_ha, min_price, currency, created_at, updated_at)
VALUES ('inter_row', 'cultivation', 'Міжрядна культивація', 20, 250.00, 0.00, 'UAH', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

