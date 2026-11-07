-- Заявки виконавців на виведення коштів.
CREATE TABLE "payouts" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'UAH',
  "iban" TEXT NOT NULL,
  "account_name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  "processed_by_admin_id" TEXT,
  "reject_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payouts_user_id_status_idx" ON "payouts"("user_id", "status");
CREATE INDEX "payouts_status_requested_at_idx" ON "payouts"("status", "requested_at");

ALTER TABLE "payouts" ADD CONSTRAINT "payouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
