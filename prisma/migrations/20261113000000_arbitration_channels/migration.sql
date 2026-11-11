-- Канали арбітражного листування: common — загальний чат; customer/performer —
-- приватна гілка адміністратора з відповідним учасником.
ALTER TABLE arbitration_messages ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'common';
CREATE INDEX IF NOT EXISTS idx_arbitration_messages_channel ON arbitration_messages(arbitration_case_id, channel, created_at);
