-- Internal account-email dispatch claims for the kalcode-api -> kalcode-website service binding.
-- The website Worker owns the only Resend secret and the shared daily email budget. The proof is
-- never stored: only its SHA-256 hash. A claimed/ambiguous dispatch is deliberately not refunded,
-- because Resend may have accepted the email before a timeout or connection failure was observed.

CREATE TABLE IF NOT EXISTS account_email_dispatches (
  proof_hash TEXT PRIMARY KEY CHECK (length(proof_hash) = 64),
  purpose TEXT NOT NULL CHECK (purpose IN ('signin', 'delete')),
  claimed_day TEXT NOT NULL CHECK (length(claimed_day) = 10),
  budget_limit INTEGER NOT NULL CHECK (budget_limit > 0),
  state TEXT NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed', 'sent', 'ambiguous', 'rejected')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS account_email_dispatches_created_idx ON account_email_dispatches (created_at);

-- Budget admission and accounting are part of the same INSERT transaction as the unique proof
-- claim. Concurrent calls therefore cannot spend one proof twice or cross the shared daily cap.
CREATE TRIGGER IF NOT EXISTS account_email_dispatch_budget_guard
BEFORE INSERT ON account_email_dispatches
WHEN COALESCE((SELECT sent FROM email_send_budget WHERE day = NEW.claimed_day), 0) >= NEW.budget_limit
BEGIN
  SELECT RAISE(ABORT, 'account email daily budget exhausted');
END;

CREATE TRIGGER IF NOT EXISTS account_email_dispatch_budget_claim
AFTER INSERT ON account_email_dispatches
BEGIN
  INSERT INTO email_send_budget (day, sent) VALUES (NEW.claimed_day, 1)
  ON CONFLICT(day) DO UPDATE SET sent = sent + 1;
END;

-- Only an explicit provider rejection can prove that no email was accepted. Ambiguous outcomes
-- retain both the proof claim and budget charge, closing retry-based send amplification.
CREATE TRIGGER IF NOT EXISTS account_email_dispatch_budget_refund
AFTER UPDATE OF state ON account_email_dispatches
WHEN OLD.state = 'claimed' AND NEW.state = 'rejected'
BEGIN
  UPDATE email_send_budget SET sent = sent - 1 WHERE day = OLD.claimed_day AND sent > 0;
END;
