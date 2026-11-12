-- Строки відповіді сторін в арбітражі (24 год). Після закінчення строку без відповіді спір завершується.
ALTER TABLE arbitration_cases ADD COLUMN IF NOT EXISTS customer_response_due_at TIMESTAMP;
ALTER TABLE arbitration_cases ADD COLUMN IF NOT EXISTS performer_response_due_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_arbitration_cases_response_due ON arbitration_cases(status, customer_response_due_at, performer_response_due_at);
