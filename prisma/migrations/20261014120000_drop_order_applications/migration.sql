-- DropForeignKey
ALTER TABLE "order_applications" DROP CONSTRAINT "order_applications_order_id_fkey";

-- DropForeignKey
ALTER TABLE "order_applications" DROP CONSTRAINT "order_applications_performer_user_id_fkey";

-- DropTable
DROP TABLE "order_applications";
