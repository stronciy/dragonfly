-- AlterTable
ALTER TABLE "orders" ADD COLUMN "specs" JSONB DEFAULT '{}';

-- CreateIndex
CREATE INDEX "orders_specs_idx" ON "orders" USING GIN ("specs");
