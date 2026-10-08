-- AlterEnum
ALTER TYPE "OrderMediaKind" ADD VALUE 'progress';

-- AlterTable
ALTER TABLE "order_media" ADD COLUMN     "progress_id" TEXT;

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "customer_user_id" TEXT,
ALTER COLUMN "performer_user_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "work_progress_updates" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "percent" INTEGER,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_progress_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arbitration_resolutions" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "proposed_by_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "rating" INTEGER,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "arbitration_resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_progress_updates_order_id_created_at_idx" ON "work_progress_updates"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "arbitration_resolutions_order_id_created_at_idx" ON "arbitration_resolutions"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "order_media_progress_id_idx" ON "order_media"("progress_id");

-- CreateIndex
CREATE INDEX "reviews_customer_user_id_created_at_idx" ON "reviews"("customer_user_id", "created_at");

-- CreateIndex
CREATE INDEX "reviews_order_id_author_user_id_idx" ON "reviews"("order_id", "author_user_id");

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_media" ADD CONSTRAINT "order_media_progress_id_fkey" FOREIGN KEY ("progress_id") REFERENCES "work_progress_updates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_progress_updates" ADD CONSTRAINT "work_progress_updates_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_progress_updates" ADD CONSTRAINT "work_progress_updates_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arbitration_resolutions" ADD CONSTRAINT "arbitration_resolutions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arbitration_resolutions" ADD CONSTRAINT "arbitration_resolutions_proposed_by_id_fkey" FOREIGN KEY ("proposed_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
