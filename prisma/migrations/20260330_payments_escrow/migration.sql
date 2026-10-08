-- Recreate payment intents and escrow locks for the deposit flow
-- (dropped in 20260329214130_30_march, now required by customer-intent /
-- performer-intent / payments confirm routes)

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

ALTER TABLE "payment_intents"
ADD CONSTRAINT "payment_intents_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_order_role_lock" ON "escrow_locks"("order_id", "role");
CREATE INDEX IF NOT EXISTS "escrow_locks_user_id_idx" ON "escrow_locks"("user_id");

ALTER TABLE "escrow_locks"
ADD CONSTRAINT "escrow_locks_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
