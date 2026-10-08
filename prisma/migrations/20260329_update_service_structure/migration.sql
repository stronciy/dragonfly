-- Migration: Update service catalog to new hierarchical structure
-- This migration REPLACES existing service data with new structure

-- Clear existing data (in correct order due to foreign keys)
-- First delete dependent records
DELETE FROM performer_services;
DELETE FROM orders;
DELETE FROM service_types;
DELETE FROM service_subcategories;
DELETE FROM service_categories;

-- Reset sequences if needed (optional, depends on your setup)

-- Insert new categories
INSERT INTO service_categories (id, name, name_ua, icon_key, sort, created_at, updated_at) VALUES
  ('1', 'Підготовка ґрунту', 'Підготовка ґрунту', NULL, 10, NOW(), NOW()),
  ('2', 'Посів', 'Посів', 'Сівалки', 20, NOW(), NOW()),
  ('3', 'Внесення ЗЗР, добрив', 'Внесення ЗЗР, добрив', 'Оприскувачі', 30, NOW(), NOW()),
  ('4', 'Збір врожаю', 'Збір врожаю', 'Комбайни', 40, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  name_ua = EXCLUDED.name_ua,
  icon_key = EXCLUDED.icon_key,
  sort = EXCLUDED.sort,
  updated_at = NOW();

-- Insert new subcategories
-- Category 1: Підготовка ґрунту
INSERT INTO service_subcategories (id, category_id, name, name_ua, icon_key, sort, created_at, updated_at) VALUES
  ('1.1', '1', 'Дискування', 'Дискування', NULL, 10, NOW(), NOW()),
  ('1.2', '1', 'Рихлення', 'Рихлення', NULL, 20, NOW(), NOW()),
  ('1.3', '1', 'Оранка', 'Оранка', NULL, 30, NOW(), NOW()),
  ('1.4', '1', 'Подрібнення', 'Подрібнення', NULL, 40, NOW(), NOW()),
  ('1.5', '1', 'Лущення', 'Лущення', NULL, 50, NOW(), NOW()),
  ('1.6', '1', 'Культивація', 'Культивація', NULL, 60, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  category_id = EXCLUDED.category_id,
  name = EXCLUDED.name,
  name_ua = EXCLUDED.name_ua,
  sort = EXCLUDED.sort,
  updated_at = NOW();

-- Category 2: Посів
INSERT INTO service_subcategories (id, category_id, name, name_ua, icon_key, sort, created_at, updated_at) VALUES
  ('2.1', '2', 'Суцільного висіву', 'Суцільного висіву', NULL, 10, NOW(), NOW()),
  ('2.2', '2', 'Широкорядні', 'Широкорядні', NULL, 20, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  category_id = EXCLUDED.category_id,
  name = EXCLUDED.name,
  name_ua = EXCLUDED.name_ua,
  sort = EXCLUDED.sort,
  updated_at = NOW();

-- Category 3: Внесення ЗЗР, добрив
INSERT INTO service_subcategories (id, category_id, name, name_ua, icon_key, sort, created_at, updated_at) VALUES
  ('3.1', '3', 'Дрони', 'Дрони', NULL, 10, NOW(), NOW()),
  ('3.2', '3', 'Причепні', 'Причепні', NULL, 20, NOW(), NOW()),
  ('3.3', '3', 'Самохідні', 'Самохідні', NULL, 30, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  category_id = EXCLUDED.category_id,
  name = EXCLUDED.name,
  name_ua = EXCLUDED.name_ua,
  sort = EXCLUDED.sort,
  updated_at = NOW();

-- Category 4: Збір врожаю
INSERT INTO service_subcategories (id, category_id, name, name_ua, icon_key, sort, created_at, updated_at) VALUES
  ('4.1', '4', 'Зернозбиральні', 'Зернозбиральні', NULL, 10, NOW(), NOW()),
  ('4.2', '4', 'Бурякозбиральні', 'Бурякозбиральні', NULL, 20, NOW(), NOW()),
  ('4.3', '4', 'Кормозбиральні', 'Кормозбиральні', NULL, 30, NOW(), NOW()),
  ('4.4', '4', 'Овочезбиральні', 'Овочезбиральні', NULL, 40, NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET
  category_id = EXCLUDED.category_id,
  name = EXCLUDED.name,
  name_ua = EXCLUDED.name_ua,
  sort = EXCLUDED.sort,
  updated_at = NOW();

-- Insert service types (with Level 3 for some subcategories)
-- Subcategory 2.1: Суцільного висіву
INSERT INTO service_types (subcategory_id, id, name, name_ua, sort, created_at, updated_at) VALUES
  ('2.1', '2.1.1', 'Анкерні', 'Анкерні', 10, NOW(), NOW()),
  ('2.1', '2.1.2', 'Дискові', 'Дискові', 20, NOW(), NOW())
ON CONFLICT (subcategory_id, id) DO UPDATE SET
  name = EXCLUDED.name,
  name_ua = EXCLUDED.name_ua,
  sort = EXCLUDED.sort,
  updated_at = NOW();

-- Subcategory 2.2: Широкорядні
INSERT INTO service_types (subcategory_id, id, name, name_ua, sort, created_at, updated_at) VALUES
  ('2.2', '2.2.1', 'Анкерні', 'Анкерні', 10, NOW(), NOW()),
  ('2.2', '2.2.2', 'Дискові', 'Дискові', 20, NOW(), NOW())
ON CONFLICT (subcategory_id, id) DO UPDATE SET
  name = EXCLUDED.name,
  name_ua = EXCLUDED.name_ua,
  sort = EXCLUDED.sort,
  updated_at = NOW();

-- Subcategory 4.1: Зернозбиральні
INSERT INTO service_types (subcategory_id, id, name, name_ua, sort, created_at, updated_at) VALUES
  ('4.1', '4.1.1', 'Роторні', 'Роторні', 10, NOW(), NOW()),
  ('4.1', '4.1.2', 'Барабанні', 'Барабанні', 20, NOW(), NOW()),
  ('4.1', '4.1.3', 'Гібридні', 'Гібридні', 30, NOW(), NOW())
ON CONFLICT (subcategory_id, id) DO UPDATE SET
  name = EXCLUDED.name,
  name_ua = EXCLUDED.name_ua,
  sort = EXCLUDED.sort,
  updated_at = NOW();

-- Note: Subcategories 1.1-1.6, 3.1-3.3, 4.2-4.4 have no types (leaf subcategories)
-- They can have specs defined in the application layer
