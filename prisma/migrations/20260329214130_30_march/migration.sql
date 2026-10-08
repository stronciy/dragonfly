/*
  Warnings:

  - The values [FOP_2,FOP_3,LLC,OTHER] on the enum `TaxSystem` will be removed. If these variants are still used in the database, this will fail.
  - You are about to alter the column `area_ha` on the `customer_crop_stats` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,2)` to `DoublePrecision`.
  - You are about to alter the column `yield_t` on the `customer_crop_stats` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,2)` to `DoublePrecision`.
  - The `platform` column on the `devices` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `centroid_lat` on the `fields` table. All the data in the column will be lost.
  - You are about to drop the column `centroid_lng` on the `fields` table. All the data in the column will be lost.
  - You are about to drop the column `geometry` on the `fields` table. All the data in the column will be lost.
  - You are about to drop the column `region_name` on the `fields` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `fields` table. All the data in the column will be lost.
  - You are about to alter the column `area_ha` on the `fields` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,2)` to `DoublePrecision`.
  - The `type` column on the `notifications` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `distance_km` on the `order_matches` table. All the data in the column will be lost.
  - You are about to drop the column `at` on the `order_status_events` table. All the data in the column will be lost.
  - You are about to drop the column `from_status` on the `order_status_events` table. All the data in the column will be lost.
  - You are about to drop the column `to_status` on the `order_status_events` table. All the data in the column will be lost.
  - You are about to drop the column `evidence_photos` on the `orders` table. All the data in the column will be lost.
  - You are about to alter the column `area_ha` on the `orders` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,2)` to `DoublePrecision`.
  - You are about to alter the column `lat` on the `orders` table. The data in that column could be lost. The data in that column will be cast from `Decimal(9,6)` to `DoublePrecision`.
  - You are about to alter the column `lng` on the `orders` table. The data in that column could be lost. The data in that column will be cast from `Decimal(9,6)` to `DoublePrecision`.
  - The `status` column on the `orders` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `tax_system` column on the `performer_profiles` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `currency` on the `service_subcategories` table. All the data in the column will be lost.
  - You are about to drop the column `min_price` on the `service_subcategories` table. All the data in the column will be lost.
  - You are about to drop the column `price_per_ha` on the `service_subcategories` table. All the data in the column will be lost.
  - You are about to drop the column `currency` on the `service_types` table. All the data in the column will be lost.
  - You are about to drop the column `min_price` on the `service_types` table. All the data in the column will be lost.
  - You are about to drop the column `price_per_ha` on the `service_types` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `service_types` table. All the data in the column will be lost.
  - You are about to drop the `agreement_documents` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `agreements` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `arbitration_cases` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `arbitration_media` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `escrow_locks` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `order_report_media` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `payments` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `payouts` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `performer_settings` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `reserve_transactions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `two_factor_setups` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[name]` on the table `crops` will be added. If there are existing duplicate values, this will fail.
  - Made the column `specs` on table `orders` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "TaxSystem_new" AS ENUM ('group1', 'group2', 'group3', 'general');
ALTER TABLE "customer_profiles" ALTER COLUMN "tax_system" TYPE "TaxSystem_new" USING ("tax_system"::text::"TaxSystem_new");
ALTER TABLE "performer_profiles" ALTER COLUMN "tax_system" TYPE "TaxSystem_new" USING ("tax_system"::text::"TaxSystem_new");
ALTER TYPE "TaxSystem" RENAME TO "TaxSystem_old";
ALTER TYPE "TaxSystem_new" RENAME TO "TaxSystem";
DROP TYPE "public"."TaxSystem_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "agreement_documents" DROP CONSTRAINT "agreement_documents_agreement_id_fkey";

-- DropForeignKey
ALTER TABLE "agreements" DROP CONSTRAINT "agreements_order_id_fkey";

-- DropForeignKey
ALTER TABLE "arbitration_cases" DROP CONSTRAINT "arbitration_cases_order_id_fkey";

-- DropForeignKey
ALTER TABLE "arbitration_media" DROP CONSTRAINT "arbitration_media_case_id_fkey";

-- DropForeignKey
ALTER TABLE "escrow_locks" DROP CONSTRAINT "escrow_locks_order_id_fkey";

-- DropForeignKey
ALTER TABLE "escrow_locks" DROP CONSTRAINT "escrow_locks_user_id_fkey";

-- DropForeignKey
ALTER TABLE "order_report_media" DROP CONSTRAINT "order_report_media_order_id_fkey";

-- DropForeignKey
ALTER TABLE "orders" DROP CONSTRAINT "orders_customer_user_id_fkey";

-- DropForeignKey
ALTER TABLE "orders" DROP CONSTRAINT "orders_performer_user_id_fkey";

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_order_id_fkey";

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_user_id_fkey";

-- DropForeignKey
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_performer_user_id_fkey";

-- DropForeignKey
ALTER TABLE "performer_settings" DROP CONSTRAINT "performer_settings_performer_user_id_fkey";

-- DropForeignKey
ALTER TABLE "reserve_transactions" DROP CONSTRAINT "reserve_transactions_performer_user_id_fkey";

-- DropForeignKey
ALTER TABLE "two_factor_setups" DROP CONSTRAINT "two_factor_setups_user_id_fkey";

-- DropIndex
DROP INDEX "crops_sort_name_idx";

-- DropIndex
DROP INDEX "devices_user_id_revoked_at_idx";

-- DropIndex
DROP INDEX "legal_profiles_user_id_idx";

-- DropIndex
DROP INDEX "notifications_user_id_read_at_idx";

-- DropIndex
DROP INDEX "order_status_events_order_id_at_idx";

-- DropIndex
DROP INDEX "orders_specs_idx";

-- DropIndex
DROP INDEX "reviews_order_id_author_user_id_key";

-- AlterTable
ALTER TABLE "crops" ADD COLUMN     "group" TEXT,
ADD COLUMN     "name_ua" TEXT;

-- AlterTable
ALTER TABLE "customer_crop_stats" ALTER COLUMN "area_ha" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "yield_t" DROP NOT NULL,
ALTER COLUMN "yield_t" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "devices" DROP COLUMN "platform",
ADD COLUMN     "platform" TEXT;

-- AlterTable
ALTER TABLE "fields" DROP COLUMN "centroid_lat",
DROP COLUMN "centroid_lng",
DROP COLUMN "geometry",
DROP COLUMN "region_name",
DROP COLUMN "status",
ADD COLUMN     "address_label" TEXT,
ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lng" DOUBLE PRECISION,
ADD COLUMN     "points" JSONB,
ALTER COLUMN "area_ha" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "notifications" DROP COLUMN "type",
ADD COLUMN     "type" TEXT;

-- AlterTable
ALTER TABLE "order_matches" DROP COLUMN "distance_km",
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending';

-- AlterTable
ALTER TABLE "order_status_events" DROP COLUMN "at",
DROP COLUMN "from_status",
DROP COLUMN "to_status",
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "status" TEXT;

-- AlterTable
ALTER TABLE "orders" DROP COLUMN "evidence_photos",
ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "radius_km" INTEGER,
ALTER COLUMN "area_ha" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "lat" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "lng" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "currency" SET DATA TYPE TEXT,
DROP COLUMN "status",
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'published',
ALTER COLUMN "specs" SET NOT NULL;

-- AlterTable
ALTER TABLE "performer_profiles" DROP COLUMN "tax_system",
ADD COLUMN     "tax_system" "TaxSystem",
ALTER COLUMN "coverage_mode" DROP NOT NULL,
ALTER COLUMN "coverage_radius_km" SET DEFAULT 50;

-- AlterTable
ALTER TABLE "performer_services" ALTER COLUMN "service_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "service_subcategories" DROP COLUMN "currency",
DROP COLUMN "min_price",
DROP COLUMN "price_per_ha";

-- AlterTable
ALTER TABLE "service_types" DROP COLUMN "currency",
DROP COLUMN "min_price",
DROP COLUMN "price_per_ha",
DROP COLUMN "updated_at";

-- DropTable
DROP TABLE "agreement_documents";

-- DropTable
DROP TABLE "agreements";

-- DropTable
DROP TABLE "arbitration_cases";

-- DropTable
DROP TABLE "arbitration_media";

-- DropTable
DROP TABLE "escrow_locks";

-- DropTable
DROP TABLE "order_report_media";

-- DropTable
DROP TABLE "payments";

-- DropTable
DROP TABLE "payouts";

-- DropTable
DROP TABLE "performer_settings";

-- DropTable
DROP TABLE "reserve_transactions";

-- DropTable
DROP TABLE "two_factor_setups";

-- DropEnum
DROP TYPE "ArbitrationStatus";

-- DropEnum
DROP TYPE "CoverageMode";

-- DropEnum
DROP TYPE "DevicePlatform";

-- DropEnum
DROP TYPE "EscrowRole";

-- DropEnum
DROP TYPE "EscrowStatus";

-- DropEnum
DROP TYPE "NotificationType";

-- DropEnum
DROP TYPE "OrderStatus";

-- DropEnum
DROP TYPE "PaymentProvider";

-- DropEnum
DROP TYPE "PaymentStatus";

-- DropEnum
DROP TYPE "PayoutStatus";

-- CreateIndex
CREATE UNIQUE INDEX "crops_name_key" ON "crops"("name");

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE INDEX "order_status_events_order_id_idx" ON "order_status_events"("order_id");

-- CreateIndex
CREATE INDEX "orders_customer_user_id_status_created_at_idx" ON "orders"("customer_user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "orders_performer_user_id_status_created_at_idx" ON "orders"("performer_user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "reviews_author_user_id_created_at_idx" ON "reviews"("author_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
