-- Логи застосунку, які надсилає користувач (Налаштування → Надіслати логи розробникам).
CREATE TABLE "client_diagnostic_reports" (
  "id" text NOT NULL,
  "report_id" text NOT NULL,
  "user_id" text NOT NULL,
  "user_role" text,
  "user_name" text,
  "user_phone" text,
  "app_version" text,
  "build_number" text,
  "platform" text,
  "os_version" text,
  "device_model" text,
  "is_device" boolean,
  "captured_at" timestamp(3) NOT NULL,
  "entry_count" integer NOT NULL,
  "entries" jsonb NOT NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "client_diagnostic_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_diagnostic_reports_report_id_key" ON "client_diagnostic_reports"("report_id");
CREATE INDEX "client_diagnostic_reports_user_idx" ON "client_diagnostic_reports"("user_id", "created_at");
CREATE INDEX "client_diagnostic_reports_created_idx" ON "client_diagnostic_reports"("created_at");
