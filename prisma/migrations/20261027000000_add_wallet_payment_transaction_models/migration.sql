-- Create wallets table
CREATE TABLE wallets (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  balance DOUBLE PRECISION DEFAULT 0,
  currency TEXT DEFAULT 'UAH',
  hold_amount DOUBLE PRECISION DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX wallets_user_id_idx ON wallets(user_id);

-- Create transactions table
CREATE TABLE transactions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id TEXT NOT NULL,
  order_id TEXT,
  type TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT DEFAULT 'UAH',
  description TEXT,
  status TEXT DEFAULT 'completed',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX transactions_wallet_id_created_at_idx ON transactions(wallet_id, created_at);
CREATE INDEX transactions_order_id_idx ON transactions(order_id);

-- Create payment_requests table
CREATE TABLE payment_requests (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  requested_amount DOUBLE PRECISION NOT NULL,
  paid_amount DOUBLE PRECISION,
  paid_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX payment_requests_order_id_idx ON payment_requests(order_id);
CREATE INDEX payment_requests_requested_by_idx ON payment_requests(requested_by);

-- Add foreign keys
ALTER TABLE wallets ADD CONSTRAINT wallets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE transactions ADD CONSTRAINT transactions_wallet_id_fkey FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE;
ALTER TABLE transactions ADD CONSTRAINT transactions_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
