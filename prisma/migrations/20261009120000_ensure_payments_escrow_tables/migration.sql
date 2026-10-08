-- Ensure deposit-flow tables missing on prod (GET /api/v1/orders 500:
-- `table public.escrow_locks does not exist`).
--
-- History: the P3005 baseline (f254cb6) marked 20260330_payments_escrow as
-- applied without running its SQL. GET /api/v1/orders selects `escrowLocks`
-- inside `prisma.order.findMany` (see src/app/api/v1/orders/route.ts), so the
-- missing table 500s the whole list. payment_intents comes from the same
-- migration and has the same gap, so it is created here too.
-- All statements are idempotent and transaction-safe (no ALTER TYPE, no
-- drops); the UNIQUE index is created only when no duplicates exist.

CREATE TABLE IF NOT EXISTS "payment_intents" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'UAH',
    "provider" TEXT NOT NULL DEFAULT 'liqpay',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider_order_id" TEXT,
    "data" TEXT,
    "signature" TEXT,
    "server_url" TEXT,
    "result_url" TEXT,
    "provider_raw" JSONB,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "payment_intents_order_id_idx" ON "payment_intents"("order_id");
CREATE INDEX IF NOT EXISTS "payment_intents_status_idx" ON "payment_intents"("status");

CREATE TABLE IF NOT EXISTS "escrow_locks" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'held',
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "escrow_locks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "escrow_locks_user_id_idx" ON "escrow_locks"("user_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uniq_order_role_lock') THEN
    IF NOT EXISTS (
      SELECT 1 FROM "escrow_locks" GROUP BY "order_id", "role" HAVING COUNT(*) > 1
    ) THEN
      CREATE UNIQUE INDEX "uniq_order_role_lock" ON "escrow_locks"("order_id", "role");
    END IF;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_intents_order_id_fkey') THEN
    ALTER TABLE "payment_intents"
    ADD CONSTRAINT "payment_intents_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'escrow_locks_order_id_fkey') THEN
    ALTER TABLE "escrow_locks"
    ADD CONSTRAINT "escrow_locks_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
