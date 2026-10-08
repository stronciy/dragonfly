-- Seed the hierarchical service catalog missing on prod
-- (POST /api/v1/orders/quote 404 `Service category not found` for id "1").
--
-- History: the P3005 baseline (f254cb6) marked all catalog migrations applied
-- without running their SQL, so prod lacks the current ("1"/"1.1"-style) rows
-- that the app and services-tree.ts expect. The API reads the catalog from
-- the DB (catalog/services, quote, orders), hence the 404.
-- Data matches 20260329_update_service_structure + services-tree.ts.
-- Pure UPSERT, no DELETEs (the original migration wiped orders — never again).
-- No ON CONFLICT anywhere: arbiters require matching unique constraints, and
-- prod table shapes are unknown (baselined history). INSERT...WHERE NOT EXISTS
-- plus plain UPDATEs need no constraints at all.
-- service_types additionally branches on the local column shape (updated_at
-- was dropped at some point), detected via information_schema.

-- ---------------------------------------------------------------------------
-- 0) Ensure tables + i18n columns exist (no-op when already there)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "service_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ua" TEXT,
    "icon_key" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "service_subcategories" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ua" TEXT,
    "icon_key" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "service_subcategories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "service_types" (
    "subcategory_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ua" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "service_types_pkey" PRIMARY KEY ("subcategory_id", "id")
);

ALTER TABLE "service_categories" ADD COLUMN IF NOT EXISTS "name_ua" TEXT;
ALTER TABLE "service_categories" ADD COLUMN IF NOT EXISTS "icon_key" TEXT;
ALTER TABLE "service_subcategories" ADD COLUMN IF NOT EXISTS "name_ua" TEXT;
ALTER TABLE "service_subcategories" ADD COLUMN IF NOT EXISTS "icon_key" TEXT;
ALTER TABLE "service_types" ADD COLUMN IF NOT EXISTS "name_ua" TEXT;

-- ---------------------------------------------------------------------------
-- 1) Categories (constraint-free upsert loop)
-- ---------------------------------------------------------------------------
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('1', 'Підготовка ґрунту', 'Підготовка ґрунту', NULL, 10),
    ('2', 'Посів', 'Посів', 'Сівалки', 20),
    ('3', 'Внесення ЗЗР, добрив', 'Внесення ЗЗР, добрив', 'Оприскувачі', 30),
    ('4', 'Збір врожаю', 'Збір врожаю', 'Комбайни', 40)
  ) AS v(id, name, name_ua, icon_key, sort) LOOP
    INSERT INTO service_categories (id, name, name_ua, icon_key, sort, created_at, updated_at)
    SELECT r.id, r.name, r.name_ua, r.icon_key, r.sort, NOW(), NOW()
    WHERE NOT EXISTS (SELECT 1 FROM service_categories WHERE id = r.id);
    UPDATE service_categories
    SET name = r.name, name_ua = r.name_ua, icon_key = r.icon_key, sort = r.sort, updated_at = NOW()
    WHERE id = r.id;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Subcategories (constraint-free upsert loop)
-- ---------------------------------------------------------------------------
DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('1.1', '1', 'Дискування', 'Дискування', NULL, 10),
    ('1.2', '1', 'Рихлення', 'Рихлення', NULL, 20),
    ('1.3', '1', 'Оранка', 'Оранка', NULL, 30),
    ('1.4', '1', 'Подрібнення', 'Подрібнення', NULL, 40),
    ('1.5', '1', 'Лущення', 'Лущення', NULL, 50),
    ('1.6', '1', 'Культивація', 'Культивація', NULL, 60),
    ('2.1', '2', 'Суцільного висіву', 'Суцільного висіву', NULL, 10),
    ('2.2', '2', 'Широкорядні', 'Широкорядні', NULL, 20),
    ('3.1', '3', 'Дрони', 'Дрони', NULL, 10),
    ('3.2', '3', 'Причепні', 'Причепні', NULL, 20),
    ('3.3', '3', 'Самохідні', 'Самохідні', NULL, 30),
    ('4.1', '4', 'Зернозбиральні', 'Зернозбиральні', NULL, 10),
    ('4.2', '4', 'Бурякозбиральні', 'Бурякозбиральні', NULL, 20),
    ('4.3', '4', 'Кормозбиральні', 'Кормозбиральні', NULL, 30),
    ('4.4', '4', 'Овочезбиральні', 'Овочезбиральні', NULL, 40)
  ) AS v(id, category_id, name, name_ua, icon_key, sort) LOOP
    INSERT INTO service_subcategories (id, category_id, name, name_ua, icon_key, sort, created_at, updated_at)
    SELECT r.id, r.category_id, r.name, r.name_ua, r.icon_key, r.sort, NOW(), NOW()
    WHERE NOT EXISTS (SELECT 1 FROM service_subcategories WHERE id = r.id);
    UPDATE service_subcategories
    SET category_id = r.category_id, name = r.name, name_ua = r.name_ua, sort = r.sort, updated_at = NOW()
    WHERE id = r.id;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Service types (PK shape differs across envs: single id vs composite).
--    Guarded INSERTs pick the column list matching the local table shape;
--    refresh UPDATEs touch only columns guaranteed present.
-- ---------------------------------------------------------------------------
-- Shape A: current (no updated_at, composite PK)
INSERT INTO service_types (subcategory_id, id, name, name_ua, sort, created_at)
SELECT v.subcategory_id, v.id, v.name, v.name_ua, v.sort, NOW()
FROM (VALUES
  ('2.1', '2.1.1', 'Анкерні', 'Анкерні', 10),
  ('2.1', '2.1.2', 'Дискові', 'Дискові', 20),
  ('2.2', '2.2.1', 'Анкерні', 'Анкерні', 10),
  ('2.2', '2.2.2', 'Дискові', 'Дискові', 20),
  ('4.1', '4.1.1', 'Роторні', 'Роторні', 10),
  ('4.1', '4.1.2', 'Барабанні', 'Барабанні', 20),
  ('4.1', '4.1.3', 'Гібридні', 'Гібридні', 30)
) AS v(subcategory_id, id, name, name_ua, sort)
WHERE NOT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'service_types' AND column_name = 'updated_at'
)
AND NOT EXISTS (
  SELECT 1 FROM service_types t
  WHERE t.subcategory_id = v.subcategory_id AND t.id = v.id
);

-- Shape B: legacy (has updated_at, any PK shape)
INSERT INTO service_types (subcategory_id, id, name, name_ua, sort, created_at, updated_at)
SELECT v.subcategory_id, v.id, v.name, v.name_ua, v.sort, NOW(), NOW()
FROM (VALUES
  ('2.1', '2.1.1', 'Анкерні', 'Анкерні', 10),
  ('2.1', '2.1.2', 'Дискові', 'Дискові', 20),
  ('2.2', '2.2.1', 'Анкерні', 'Анкерні', 10),
  ('2.2', '2.2.2', 'Дискові', 'Дискові', 20),
  ('4.1', '4.1.1', 'Роторні', 'Роторні', 10),
  ('4.1', '4.1.2', 'Барабанні', 'Барабанні', 20),
  ('4.1', '4.1.3', 'Гібридні', 'Гібридні', 30)
) AS v(subcategory_id, id, name, name_ua, sort)
WHERE EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'service_types' AND column_name = 'updated_at'
)
AND NOT EXISTS (
  SELECT 1 FROM service_types t
  WHERE t.subcategory_id = v.subcategory_id AND t.id = v.id
);

-- Refresh names/sort on rows that already exist (both shapes)
UPDATE service_types AS t SET
  name = v.name,
  name_ua = v.name_ua,
  sort = v.sort
FROM (VALUES
  ('2.1', '2.1.1', 'Анкерні', 'Анкерні', 10),
  ('2.1', '2.1.2', 'Дискові', 'Дискові', 20),
  ('2.2', '2.2.1', 'Анкерні', 'Анкерні', 10),
  ('2.2', '2.2.2', 'Дискові', 'Дискові', 20),
  ('4.1', '4.1.1', 'Роторні', 'Роторні', 10),
  ('4.1', '4.1.2', 'Барабанні', 'Барабанні', 20),
  ('4.1', '4.1.3', 'Гібридні', 'Гібридні', 30)
) AS v(subcategory_id, id, name, name_ua, sort)
WHERE t.subcategory_id = v.subcategory_id AND t.id = v.id;

-- Backfill i18n names where still NULL
UPDATE "service_categories" SET name_ua = name WHERE name_ua IS NULL;
UPDATE "service_subcategories" SET name_ua = name WHERE name_ua IS NULL;
UPDATE "service_types" SET name_ua = name WHERE name_ua IS NULL;
