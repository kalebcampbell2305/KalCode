-- Double opt-in for the early-access list (docs/DATA_MODEL.md §3).
--
-- Expand-only: adds columns and tables, changes no existing value. Rows that exist when this
-- runs — and any row the previous Worker version inserts before the new version is deployed —
-- get status 'legacy_unconfirmed' from the column default. They are never emailed
-- automatically; see tooling/admin/request-legacy-confirmation.mjs. The new Worker always
-- writes the status explicitly.

-- 'pending': joined, confirmation email sent, not yet confirmed (deleted after the link expires).
-- 'confirmed': the owner of the address opened the link and pressed Confirm.
-- 'legacy_unconfirmed': added before confirmation existed.
ALTER TABLE early_access ADD COLUMN status TEXT NOT NULL DEFAULT 'legacy_unconfirmed'
  CHECK (status IN ('pending', 'confirmed', 'legacy_unconfirmed'));
ALTER TABLE early_access ADD COLUMN confirmed_at TEXT;

-- Per-address email throttle: when we last emailed the address, and how many emails it got on
-- `email_day` (UTC YYYY-MM-DD).
ALTER TABLE early_access ADD COLUMN last_email_at TEXT;
ALTER TABLE early_access ADD COLUMN email_day TEXT;
ALTER TABLE early_access ADD COLUMN email_day_count INTEGER NOT NULL DEFAULT 0 CHECK (email_day_count >= 0);

-- Finds expired pending sign-ups for cleanup.
CREATE INDEX IF NOT EXISTS early_access_pending_idx ON early_access (created_at) WHERE status = 'pending';

-- Single-use confirmation and removal links. Only the SHA-256 (hex) of each random 32-byte code is
-- stored; the code itself exists only in the email. Deleting the early_access row deletes its
-- links (the Worker also deletes them explicitly).
CREATE TABLE IF NOT EXISTS early_access_tokens (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  early_access_id INTEGER NOT NULL REFERENCES early_access (id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('confirm', 'remove')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS early_access_tokens_owner_idx ON early_access_tokens (early_access_id, purpose);
CREATE INDEX IF NOT EXISTS early_access_tokens_expiry_idx ON early_access_tokens (expires_at);

-- Site-wide daily email budget (UTC day → emails sent). Only today's row is kept.
CREATE TABLE IF NOT EXISTS email_send_budget (
  day TEXT PRIMARY KEY,
  sent INTEGER NOT NULL DEFAULT 0 CHECK (sent >= 0)
);
