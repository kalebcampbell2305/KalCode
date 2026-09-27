-- Schema-only production shape observed before recovery; contains no production rows.
CREATE TABLE account_identities (
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google', 'microsoft')),
  subject TEXT NOT NULL CHECK (
    (provider = 'github' AND length(subject) BETWEEN 1 AND 64 AND subject NOT GLOB '*[^0-9]*')
    OR (provider = 'google' AND length(subject) BETWEEN 1 AND 255)
    OR (provider = 'microsoft' AND length(subject) BETWEEN 3 AND 320)
  ),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, account_id)
);

CREATE TABLE account_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 43),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1),
  email_verified_at TEXT NOT NULL CHECK (email_verified_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z')
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  account_id TEXT,

  details TEXT NOT NULL CHECK (json_valid(details))
);

CREATE TABLE auth_rate_limits (
  bucket_hash TEXT NOT NULL CHECK (length(bucket_hash) = 43),
  action TEXT NOT NULL CHECK (action IN ('oauth_start', 'oauth_complete')),
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 100000),
  PRIMARY KEY (bucket_hash, action)
);

CREATE TABLE billing_customers (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  stripe_customer_id TEXT UNIQUE CHECK (
    stripe_customer_id IS NULL OR (length(stripe_customer_id) BETWEEN 8 AND 255 AND stripe_customer_id GLOB 'cus_*')
  ),
  create_idempotency_key TEXT NOT NULL UNIQUE CHECK (length(create_idempotency_key) BETWEEN 16 AND 128),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE billing_subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY CHECK (stripe_subscription_id GLOB 'sub_*'),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  stripe_customer_id TEXT NOT NULL REFERENCES billing_customers(stripe_customer_id),
  tier TEXT NOT NULL CHECK (tier IN ('pro', 'max', 'max2x')),
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 32),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  reconciled_at TEXT NOT NULL,
  CHECK (period_end > period_start)
);

CREATE TABLE billing_sync_leases (
  stripe_subscription_id TEXT PRIMARY KEY CHECK (stripe_subscription_id GLOB 'sub_*'),
  lease_token TEXT NOT NULL CHECK (length(lease_token) BETWEEN 16 AND 128),
  version INTEGER NOT NULL CHECK (version > 0),
  expires_at TEXT NOT NULL
);

CREATE TABLE billing_webhook_events (
  event_id TEXT PRIMARY KEY CHECK (event_id GLOB 'evt_*'),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  result TEXT CHECK (result IS NULL OR result IN ('applied', 'ignored'))
);

CREATE TABLE "entitlement_grants" (
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
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 500), billing_subscription_id TEXT,
  CONSTRAINT owner_requires_operator_grant CHECK (tier <> 'owner' OR source = 'grant'),
  CONSTRAINT owner_never_expires CHECK (tier <> 'owner' OR expires_at IS NULL),
  CONSTRAINT billing_has_period_end CHECK (source <> 'billing' OR expires_at IS NOT NULL),
  CONSTRAINT revocation_is_complete CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL AND revoked_at >= granted_at)
  )
);

CREATE TABLE kalvoice_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  client_request_id TEXT NOT NULL CHECK (
    length(client_request_id) BETWEEN 8 AND 128
    AND client_request_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  recorded_at TEXT NOT NULL CHECK (recorded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),


  source TEXT NOT NULL CHECK (source IN ('online', 'offline_replay')),

  over_allowance INTEGER NOT NULL DEFAULT 0 CHECK (over_allowance IN (0, 1)),
  UNIQUE (account_id, client_request_id)
);

CREATE TABLE oauth_attempts (
  state_hash TEXT PRIMARY KEY CHECK (length(state_hash) = 43),
  code_challenge TEXT NOT NULL CHECK (length(code_challenge) = 43 AND code_challenge NOT GLOB '*[^A-Za-z0-9_-]*'),
  rate_bucket TEXT NOT NULL CHECK (length(rate_bucket) = 43),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT, provider TEXT NOT NULL DEFAULT 'github'
  CHECK (provider IN ('github', 'google', 'microsoft')), nonce_hash TEXT
  CHECK (
    (provider = 'github' AND nonce_hash IS NULL)
    OR (
      provider IN ('google', 'microsoft')
      AND nonce_hash IS NOT NULL
      AND length(nonce_hash) = 43
      AND nonce_hash NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX account_sessions_account ON account_sessions (account_id, expires_at, revoked_at);

CREATE INDEX audit_log_account ON audit_log (account_id, occurred_at);

CREATE INDEX billing_subscriptions_account ON billing_subscriptions (account_id, status);

CREATE INDEX entitlement_grants_account ON entitlement_grants (account_id, revoked_at);

CREATE UNIQUE INDEX entitlement_grants_one_active_billing_subscription
  ON entitlement_grants (billing_subscription_id)
  WHERE billing_subscription_id IS NOT NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX entitlement_grants_one_active_owner ON entitlement_grants (account_id)
  WHERE tier = 'owner' AND revoked_at IS NULL;

CREATE INDEX kalvoice_requests_account_time ON kalvoice_requests (account_id, recorded_at);

CREATE INDEX oauth_attempts_expiry ON oauth_attempts (expires_at);

CREATE TRIGGER audit_log_append_only_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_append_only_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_replace
BEFORE INSERT ON audit_log
WHEN EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
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

CREATE TRIGGER entitlement_grants_billing_link_required
BEFORE INSERT ON entitlement_grants
WHEN (NEW.source = 'billing' AND NEW.billing_subscription_id IS NULL)
  OR (NEW.source <> 'billing' AND NEW.billing_subscription_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'new billing grants require exactly one billing subscription');
END;

CREATE TRIGGER entitlement_grants_immutable
BEFORE UPDATE ON entitlement_grants
WHEN NEW.id IS NOT OLD.id
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.tier IS NOT OLD.tier
  OR NEW.source IS NOT OLD.source
  OR NEW.granted_by IS NOT OLD.granted_by
  OR NEW.reason IS NOT OLD.reason
  OR NEW.granted_at IS NOT OLD.granted_at
  OR NEW.billing_subscription_id IS NOT OLD.billing_subscription_id
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

CREATE TRIGGER entitlement_grants_no_replace_id
BEFORE INSERT ON entitlement_grants
WHEN EXISTS (SELECT 1 FROM entitlement_grants WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'entitlement grants cannot be replaced');
END;

CREATE TRIGGER entitlement_grants_one_active_billing_no_replace
BEFORE INSERT ON entitlement_grants
WHEN NEW.billing_subscription_id IS NOT NULL
  AND NEW.revoked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM entitlement_grants
    WHERE billing_subscription_id = NEW.billing_subscription_id AND revoked_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'an active billing subscription grant cannot be replaced');
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

CREATE TRIGGER kalvoice_requests_append_only_delete
BEFORE DELETE ON kalvoice_requests
BEGIN
  SELECT RAISE(ABORT, 'kalvoice_requests is append-only');
END;

CREATE TRIGGER kalvoice_requests_append_only_update
BEFORE UPDATE ON kalvoice_requests
BEGIN
  SELECT RAISE(ABORT, 'kalvoice_requests is append-only');
END;

CREATE TRIGGER kalvoice_requests_no_replace_id
BEFORE INSERT ON kalvoice_requests
WHEN EXISTS (SELECT 1 FROM kalvoice_requests WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'kalvoice_requests is append-only');
END;

CREATE TRIGGER kalvoice_requests_no_replace_request
BEFORE INSERT ON kalvoice_requests
WHEN EXISTS (
  SELECT 1 FROM kalvoice_requests
  WHERE account_id = NEW.account_id AND client_request_id = NEW.client_request_id
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER owner_grant_refuses_unsettled_subscription
BEFORE INSERT ON entitlement_grants
WHEN NEW.tier = 'owner' AND NEW.source = 'grant' AND EXISTS (
  SELECT 1 FROM billing_subscriptions
  WHERE account_id = NEW.account_id AND status NOT IN ('canceled', 'incomplete_expired')
)
BEGIN
  SELECT RAISE(ABORT, 'OWNER grant requires paid subscriptions to be settled');
END;
