-- KalCode accounts and server-authoritative entitlements (docs/BILLING.md, docs/DATA_MODEL.md §4).
--
-- Invariants enforced here, in the database, so no application path can bypass them:
--   * The OWNER tier can only come from an operator grant (source 'grant'), never from billing.
--   * OWNER grants never expire (expires_at is NULL) and an account holds at most one active one.
--   * Billing grants are Pro or MAX and always carry the end of the paid period.
--   * Grants are immutable except for revocation (and billing period changes); revocation is final.
--   * Every grant, revocation and billing-period change is written to audit_log by triggers, in
--     the same statement — there is no way to change entitlements without an audit row.
--   * audit_log is append-only.
-- Timestamps are UTC ISO-8601 strings with milliseconds (`Date#toISOString()`), so string
-- comparison is chronological.

-- Accounts exist only once sign-in (campaign Z13) has verified the email address.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1),
  email_verified_at TEXT NOT NULL CHECK (email_verified_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z')
);

-- Free is the absence of an active grant, so it never appears here.
CREATE TABLE entitlement_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  tier TEXT NOT NULL CHECK (tier IN ('pro', 'max', 'owner')),
  source TEXT NOT NULL CHECK (source IN ('billing', 'grant')),
  granted_by TEXT NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  granted_at TEXT NOT NULL CHECK (granted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  -- End of validity. Billing: end of the paid period (required). Operator Pro/MAX grants: optional.
  expires_at TEXT CHECK (expires_at IS NULL OR expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  revoked_by TEXT CHECK (revoked_by IS NULL OR length(revoked_by) BETWEEN 1 AND 200),
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 500),
  -- OWNER is granted by trusted operators only. No billing path can ever create it.
  CONSTRAINT owner_requires_operator_grant CHECK (tier <> 'owner' OR source = 'grant'),
  -- OWNER never expires.
  CONSTRAINT owner_never_expires CHECK (tier <> 'owner' OR expires_at IS NULL),
  -- A paid subscription always has a period end.
  CONSTRAINT billing_has_period_end CHECK (source <> 'billing' OR expires_at IS NOT NULL),
  CONSTRAINT revocation_is_complete CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL AND revoked_at >= granted_at)
  )
);

CREATE INDEX entitlement_grants_account ON entitlement_grants (account_id, revoked_at);

-- At most one active OWNER grant per account.
CREATE UNIQUE INDEX entitlement_grants_one_active_owner ON entitlement_grants (account_id)
  WHERE tier = 'owner' AND revoked_at IS NULL;

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  account_id TEXT,
  -- JSON object with the action's details. Never secrets or tokens.
  details TEXT NOT NULL CHECK (json_valid(details))
);

CREATE INDEX audit_log_account ON audit_log (account_id, occurred_at);

-- Identity fields of a grant never change, a revoked grant stays revoked, and an operator
-- grant's validity cannot be edited (revoke and grant again instead).
CREATE TRIGGER entitlement_grants_immutable
BEFORE UPDATE ON entitlement_grants
WHEN NEW.id IS NOT OLD.id
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.tier IS NOT OLD.tier
  OR NEW.source IS NOT OLD.source
  OR NEW.granted_by IS NOT OLD.granted_by
  OR NEW.reason IS NOT OLD.reason
  OR NEW.granted_at IS NOT OLD.granted_at
  OR OLD.revoked_at IS NOT NULL
  OR (OLD.source = 'grant' AND NEW.expires_at IS NOT OLD.expires_at)
BEGIN
  SELECT RAISE(ABORT, 'entitlement grants are immutable except for revocation');
END;

-- Grants are revoked, never deleted, so the history stays complete.
CREATE TRIGGER entitlement_grants_no_delete
BEFORE DELETE ON entitlement_grants
BEGIN
  SELECT RAISE(ABORT, 'entitlement grants cannot be deleted; revoke them');
END;

CREATE TRIGGER entitlement_grants_audit_insert
AFTER INSERT ON entitlement_grants
BEGIN
  INSERT INTO audit_log (occurred_at, actor, action, account_id, details)
  VALUES (
    NEW.granted_at,
    NEW.granted_by,
    'entitlement.granted',
    NEW.account_id,
    json_object('grant_id', NEW.id, 'tier', NEW.tier, 'source', NEW.source, 'reason', NEW.reason, 'expires_at', NEW.expires_at)
  );
END;

CREATE TRIGGER entitlement_grants_audit_revoke
AFTER UPDATE OF revoked_at ON entitlement_grants
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO audit_log (occurred_at, actor, action, account_id, details)
  VALUES (
    NEW.revoked_at,
    NEW.revoked_by,
    'entitlement.revoked',
    NEW.account_id,
    json_object('grant_id', NEW.id, 'tier', NEW.tier, 'source', NEW.source, 'reason', NEW.revoke_reason)
  );
END;

CREATE TRIGGER entitlement_grants_audit_period
AFTER UPDATE OF expires_at ON entitlement_grants
WHEN NEW.expires_at IS NOT OLD.expires_at
BEGIN
  INSERT INTO audit_log (occurred_at, actor, action, account_id, details)
  VALUES (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'billing',
    'entitlement.period_changed',
    NEW.account_id,
    json_object('grant_id', NEW.id, 'tier', NEW.tier, 'from', OLD.expires_at, 'to', NEW.expires_at)
  );
END;

CREATE TRIGGER audit_log_append_only_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_append_only_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
