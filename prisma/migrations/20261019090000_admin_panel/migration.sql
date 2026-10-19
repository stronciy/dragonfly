-- Админ-панель: собственная таблица администраторов (вход панели),
-- журнал действий и поля блокировки пользователей.
--
-- Миграция идемпотентна по таблице admins: локально она уже могла быть создана
-- скриптом admin/scripts/ensure-admin-schema.mjs, а на проде её нет.

CREATE TABLE IF NOT EXISTS "admins" (
  "id" text NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "role" text NOT NULL DEFAULT 'admin',
  "active" boolean NOT NULL DEFAULT true,
  "must_change_password" boolean NOT NULL DEFAULT true,
  "last_login_at" timestamp(3),
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "admins_email_key" ON "admins"("email");

-- Первый администратор. Пароль Test1234, смена обязательна при первом входе.
-- ON CONFLICT: если запись уже есть (локальная база), ничего не меняем.
INSERT INTO "admins" ("id", "email", "password_hash", "role", "active", "must_change_password")
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'stronciy@gmail.com',
  '0b1dda6820ae5f2726e99a71f3a8fd3e:7e864ba54755613855ae5d42937791a6b5007b0199b0ef1ae50107c1cf9e724c4adaeb3129ba87a03a47ff0d23a82839dceb99cff2082c7dea58540a0243afb5',
  'superadmin',
  true,
  true
)
ON CONFLICT ("email") DO NOTHING;

-- Журнал действий администраторов. Без FK на admins: удаление администратора
-- не должно стирать его действия, поэтому админ дублируется email-ом.
CREATE TABLE "admin_audit_logs" (
  "id" text NOT NULL,
  "admin_id" text,
  "admin_email" text NOT NULL,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "reason" text,
  "before" jsonb,
  "after" jsonb,
  "ip" text,
  "user_agent" text,
  "request_id" text,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_audit_logs_admin_idx" ON "admin_audit_logs"("admin_id", "created_at");
CREATE INDEX "admin_audit_logs_entity_idx" ON "admin_audit_logs"("entity_type", "entity_id");
CREATE INDEX "admin_audit_logs_created_idx" ON "admin_audit_logs"("created_at");

-- USR-4: блокировка пользователя администратором.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "blocked_at" timestamp(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "blocked_reason" text;
