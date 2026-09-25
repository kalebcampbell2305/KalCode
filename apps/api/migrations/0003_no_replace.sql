-- Close the REPLACE delete path on the append-only and immutable tables (security review, 0.1.1).
--
-- Why: `REPLACE INTO …`, `INSERT OR REPLACE INTO …` and `INSERT … ON CONFLICT REPLACE` resolve a
-- PRIMARY KEY or UNIQUE conflict by deleting the existing row and inserting the new one. SQLite
-- fires DELETE triggers for those implicit deletes only when `PRAGMA recursive_triggers` is on,
-- and D1 runs with it off (it is a per-connection setting, so a migration cannot turn it on).
-- The BEFORE DELETE triggers in 0001/0002 therefore never saw these deletes, and a REPLACE could:
--   * re-activate a revoked OWNER grant (REPLACE with the revoked grant's id),
--   * silently swap the active OWNER grant for a new row through the partial unique index
--     `entitlement_grants_one_active_owner`, erasing the original grant row,
--   * overwrite any audit_log row, including the revocation record,
--   * rewrite a counted KalVoice request (id or (account, client request id)).
--
-- Fix: BEFORE INSERT triggers run before conflict resolution, for every INSERT variant, whatever
-- the recursive_triggers setting. Each one refuses a new row that would collide with an existing
-- row on a key the table's invariants protect, so no REPLACE can ever reach its delete step.
-- UPDATE OR REPLACE needs no guard: every UPDATE that could collide is already refused by the
-- BEFORE UPDATE triggers of 0001/0002 (identity fields and revoked grants are immutable,
-- audit_log and kalvoice_requests refuse all updates). `ON CONFLICT … DO UPDATE` likewise runs
-- those UPDATE triggers.
--
-- ABORT everywhere except one case: the worker's usage insert relies on
-- `ON CONFLICT (account_id, client_request_id) DO NOTHING` so retries and offline replays are
-- idempotent (apps/api/worker/lib/store.ts). A trigger cannot tell DO NOTHING from REPLACE, so
-- for that key the trigger skips the row (RAISE(IGNORE)): exactly the DO NOTHING result, and it
-- turns a REPLACE into a no-op that keeps the original row. kalvoice_requests has no audit
-- triggers, so skipping the row cannot drop an audit write. Everything else aborts the whole
-- statement, including the audit rows its AFTER INSERT triggers would have written.
--
-- In a BEFORE INSERT trigger NEW.id is -1 when the id is left to AUTOINCREMENT (every legitimate
-- insert), so the id guards only match explicit ids that already exist.

-- A grant id is never reused: REPLACE with an existing id would un-revoke or rewrite a grant.
CREATE TRIGGER entitlement_grants_no_replace_id
BEFORE INSERT ON entitlement_grants
WHEN EXISTS (SELECT 1 FROM entitlement_grants WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'entitlement grants cannot be replaced');
END;

-- The partial unique index already refuses a second active OWNER grant for a plain INSERT, but
-- INSERT OR REPLACE would delete the active grant instead. Refuse before conflict resolution.
CREATE TRIGGER entitlement_grants_one_active_owner_no_replace
BEFORE INSERT ON entitlement_grants
WHEN NEW.tier = 'owner'
  AND NEW.revoked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM entitlement_grants
    WHERE account_id = NEW.account_id AND tier = 'owner' AND revoked_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'an account holds at most one active OWNER grant, grants cannot be replaced');
END;

CREATE TRIGGER audit_log_no_replace
BEFORE INSERT ON audit_log
WHEN EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER kalvoice_requests_no_replace_id
BEFORE INSERT ON kalvoice_requests
WHEN EXISTS (SELECT 1 FROM kalvoice_requests WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'kalvoice_requests is append-only');
END;

-- Same (account, client request id): skip the row. Identical to the worker's DO NOTHING, and a
-- REPLACE becomes a no-op that leaves the counted request untouched.
CREATE TRIGGER kalvoice_requests_no_replace_request
BEFORE INSERT ON kalvoice_requests
WHEN EXISTS (
  SELECT 1 FROM kalvoice_requests
  WHERE account_id = NEW.account_id AND client_request_id = NEW.client_request_id
)
BEGIN
  SELECT RAISE(IGNORE);
END;
