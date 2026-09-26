-- Verified GitHub identities, revocable hashed sessions, and Stripe reconciliation authority.
-- Raw OAuth state, bearer tokens, authorization codes, provider tokens and webhook secrets are
-- never stored. Billing mutations are serialized by a versioned lease; every grant mutation must
-- prove the current, unexpired fencing token in the same D1 batch.

CREATE TABLE oauth_attempts (
  state_hash TEXT PRIMARY KEY CHECK (length(state_hash) = 43),
  code_challenge TEXT NOT NULL CHECK (length(code_challenge) = 43 AND code_challenge NOT GLOB '*[^A-Za-z0-9_-]*'),
  rate_bucket TEXT NOT NULL CHECK (length(rate_bucket) = 43),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX oauth_attempts_expiry ON oauth_attempts (expires_at);

CREATE TABLE account_identities (
  provider TEXT NOT NULL CHECK (provider = 'github'),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 64 AND subject NOT GLOB '*[^0-9]*'),
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
  client_kind TEXT NOT NULL CHECK (client_kind IN ('desktop', 'website')),
  revoked_at TEXT,
  rotated_to_hash TEXT UNIQUE CHECK (rotated_to_hash IS NULL OR length(rotated_to_hash) = 43),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX account_sessions_account ON account_sessions (account_id, expires_at, revoked_at);

CREATE TABLE auth_rate_limits (
  bucket_hash TEXT NOT NULL CHECK (length(bucket_hash) = 43),
  action TEXT NOT NULL CHECK (action IN ('oauth_start', 'oauth_complete', 'email_start', 'email_verify', 'email_poll', 'session_refresh', 'account_delete')),
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 100000),
  PRIMARY KEY (bucket_hash, action)
);
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits (window_started_at);

ALTER TABLE accounts ADD COLUMN activated_at TEXT;
ALTER TABLE accounts ADD COLUMN deleted_at TEXT;

-- Accounts created before the explicit plan-choice gate already had usable Free access. Preserve
-- that upgrade behavior; accounts created after this migration start unactivated.
UPDATE accounts SET activated_at = created_at WHERE activated_at IS NULL;

CREATE TABLE email_signin_attempts (
  verify_hash TEXT PRIMARY KEY CHECK (length(verify_hash) = 43),
  poll_hash TEXT NOT NULL UNIQUE CHECK (length(poll_hash) = 43),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND instr(email, '@') > 1),
  client_kind TEXT NOT NULL CHECK (client_kind IN ('desktop', 'website')),
  purpose TEXT NOT NULL CHECK (purpose IN ('signin', 'delete')),
  code_challenge TEXT CHECK (code_challenge IS NULL OR length(code_challenge) = 43),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  account_id TEXT REFERENCES accounts(id),
  consumed_at TEXT,
  consume_nonce TEXT UNIQUE CHECK (consume_nonce IS NULL OR length(consume_nonce) = 43),
  CHECK ((client_kind = 'desktop' AND code_challenge IS NOT NULL) OR (client_kind = 'website' AND code_challenge IS NULL)),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR (verified_at IS NOT NULL AND account_id IS NOT NULL))
);
CREATE INDEX email_signin_attempts_expiry ON email_signin_attempts (expires_at);

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
  tier TEXT CHECK (tier IS NULL OR tier IN ('pro', 'max', 'max2x')),
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 32),
  period_start TEXT,
  period_end TEXT,
  reconciled_at TEXT NOT NULL,
  CHECK (
    (status = 'invalid' AND tier IS NULL AND period_start IS NULL AND period_end IS NULL)
    OR (tier IS NOT NULL AND period_start IS NOT NULL AND period_end IS NOT NULL AND period_end > period_start)
  )
);
CREATE INDEX billing_subscriptions_account ON billing_subscriptions (account_id, status);

CREATE TABLE billing_webhook_events (
  event_id TEXT PRIMARY KEY CHECK (event_id GLOB 'evt_*'),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  event_subject TEXT CHECK (event_subject IS NULL OR event_subject GLOB 'sub_*'),
  received_at TEXT NOT NULL,
  claim_token TEXT NOT NULL CHECK (length(claim_token) BETWEEN 16 AND 128),
  claim_version INTEGER NOT NULL CHECK (claim_version > 0),
  claim_expires_at TEXT NOT NULL,
  processed_at TEXT,
  result TEXT CHECK (result IS NULL OR result IN ('applied', 'ignored'))
);

CREATE TABLE billing_action_limits (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('checkout', 'portal')),
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 100000),
  PRIMARY KEY (account_id, action)
);

CREATE TABLE billing_checkout_intents (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('pro', 'max', 'max2x')),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 43),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  stripe_checkout_session_id TEXT UNIQUE CHECK (
    stripe_checkout_session_id IS NULL OR stripe_checkout_session_id GLOB 'cs_*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finalized_at TEXT,
  CHECK (expires_at > created_at)
);

-- Durable handoff between a subscription reconciliation and Stripe Checkout cleanup. An active
-- grant may delete its local intent only after copying the remote session id here. Webhook retries
-- continue cleanup until the session is either expired or already terminal.
CREATE TABLE billing_checkout_invalidations (
  stripe_checkout_session_id TEXT PRIMARY KEY CHECK (stripe_checkout_session_id GLOB 'cs_*'),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_subscription_id TEXT NOT NULL CHECK (source_subscription_id GLOB 'sub_*'),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX billing_checkout_invalidations_pending
  ON billing_checkout_invalidations (source_subscription_id, completed_at);

-- Billing code can atomically exclude OWNER without owning or duplicating OWNER grant authority.
CREATE VIEW active_owner_accounts AS
SELECT account_id FROM entitlement_grants
WHERE tier = 'owner' AND source = 'grant' AND revoked_at IS NULL;

CREATE TABLE billing_sync_leases (
  stripe_subscription_id TEXT PRIMARY KEY CHECK (stripe_subscription_id GLOB 'sub_*'),
  lease_token TEXT NOT NULL CHECK (length(lease_token) BETWEEN 16 AND 128),
  version INTEGER NOT NULL CHECK (version > 0),
  expires_at TEXT NOT NULL
);

ALTER TABLE entitlement_grants ADD COLUMN billing_subscription_id TEXT;

CREATE UNIQUE INDEX entitlement_grants_one_active_billing_subscription
  ON entitlement_grants (billing_subscription_id)
  WHERE billing_subscription_id IS NOT NULL AND revoked_at IS NULL;

-- Legacy billing grants copied by earlier migrations may have no link. Every new billing grant
-- must be subscription-owned, while operator grants must never claim a billing subscription.
CREATE TRIGGER entitlement_grants_billing_link_required
BEFORE INSERT ON entitlement_grants
WHEN (NEW.source = 'billing' AND NEW.billing_subscription_id IS NULL)
  OR (NEW.source <> 'billing' AND NEW.billing_subscription_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'new billing grants require exactly one billing subscription');
END;

-- `INSERT OR REPLACE` would otherwise satisfy the active-subscription unique index by silently
-- deleting the current grant. Refuse before conflict resolution so revocation history is kept.
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

DROP TRIGGER entitlement_grants_immutable;
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

-- A deleted identity can never regain authority through a delayed webhook or operator mistake.
CREATE TRIGGER entitlement_grants_require_live_account
BEFORE INSERT ON entitlement_grants
WHEN EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND deleted_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'deleted accounts cannot receive entitlement grants');
END;

-- A Checkout URL may already have left KalCode. Preserve its remote-session handle and refuse the
-- operator grant until that bounded session is terminal; never silently create OWNER while a
-- public paid Checkout remains usable. Unfinalized or expired intents can be invalidated locally.
CREATE TRIGGER owner_grant_refuses_open_checkout
BEFORE INSERT ON entitlement_grants
WHEN NEW.tier = 'owner' AND NEW.source = 'grant' AND EXISTS (
  SELECT 1 FROM billing_checkout_intents
  WHERE account_id = NEW.account_id AND stripe_checkout_session_id IS NOT NULL
    AND expires_at > NEW.granted_at
)
BEGIN
  SELECT RAISE(ABORT, 'OWNER grant requires the open Checkout Session to become terminal');
END;

-- OWNER is created only by the trusted operator path. The grant itself is the explicit activation
-- event, so a newly verified owner does not need to select Free before receiving OWNER.
CREATE TRIGGER owner_grant_activates_account
AFTER INSERT ON entitlement_grants
WHEN NEW.tier = 'owner' AND NEW.source = 'grant'
BEGIN
  UPDATE accounts SET activated_at = COALESCE(activated_at, NEW.granted_at)
  WHERE id = NEW.account_id AND deleted_at IS NULL;
  DELETE FROM billing_checkout_intents WHERE account_id = NEW.account_id;
END;
