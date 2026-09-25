-- Add MAX 2X without weakening the existing grant, audit, or OWNER invariants.
--
-- SQLite cannot alter a CHECK constraint in place, so rebuild only entitlement_grants, copy every
-- row verbatim, then restore all indexes and triggers from 0001 and 0003. Unknown tiers still fail
-- closed at the database boundary.

CREATE TABLE entitlement_grants_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  tier TEXT NOT NULL CHECK (tier IN ('pro', 'max', 'max2x', 'owner')),
  source TEXT NOT NULL CHECK (source IN ('billing', 'grant')),
  granted_by TEXT NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  granted_at TEXT NOT NULL CHECK (granted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  expires_at TEXT CHECK (expires_at IS NULL OR expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  revoked_by TEXT CHECK (revoked_by IS NULL OR length(revoked_by) BETWEEN 1 AND 200),
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 500),
  CONSTRAINT owner_requires_operator_grant CHECK (tier <> 'owner' OR source = 'grant'),
  CONSTRAINT owner_never_expires CHECK (tier <> 'owner' OR expires_at IS NULL),
  CONSTRAINT billing_has_period_end CHECK (source <> 'billing' OR expires_at IS NOT NULL),
  CONSTRAINT revocation_is_complete CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL AND revoked_at >= granted_at)
  )
);

INSERT INTO entitlement_grants_v2 (
  id, account_id, tier, source, granted_by, reason, granted_at, expires_at,
  revoked_at, revoked_by, revoke_reason
)
SELECT
  id, account_id, tier, source, granted_by, reason, granted_at, expires_at,
  revoked_at, revoked_by, revoke_reason
FROM entitlement_grants;

DROP TABLE entitlement_grants;
ALTER TABLE entitlement_grants_v2 RENAME TO entitlement_grants;

CREATE INDEX entitlement_grants_account ON entitlement_grants (account_id, revoked_at);
CREATE UNIQUE INDEX entitlement_grants_one_active_owner ON entitlement_grants (account_id)
  WHERE tier = 'owner' AND revoked_at IS NULL;

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

CREATE TRIGGER entitlement_grants_no_replace_id
BEFORE INSERT ON entitlement_grants
WHEN EXISTS (SELECT 1 FROM entitlement_grants WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'entitlement grants cannot be replaced');
END;

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
