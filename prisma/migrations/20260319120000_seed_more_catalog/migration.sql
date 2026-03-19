INSERT INTO service_categories (id, name, sort, created_at, updated_at)
VALUES ('plowing', 'Вспашка', 20, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO service_subcategories (id, category_id, name, sort, created_at, updated_at)
VALUES ('deep', 'plowing', 'Глубокая вспашка', 10, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO service_types (id, subcategory_id, name, sort, price_per_ha, min_price, currency, created_at, updated_at)
VALUES ('standard', 'deep', 'Стандарт', 10, 400.00, 0.00, 'UAH', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
