-- AlterTable
ALTER TABLE "service_subcategories" ADD COLUMN     "currency" VARCHAR(8) NOT NULL DEFAULT 'UAH',
ADD COLUMN     "min_price" DECIMAL(12,2),
ADD COLUMN     "price_per_ha" DECIMAL(12,2);
