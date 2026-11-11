-- Таблиці арбітражу створювались з UUID-ключами (20261026000001), а Prisma-схема
-- використовує cuid-рядки (String). Вставка кейсу падала з "invalid input syntax for type uuid".
-- Переводимо ключі в TEXT і відновлюємо зовнішні ключі; дані зберігаються.

ALTER TABLE order_media DROP CONSTRAINT IF EXISTS order_media_arbitration_message_id_fkey;
ALTER TABLE arbitration_messages DROP CONSTRAINT IF EXISTS arbitration_messages_arbitration_case_id_fkey;
ALTER TABLE arbitration_rulings DROP CONSTRAINT IF EXISTS arbitration_rulings_arbitration_case_id_fkey;

ALTER TABLE arbitration_cases ALTER COLUMN id DROP DEFAULT;
ALTER TABLE arbitration_cases ALTER COLUMN id TYPE TEXT USING id::text;

ALTER TABLE arbitration_messages ALTER COLUMN id DROP DEFAULT;
ALTER TABLE arbitration_messages ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE arbitration_messages ALTER COLUMN arbitration_case_id TYPE TEXT USING arbitration_case_id::text;

ALTER TABLE arbitration_rulings ALTER COLUMN id DROP DEFAULT;
ALTER TABLE arbitration_rulings ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE arbitration_rulings ALTER COLUMN arbitration_case_id TYPE TEXT USING arbitration_case_id::text;

ALTER TABLE order_media ALTER COLUMN arbitration_message_id TYPE TEXT USING arbitration_message_id::text;

ALTER TABLE arbitration_messages
  ADD CONSTRAINT arbitration_messages_arbitration_case_id_fkey
  FOREIGN KEY (arbitration_case_id) REFERENCES arbitration_cases(id) ON DELETE CASCADE;
ALTER TABLE arbitration_rulings
  ADD CONSTRAINT arbitration_rulings_arbitration_case_id_fkey
  FOREIGN KEY (arbitration_case_id) REFERENCES arbitration_cases(id) ON DELETE CASCADE;
ALTER TABLE order_media
  ADD CONSTRAINT order_media_arbitration_message_id_fkey
  FOREIGN KEY (arbitration_message_id) REFERENCES arbitration_messages(id) ON DELETE SET NULL;
