INSERT INTO service_categories (id, name, sort, created_at, updated_at)
VALUES
  ('plowing', 'Вспашка', 20, NOW(), NOW()),
  ('cultivation', 'Культивация', 30, NOW(), NOW()),
  ('sowing', 'Посев', 40, NOW(), NOW()),
  ('harvesting', 'Уборка', 50, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  sort = EXCLUDED.sort,
  updated_at = NOW();

INSERT INTO service_subcategories (id, category_id, name, sort, created_at, updated_at)
VALUES
  ('deep', 'plowing', 'Глубокая вспашка', 10, NOW(), NOW()),
  ('shallow', 'plowing', 'Поверхностная вспашка', 20, NOW(), NOW()),
  ('pre_sowing', 'cultivation', 'Предпосевная культивация', 10, NOW(), NOW()),
  ('grains', 'sowing', 'Зерновые', 10, NOW(), NOW()),
  ('technical', 'sowing', 'Технические культуры', 20, NOW(), NOW()),
  ('combine', 'harvesting', 'Комбайном', 10, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  category_id = EXCLUDED.category_id,
  name = EXCLUDED.name,
  sort = EXCLUDED.sort,
  updated_at = NOW();

INSERT INTO service_types (subcategory_id, id, name, sort, price_per_ha, min_price, currency, created_at, updated_at)
VALUES
  ('deep', 'standard', 'Стандарт', 10, 400.00, 0.00, 'UAH', NOW(), NOW()),
  ('deep', 'reinforced', 'Усиленный', 20, 500.00, 0.00, 'UAH', NOW(), NOW()),
  ('shallow', 'light', 'Лёгкий', 10, 300.00, 0.00, 'UAH', NOW(), NOW()),

  ('pre_sowing', 'shallow', 'Неглубокая', 10, 250.00, 0.00, 'UAH', NOW(), NOW()),
  ('pre_sowing', 'deep', 'Глубокая', 20, 350.00, 0.00, 'UAH', NOW(), NOW()),

  ('grains', 'wheat', 'Пшеница', 10, 200.00, 0.00, 'UAH', NOW(), NOW()),
  ('grains', 'barley', 'Ячмень', 20, 190.00, 0.00, 'UAH', NOW(), NOW()),
  ('grains', 'corn', 'Кукуруза', 30, 220.00, 0.00, 'UAH', NOW(), NOW()),

  ('technical', 'sunflower', 'Подсолнечник', 10, 230.00, 0.00, 'UAH', NOW(), NOW()),
  ('technical', 'rapeseed', 'Рапс', 20, 240.00, 0.00, 'UAH', NOW(), NOW()),

  ('combine', 'grains', 'Зерновые', 10, 600.00, 0.00, 'UAH', NOW(), NOW()),
  ('combine', 'corn', 'Кукуруза', 20, 650.00, 0.00, 'UAH', NOW(), NOW())
ON CONFLICT (subcategory_id, id) DO UPDATE SET
  name = EXCLUDED.name,
  sort = EXCLUDED.sort,
  price_per_ha = EXCLUDED.price_per_ha,
  min_price = EXCLUDED.min_price,
  currency = EXCLUDED.currency,
  updated_at = NOW();
