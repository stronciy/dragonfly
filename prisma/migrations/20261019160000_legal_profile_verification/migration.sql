-- USR-6: подтверждение юридических данных исполнителя администратором.
-- verified_by_user_id хранит id администратора панели (без FK: журнал и связь
-- не должны ломаться при удалении админа).

ALTER TABLE "legal_profiles" ADD COLUMN IF NOT EXISTS "verified_at" timestamp(3);
ALTER TABLE "legal_profiles" ADD COLUMN IF NOT EXISTS "verified_by_user_id" text;
