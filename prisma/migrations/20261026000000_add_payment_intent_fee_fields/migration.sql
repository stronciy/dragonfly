-- Add field(s) to schema
ALTER TABLE payment_intents ADD COLUMN deposit_amount numeric(12, 2);
ALTER TABLE payment_intents ADD COLUMN fee_amount numeric(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE payment_intents ADD COLUMN fee_rate float;

-- Backfill existing records
UPDATE payment_intents SET deposit_amount = amount WHERE deposit_amount IS NULL;
