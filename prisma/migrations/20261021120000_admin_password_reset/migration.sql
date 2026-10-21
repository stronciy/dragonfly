-- Password reset for admin-panel accounts.
--
-- `admins` is a separate table from marketplace users, so the existing
-- `password_reset_tokens` (FK -> users) cannot be reused here.
ALTER TABLE "admins"
  ADD COLUMN IF NOT EXISTS "session_version" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "admin_password_reset_tokens" (
  "id" text NOT NULL,
  "admin_id" text NOT NULL,
  "code_hash" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "expires_at" timestamp(3) NOT NULL,
  "used_at" timestamp(3),
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_password_reset_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_password_reset_tokens_admin_id_fkey"
    FOREIGN KEY ("admin_id") REFERENCES "admins"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "admin_password_reset_tokens_admin_idx"
  ON "admin_password_reset_tokens"("admin_id", "used_at", "expires_at");

CREATE INDEX IF NOT EXISTS "admin_password_reset_tokens_expires_idx"
  ON "admin_password_reset_tokens"("expires_at");
