-- Fair, privacy-preserving admission for the website's one shared email budget.
--
-- The hard ceiling remains 90 messages per UTC day. Marketing can consume at most 60 and
-- all non-deletion mail can consume at most 80, so account mail retains 30 slots and
-- authenticated deletion retains the final 10. Account bucket identifiers are domain-separated
-- HMACs made by the API Worker; neither a raw IP nor a dictionary-guessable email hash is stored.
-- Network and recipient ceilings are purpose-scoped so unauthenticated sign-in traffic cannot
-- consume the authenticated deletion allowance.

ALTER TABLE account_email_dispatches ADD COLUMN network_hash TEXT
  CHECK (network_hash IS NULL OR length(network_hash) = 43);
ALTER TABLE account_email_dispatches ADD COLUMN recipient_hash TEXT
  CHECK (recipient_hash IS NULL OR length(recipient_hash) = 43);
ALTER TABLE account_email_dispatches ADD COLUMN non_deletion_limit INTEGER NOT NULL DEFAULT 80
  CHECK (non_deletion_limit BETWEEN 0 AND 80);
ALTER TABLE account_email_dispatches ADD COLUMN network_limit INTEGER NOT NULL DEFAULT 20
  CHECK (network_limit BETWEEN 1 AND 20);
ALTER TABLE account_email_dispatches ADD COLUMN recipient_limit INTEGER NOT NULL DEFAULT 5
  CHECK (recipient_limit BETWEEN 1 AND 5);

CREATE INDEX IF NOT EXISTS account_email_dispatch_network_day
  ON account_email_dispatches (claimed_day, purpose, network_hash, state);
CREATE INDEX IF NOT EXISTS account_email_dispatch_recipient_day
  ON account_email_dispatches (claimed_day, purpose, recipient_hash, state);

CREATE TABLE IF NOT EXISTS marketing_email_dispatches (
  claim_id TEXT PRIMARY KEY CHECK (length(claim_id) = 36),
  claimed_day TEXT NOT NULL,
  budget_limit INTEGER NOT NULL CHECK (budget_limit BETWEEN 1 AND 90),
  marketing_limit INTEGER NOT NULL CHECK (marketing_limit BETWEEN 0 AND 60),
  non_deletion_limit INTEGER NOT NULL CHECK (non_deletion_limit BETWEEN 0 AND 80),
  state TEXT NOT NULL CHECK (state IN ('claimed', 'sent', 'ambiguous', 'rejected')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS marketing_email_dispatch_day
  ON marketing_email_dispatches (claimed_day, state);

-- Before this migration, marketing and account mail shared only email_send_budget. Account rows
-- are already durable, so the unexplained remainder is prior marketing usage. Backfill it before
-- installing the new triggers. This does not change the global counter and prevents a mid-day
-- deployment from resetting marketing/non-deletion classification and consuming the reserves.
WITH RECURSIVE
prior_marketing(day, sent) AS (
  SELECT b.day,
    MAX(
      b.sent - (SELECT COUNT(*) FROM account_email_dispatches a
                WHERE a.claimed_day = b.day AND a.state != 'rejected'),
      0
    )
  FROM email_send_budget b
),
slots(day, slot, sent) AS (
  SELECT day, 1, sent FROM prior_marketing WHERE sent > 0
  UNION ALL
  SELECT day, slot + 1, sent FROM slots WHERE slot < sent
)
INSERT INTO marketing_email_dispatches
  (claim_id, claimed_day, budget_limit, marketing_limit, non_deletion_limit, state, created_at, completed_at)
SELECT
  printf('migration-%s-%017d', replace(day, '-', ''), slot),
  day, 90, 60, 80, 'sent', day || 'T00:00:00.000Z', day || 'T00:00:00.000Z'
FROM slots;

DROP TRIGGER IF EXISTS account_email_dispatch_budget_guard;
DROP TRIGGER IF EXISTS account_email_dispatch_budget_claim;
DROP TRIGGER IF EXISTS account_email_dispatch_budget_refund;

CREATE TRIGGER account_email_dispatch_budget_guard
BEFORE INSERT ON account_email_dispatches
BEGIN
  SELECT CASE
    WHEN NEW.network_hash IS NULL OR NEW.recipient_hash IS NULL
      OR length(NEW.network_hash) != 43 OR length(NEW.recipient_hash) != 43
      OR NEW.budget_limit > 90
    THEN RAISE(ABORT, 'invalid account email admission')
  END;
  SELECT CASE
    WHEN COALESCE((SELECT sent FROM email_send_budget WHERE day = NEW.claimed_day), 0) >= NEW.budget_limit
    THEN RAISE(ABORT, 'email daily budget exhausted')
  END;
  SELECT CASE
    WHEN NEW.purpose = 'signin' AND (
      (SELECT COUNT(*) FROM marketing_email_dispatches
       WHERE claimed_day = NEW.claimed_day AND state != 'rejected')
      +
      (SELECT COUNT(*) FROM account_email_dispatches
       WHERE claimed_day = NEW.claimed_day AND purpose = 'signin' AND state != 'rejected')
    ) >= NEW.non_deletion_limit
    THEN RAISE(ABORT, 'non-deletion email reserve exhausted')
  END;
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM account_email_dispatches
          WHERE claimed_day = NEW.claimed_day AND purpose = NEW.purpose
            AND network_hash = NEW.network_hash AND state != 'rejected')
         >= NEW.network_limit
    THEN RAISE(ABORT, 'account email network limit exhausted')
  END;
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM account_email_dispatches
          WHERE claimed_day = NEW.claimed_day AND purpose = NEW.purpose
            AND recipient_hash = NEW.recipient_hash AND state != 'rejected')
         >= NEW.recipient_limit
    THEN RAISE(ABORT, 'account email recipient limit exhausted')
  END;
END;

CREATE TRIGGER account_email_dispatch_budget_claim
AFTER INSERT ON account_email_dispatches
BEGIN
  INSERT INTO email_send_budget (day, sent) VALUES (NEW.claimed_day, 1)
  ON CONFLICT(day) DO UPDATE SET sent = sent + 1;
END;

CREATE TRIGGER account_email_dispatch_budget_refund
AFTER UPDATE OF state ON account_email_dispatches
WHEN OLD.state = 'claimed' AND NEW.state = 'rejected'
BEGIN
  UPDATE email_send_budget SET sent = sent - 1 WHERE day = OLD.claimed_day AND sent > 0;
END;

CREATE TRIGGER marketing_email_dispatch_budget_guard
BEFORE INSERT ON marketing_email_dispatches
BEGIN
  SELECT CASE
    WHEN COALESCE((SELECT sent FROM email_send_budget WHERE day = NEW.claimed_day), 0) >= NEW.budget_limit
    THEN RAISE(ABORT, 'email daily budget exhausted')
  END;
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM marketing_email_dispatches
          WHERE claimed_day = NEW.claimed_day AND state != 'rejected') >= NEW.marketing_limit
    THEN RAISE(ABORT, 'marketing email reserve exhausted')
  END;
  SELECT CASE
    WHEN (
      (SELECT COUNT(*) FROM marketing_email_dispatches
       WHERE claimed_day = NEW.claimed_day AND state != 'rejected')
      +
      (SELECT COUNT(*) FROM account_email_dispatches
       WHERE claimed_day = NEW.claimed_day AND purpose = 'signin' AND state != 'rejected')
    ) >= NEW.non_deletion_limit
    THEN RAISE(ABORT, 'non-deletion email reserve exhausted')
  END;
END;

CREATE TRIGGER marketing_email_dispatch_budget_claim
AFTER INSERT ON marketing_email_dispatches
BEGIN
  INSERT INTO email_send_budget (day, sent) VALUES (NEW.claimed_day, 1)
  ON CONFLICT(day) DO UPDATE SET sent = sent + 1;
END;

CREATE TRIGGER marketing_email_dispatch_budget_refund
AFTER UPDATE OF state ON marketing_email_dispatches
WHEN OLD.state = 'claimed' AND NEW.state = 'rejected'
BEGIN
  UPDATE email_send_budget SET sent = sent - 1 WHERE day = OLD.claimed_day AND sent > 0;
END;
