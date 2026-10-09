-- Settlement (населений пункт) for order push text; exact address never goes to push.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "settlement_name" TEXT;
