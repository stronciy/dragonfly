-- CreateEnum
CREATE TYPE "OrderMediaKind" AS ENUM ('report', 'arbitration');

-- CreateTable
CREATE TABLE "order_media" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "OrderMediaKind" NOT NULL,
    "name" TEXT,
    "mime_type" TEXT,
    "size" INTEGER,
    "url" TEXT NOT NULL,
    "caption" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_media_order_id_created_at_idx" ON "order_media"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "order_media_user_id_kind_created_at_idx" ON "order_media"("user_id", "kind", "created_at");

-- AddForeignKey
ALTER TABLE "order_media" ADD CONSTRAINT "order_media_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_media" ADD CONSTRAINT "order_media_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "uniq_order_role_lock" RENAME TO "escrow_locks_order_id_role_key";
