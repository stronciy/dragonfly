-- Telegram-сповіщення адміністраторів: прив'язка чату, коди, вибірка подій, курсори опитування.
CREATE TABLE "admin_telegram_links" (
    "admin_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "username" TEXT,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_telegram_links_pkey" PRIMARY KEY ("admin_id")
);

CREATE UNIQUE INDEX "admin_telegram_links_chat_id_key" ON "admin_telegram_links"("chat_id");

CREATE TABLE "admin_telegram_link_codes" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_telegram_link_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_telegram_link_codes_code_hash_key" ON "admin_telegram_link_codes"("code_hash");
CREATE INDEX "admin_telegram_link_codes_admin_id_created_at_idx" ON "admin_telegram_link_codes"("admin_id", "created_at");

CREATE TABLE "admin_notification_settings" (
    "admin_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_notification_settings_pkey" PRIMARY KEY ("admin_id", "event_type")
);

CREATE TABLE "admin_event_cursors" (
    "source" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "ids" JSONB NOT NULL DEFAULT '[]',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_event_cursors_pkey" PRIMARY KEY ("source")
);

ALTER TABLE "admin_telegram_links" ADD CONSTRAINT "admin_telegram_links_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_telegram_link_codes" ADD CONSTRAINT "admin_telegram_link_codes_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_notification_settings" ADD CONSTRAINT "admin_notification_settings_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
