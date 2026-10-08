-- CreateTable
CREATE TABLE "service_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_subcategories" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_subcategories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_types" (
    "id" TEXT NOT NULL,
    "subcategory_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "price_per_ha" DECIMAL(12,2),
    "min_price" DECIMAL(12,2),
    "currency" VARCHAR(8) NOT NULL DEFAULT 'UAH',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crops" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon_key" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_categories_sort_name_idx" ON "service_categories"("sort", "name");

-- CreateIndex
CREATE INDEX "service_subcategories_category_id_sort_name_idx" ON "service_subcategories"("category_id", "sort", "name");

-- CreateIndex
CREATE INDEX "service_types_subcategory_id_sort_name_idx" ON "service_types"("subcategory_id", "sort", "name");

-- CreateIndex
CREATE INDEX "crops_sort_name_idx" ON "crops"("sort", "name");

-- AddForeignKey
ALTER TABLE "service_subcategories" ADD CONSTRAINT "service_subcategories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_types" ADD CONSTRAINT "service_types_subcategory_id_fkey" FOREIGN KEY ("subcategory_id") REFERENCES "service_subcategories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
