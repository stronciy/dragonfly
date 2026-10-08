-- CreateTable
CREATE TABLE "early_start_requests" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "early_start_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "early_start_requests_order_id_created_at_idx" ON "early_start_requests"("order_id", "created_at");

-- AddForeignKey
ALTER TABLE "early_start_requests" ADD CONSTRAINT "early_start_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "early_start_requests" ADD CONSTRAINT "early_start_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
