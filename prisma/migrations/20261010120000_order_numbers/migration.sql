-- Public numeric order number SSYYNNNNN (9 digits):
-- SS  = top-level service code, zero padded (serviceCategoryId "1" -> "01")
-- YY  = creation year, last two digits
-- NNNNN = sequence per (service, year), starting at 1.
CREATE TABLE IF NOT EXISTS "order_number_counters" (
  "service_code" TEXT NOT NULL,
  "yy" INTEGER NOT NULL,
  "last_seq" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "order_number_counters_pkey" PRIMARY KEY ("service_code", "yy")
);

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "order_number" TEXT;

UPDATE "orders" o
SET "order_number" = n.code
FROM (
  SELECT
    id,
    LPAD(service_category_id, 2, '0')
      || LPAD((EXTRACT(YEAR FROM created_at)::int % 100)::text, 2, '0')
      || LPAD(ROW_NUMBER() OVER (
           PARTITION BY service_category_id, EXTRACT(YEAR FROM created_at)
           ORDER BY created_at, id
         )::text, 5, '0') AS code
  FROM "orders"
) n
WHERE o.id = n.id AND o.order_number IS NULL;

INSERT INTO "order_number_counters" ("service_code", "yy", "last_seq")
SELECT
  LPAD(service_category_id, 2, '0'),
  EXTRACT(YEAR FROM created_at)::int % 100,
  COUNT(*)
FROM "orders"
GROUP BY service_category_id, EXTRACT(YEAR FROM created_at)
ON CONFLICT ("service_code", "yy") DO UPDATE SET "last_seq" = EXCLUDED."last_seq";

CREATE UNIQUE INDEX IF NOT EXISTS "orders_order_number_key" ON "orders" ("order_number");
