-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customer_part2_deadline" TIMESTAMP(3),
ADD COLUMN     "en_route_at" TIMESTAMP(3),
ADD COLUMN     "payment_paused" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payment_intents" ADD COLUMN     "part" INTEGER NOT NULL DEFAULT 1;
