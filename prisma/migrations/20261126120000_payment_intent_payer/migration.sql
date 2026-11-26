-- Виконавець, що вніс заставу. Старі записи заповнюються для останнього платежу
-- виконавця за заказом, у якого вже є поточний виконавець.
ALTER TABLE "payment_intents" ADD COLUMN "payer_user_id" TEXT;

UPDATE "payment_intents" pi
SET "payer_user_id" = o."performer_user_id"
FROM "orders" o
WHERE pi."order_id" = o."id"
  AND pi."role" = 'performer'
  AND pi."payer_user_id" IS NULL
  AND o."performer_user_id" IS NOT NULL
  AND pi."id" = (
    SELECT p2."id" FROM "payment_intents" p2
    WHERE p2."order_id" = pi."order_id" AND p2."role" = 'performer' AND p2."paid_at" IS NOT NULL
    ORDER BY p2."paid_at" DESC
    LIMIT 1
  );
