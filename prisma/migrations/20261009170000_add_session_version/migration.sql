-- Single active session: bumped on each login; access tokens carry it and
-- requireUser rejects any token whose version is stale (old devices).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_version" INTEGER NOT NULL DEFAULT 0;
