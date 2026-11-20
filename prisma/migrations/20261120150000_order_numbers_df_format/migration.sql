-- Update existing orders to DF-XXXXX format starting from 1001
UPDATE "orders" o
SET "order_number" = n.code
FROM (
  SELECT
    id,
    'DF-' || LPAD((ROW_NUMBER() OVER (ORDER BY created_at, id) + 1000)::text, 5, '0') AS code
  FROM "orders"
) n
WHERE o.id = n.id;

-- Initialize or update order_number_counters with DF sequence
INSERT INTO "order_number_counters" ("service_code", "yy", "last_seq")
VALUES (
  'DF',
  0,
  COALESCE((SELECT COUNT(*) + 1000 FROM "orders"), 1000)
)
ON CONFLICT ("service_code", "yy")
DO UPDATE SET "last_seq" = GREATEST("order_number_counters"."last_seq", EXCLUDED."last_seq");
