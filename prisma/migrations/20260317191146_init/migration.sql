CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('customer', 'performer', 'admin');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('draft', 'published', 'accepted', 'pending_deposit', 'requires_confirmation', 'confirmed', 'started', 'completed', 'arbitration', 'cancelled');

-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('locked', 'released', 'forfeited');

-- CreateEnum
CREATE TYPE "EscrowRole" AS ENUM ('customer', 'performer');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('stripe');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('requires_action', 'processing', 'succeeded', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('system', 'order', 'deposit', 'marketplace', 'arbitration', 'payout');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ios', 'android');

-- CreateEnum
CREATE TYPE "CoverageMode" AS ENUM ('radius', 'country');

-- CreateEnum
CREATE TYPE "ArbitrationStatus" AS ENUM ('opened', 'in_review', 'resolved', 'cancelled');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('pending', 'paid', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'customer',
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" VARCHAR(32),
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "company_name" TEXT,
    "company_edrpou" TEXT,
    "billing_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performer_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "company_name" TEXT,
    "rating" DECIMAL(3,2) NOT NULL DEFAULT 0,
    "jobs_done" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performer_settings" (
    "id" TEXT NOT NULL,
    "performer_user_id" TEXT NOT NULL,
    "base_location_label" TEXT NOT NULL,
    "base_lat" DECIMAL(9,6) NOT NULL,
    "base_lng" DECIMAL(9,6) NOT NULL,
    "base_geo" geography(Point,4326),
    "coverage_mode" "CoverageMode" NOT NULL DEFAULT 'radius',
    "radius_km" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "performer_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performer_services" (
    "id" TEXT NOT NULL,
    "performer_user_id" TEXT NOT NULL,
    "service_category_id" TEXT NOT NULL,
    "service_subcategory_id" TEXT NOT NULL,
    "service_type_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performer_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fields" (
    "id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "area_ha" DECIMAL(10,2) NOT NULL,
    "region_name" TEXT,
    "geometry" JSONB,
    "centroid_lat" DECIMAL(9,6),
    "centroid_lng" DECIMAL(9,6),
    "centroid_geo" geography(Point,4326),
    "status" VARCHAR(32),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "customer_user_id" TEXT NOT NULL,
    "performer_user_id" TEXT,
    "service_category_id" TEXT NOT NULL,
    "service_subcategory_id" TEXT NOT NULL,
    "service_type_id" TEXT,
    "area_ha" DECIMAL(10,2) NOT NULL,
    "date_from" TIMESTAMP(3),
    "date_to" TIMESTAMP(3),
    "location_label" TEXT NOT NULL,
    "region_name" TEXT,
    "lat" DECIMAL(9,6) NOT NULL,
    "lng" DECIMAL(9,6) NOT NULL,
    "location_geo" geography(Point,4326),
    "comment" TEXT,
    "budget" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'UAH',
    "status" "OrderStatus" NOT NULL DEFAULT 'draft',
    "accepted_at" TIMESTAMP(3),
    "deposit_deadline" TIMESTAMP(3),
    "evidence_photos" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_locks" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "EscrowRole" NOT NULL,
    "status" "EscrowStatus" NOT NULL DEFAULT 'locked',
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'UAH',
    "provider" "PaymentProvider",
    "provider_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "escrow_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "provider_intent_id" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'UAH',
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_events" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "from_status" "OrderStatus",
    "to_status" "OrderStatus" NOT NULL,
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_matches" (
    "id" TEXT NOT NULL,
    "performer_user_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "distance_km" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arbitration_cases" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "opened_by_user_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ArbitrationStatus" NOT NULL DEFAULT 'opened',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "arbitration_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arbitration_media" (
    "id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arbitration_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expo_push_token" TEXT NOT NULL,
    "platform" "DevicePlatform" NOT NULL,
    "device_id" TEXT,
    "app_version" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_report_media" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "caption" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_report_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agreements" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "customer_user_id" TEXT NOT NULL,
    "performer_user_id" TEXT NOT NULL,
    "amount_total" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'UAH',
    "performed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agreement_documents" (
    "id" TEXT NOT NULL,
    "agreement_id" TEXT NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agreement_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "performer_user_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'UAH',
    "status" "PayoutStatus" NOT NULL DEFAULT 'pending',
    "provider_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reserve_transactions" (
    "id" TEXT NOT NULL,
    "performer_user_id" TEXT NOT NULL,
    "order_id" TEXT,
    "title" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "direction" VARCHAR(8) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reserve_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_user_id_key" ON "customer_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "performer_profiles_user_id_key" ON "performer_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "performer_settings_performer_user_id_key" ON "performer_settings"("performer_user_id");

-- CreateIndex
CREATE INDEX "performer_settings_coverage_mode_idx" ON "performer_settings"("coverage_mode");

-- CreateIndex
CREATE INDEX "performer_services_performer_user_id_idx" ON "performer_services"("performer_user_id");

-- CreateIndex
CREATE INDEX "performer_services_service_category_id_service_subcategory__idx" ON "performer_services"("service_category_id", "service_subcategory_id", "service_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "performer_services_performer_user_id_service_category_id_se_key" ON "performer_services"("performer_user_id", "service_category_id", "service_subcategory_id", "service_type_id");

-- CreateIndex
CREATE INDEX "fields_owner_user_id_idx" ON "fields"("owner_user_id");

-- CreateIndex
CREATE INDEX "orders_customer_user_id_status_created_at_idx" ON "orders"("customer_user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "orders_performer_user_id_status_created_at_idx" ON "orders"("performer_user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "orders_service_category_id_service_subcategory_id_service_t_idx" ON "orders"("service_category_id", "service_subcategory_id", "service_type_id");

-- CreateIndex
CREATE INDEX "escrow_locks_user_id_status_idx" ON "escrow_locks"("user_id", "status");

-- CreateIndex
CREATE INDEX "escrow_locks_order_id_status_idx" ON "escrow_locks"("order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "escrow_locks_order_id_role_key" ON "escrow_locks"("order_id", "role");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE INDEX "payments_user_id_created_at_idx" ON "payments"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_provider_intent_id_key" ON "payments"("provider", "provider_intent_id");

-- CreateIndex
CREATE INDEX "order_status_events_order_id_at_idx" ON "order_status_events"("order_id", "at");

-- CreateIndex
CREATE INDEX "order_matches_performer_user_id_created_at_idx" ON "order_matches"("performer_user_id", "created_at");

-- CreateIndex
CREATE INDEX "order_matches_order_id_idx" ON "order_matches"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_matches_performer_user_id_order_id_key" ON "order_matches"("performer_user_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "arbitration_cases_order_id_key" ON "arbitration_cases"("order_id");

-- CreateIndex
CREATE INDEX "arbitration_cases_status_created_at_idx" ON "arbitration_cases"("status", "created_at");

-- CreateIndex
CREATE INDEX "arbitration_media_case_id_created_at_idx" ON "arbitration_media"("case_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "devices_user_id_revoked_at_idx" ON "devices"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "devices_expo_push_token_key" ON "devices"("expo_push_token");

-- CreateIndex
CREATE INDEX "order_report_media_order_id_created_at_idx" ON "order_report_media"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agreements_order_id_key" ON "agreements"("order_id");

-- CreateIndex
CREATE INDEX "agreements_customer_user_id_created_at_idx" ON "agreements"("customer_user_id", "created_at");

-- CreateIndex
CREATE INDEX "agreements_performer_user_id_created_at_idx" ON "agreements"("performer_user_id", "created_at");

-- CreateIndex
CREATE INDEX "agreement_documents_agreement_id_created_at_idx" ON "agreement_documents"("agreement_id", "created_at");

-- CreateIndex
CREATE INDEX "payouts_performer_user_id_created_at_idx" ON "payouts"("performer_user_id", "created_at");

-- CreateIndex
CREATE INDEX "payouts_status_created_at_idx" ON "payouts"("status", "created_at");

-- CreateIndex
CREATE INDEX "reserve_transactions_performer_user_id_created_at_idx" ON "reserve_transactions"("performer_user_id", "created_at");

-- CreateIndex
CREATE INDEX "reserve_transactions_order_id_idx" ON "reserve_transactions"("order_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performer_profiles" ADD CONSTRAINT "performer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performer_settings" ADD CONSTRAINT "performer_settings_performer_user_id_fkey" FOREIGN KEY ("performer_user_id") REFERENCES "performer_profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performer_services" ADD CONSTRAINT "performer_services_performer_user_id_fkey" FOREIGN KEY ("performer_user_id") REFERENCES "performer_profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fields" ADD CONSTRAINT "fields_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "customer_profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_performer_user_id_fkey" FOREIGN KEY ("performer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escrow_locks" ADD CONSTRAINT "escrow_locks_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escrow_locks" ADD CONSTRAINT "escrow_locks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_matches" ADD CONSTRAINT "order_matches_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arbitration_cases" ADD CONSTRAINT "arbitration_cases_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "arbitration_media" ADD CONSTRAINT "arbitration_media_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "arbitration_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_report_media" ADD CONSTRAINT "order_report_media_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_documents" ADD CONSTRAINT "agreement_documents_agreement_id_fkey" FOREIGN KEY ("agreement_id") REFERENCES "agreements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_performer_user_id_fkey" FOREIGN KEY ("performer_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reserve_transactions" ADD CONSTRAINT "reserve_transactions_performer_user_id_fkey" FOREIGN KEY ("performer_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
