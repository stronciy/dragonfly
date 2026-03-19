/*
  Warnings:

  - The primary key for the `service_types` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- AlterTable
ALTER TABLE "service_types" DROP CONSTRAINT "service_types_pkey",
ADD CONSTRAINT "service_types_pkey" PRIMARY KEY ("subcategory_id", "id");
