-- CreateEnum
CREATE TYPE "TaxSystem" AS ENUM ('FOP_2', 'FOP_3', 'LLC', 'OTHER');

-- AlterTable
ALTER TABLE "customer_profiles" ADD COLUMN     "iban" TEXT,
ADD COLUMN     "legal_address" TEXT,
ADD COLUMN     "tax_system" "TaxSystem",
ADD COLUMN     "vat_payer" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "biometrics_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "two_factor_enabled_at" TIMESTAMP(3),
ADD COLUMN     "two_factor_secret" TEXT;

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "performer_user_id" TEXT NOT NULL,
    "author_user_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_setups" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "two_factor_setups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_crop_stats" (
    "id" TEXT NOT NULL,
    "customer_user_id" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "crop_id" TEXT NOT NULL,
    "area_ha" DECIMAL(10,2) NOT NULL,
    "yield_t" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_crop_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reviews_performer_user_id_created_at_idx" ON "reviews"("performer_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_order_id_author_user_id_key" ON "reviews"("order_id", "author_user_id");

-- CreateIndex
CREATE INDEX "two_factor_setups_user_id_idx" ON "two_factor_setups"("user_id");

-- CreateIndex
CREATE INDEX "two_factor_setups_expires_at_idx" ON "two_factor_setups"("expires_at");

-- CreateIndex
CREATE INDEX "customer_crop_stats_customer_user_id_season_idx" ON "customer_crop_stats"("customer_user_id", "season");

-- CreateIndex
CREATE UNIQUE INDEX "customer_crop_stats_customer_user_id_season_crop_id_key" ON "customer_crop_stats"("customer_user_id", "season", "crop_id");

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_performer_user_id_fkey" FOREIGN KEY ("performer_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_setups" ADD CONSTRAINT "two_factor_setups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_crop_stats" ADD CONSTRAINT "customer_crop_stats_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "customer_profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_crop_stats" ADD CONSTRAINT "customer_crop_stats_crop_id_fkey" FOREIGN KEY ("crop_id") REFERENCES "crops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
