-- AlterTable
ALTER TABLE "customer_profiles" ADD COLUMN     "risk_score" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "order_applications" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "performer_user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'apply',
    "message" TEXT,
    "proposed_price_uah" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "order_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_applications_order_id_status_created_at_idx" ON "order_applications"("order_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "order_applications_performer_user_id_status_created_at_idx" ON "order_applications"("performer_user_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "order_applications_order_id_performer_user_id_key" ON "order_applications"("order_id", "performer_user_id");

-- AddForeignKey
ALTER TABLE "order_applications" ADD CONSTRAINT "order_applications_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_applications" ADD CONSTRAINT "order_applications_performer_user_id_fkey" FOREIGN KEY ("performer_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

