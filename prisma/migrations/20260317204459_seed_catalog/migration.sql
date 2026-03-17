INSERT INTO service_categories (id, name, sort, created_at, updated_at)
VALUES ('spraying', 'Опрыскивание', 10, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO service_subcategories (id, category_id, name, sort, created_at, updated_at)
VALUES ('pesticide', 'spraying', 'Опрыскивание (СЗР)', 10, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO service_types (id, subcategory_id, name, sort, price_per_ha, min_price, currency, created_at, updated_at)
VALUES ('type-a', 'pesticide', 'Опрыскивание — базовый тариф', 10, 100.00, 0.00, 'UAH', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO crops (id, name, icon_key, sort, created_at, updated_at)
VALUES ('wheat', 'Пшеница', 'wheat', 10, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
