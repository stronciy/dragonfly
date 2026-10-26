-- Create table arbitration_cases
CREATE TABLE arbitration_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  opened_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status VARCHAR NOT NULL DEFAULT 'open',
  assignee_admin_id UUID REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  resolved_at TIMESTAMP,
  closed_at TIMESTAMP
);

-- Create table arbitration_messages
CREATE TABLE arbitration_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  arbitration_case_id UUID NOT NULL REFERENCES arbitration_cases(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  admin_id UUID REFERENCES admins(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Create table arbitration_rulings
CREATE TABLE arbitration_rulings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  arbitration_case_id UUID NOT NULL UNIQUE REFERENCES arbitration_cases(id) ON DELETE CASCADE,
  admin_id UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  decision VARCHAR NOT NULL,
  reason TEXT,
  rating INTEGER,
  comment TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Add arbitration_message_id field to order_media
ALTER TABLE order_media ADD COLUMN arbitration_message_id UUID REFERENCES arbitration_messages(id) ON DELETE SET NULL;

-- Create indexes
CREATE INDEX idx_arbitration_cases_order_created ON arbitration_cases(order_id, created_at);
CREATE INDEX idx_arbitration_cases_status ON arbitration_cases(status, created_at);
CREATE INDEX idx_arbitration_cases_assignee_status ON arbitration_cases(assignee_admin_id, status);

CREATE INDEX idx_arbitration_messages_case ON arbitration_messages(arbitration_case_id, created_at);
CREATE INDEX idx_arbitration_messages_user ON arbitration_messages(user_id, created_at);
CREATE INDEX idx_arbitration_messages_admin ON arbitration_messages(admin_id, created_at);

CREATE INDEX idx_arbitration_rulings_admin ON arbitration_rulings(admin_id, created_at);

CREATE INDEX idx_order_media_arbitration_message ON order_media(arbitration_message_id, created_at);
