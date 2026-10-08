-- Create legal_profiles table
-- This table was missing from the initial migrations

CREATE TABLE IF NOT EXISTS "legal_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "company_name" TEXT,
    "edrpou" TEXT,
    "iban" TEXT,
    "legal_address" TEXT,
    "vat_payer" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_profiles_pkey" PRIMARY KEY ("id")
);

-- Create unique index on user_id
CREATE UNIQUE INDEX IF NOT EXISTS "legal_profiles_user_id_key" ON "legal_profiles"("user_id");

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS "legal_profiles_user_id_idx" ON "legal_profiles"("user_id");

-- Add foreign key constraint
ALTER TABLE "legal_profiles" 
ADD CONSTRAINT "legal_profiles_user_id_fkey" 
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
