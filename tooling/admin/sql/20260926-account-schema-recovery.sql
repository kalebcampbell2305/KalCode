-- Bounded recovery for the deployed legacy 0005 schema; run before numbered 0008.

-- This does not rewrite an applied migration or read/export production rows.

-- Execute as one atomic D1 file batch. Guards reject replay and unknown partial schemas.

CREATE TABLE kalcode_account_schema_recovery_guard (ok INTEGER NOT NULL CHECK (ok = 1));

INSERT INTO kalcode_account_schema_recovery_guard VALUES ((SELECT count(*) = 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts' AND replace(replace(replace(replace(replace(sql, char(10), ''), char(13), ''), char(9), ''), ' ', ''), '"', '') = 'CREATETABLEaccounts(idTEXTPRIMARYKEYCHECK(length(id)BETWEEN1AND64),emailTEXTNOTNULLUNIQUECOLLATENOCASECHECK(length(email)BETWEEN3AND254ANDinstr(email,''@'')>1),email_verified_atTEXTNOTNULLCHECK(email_verified_atGLOB''[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z''),created_atTEXTNOTNULLCHECK(created_atGLOB''[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z''))'));

INSERT INTO kalcode_account_schema_recovery_guard VALUES ((SELECT count(*) = 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_sessions' AND replace(replace(replace(replace(replace(sql, char(10), ''), char(13), ''), char(9), ''), ' ', ''), '"', '') = 'CREATETABLEaccount_sessions(token_hashTEXTPRIMARYKEYCHECK(length(token_hash)=43),account_idTEXTNOTNULLREFERENCESaccounts(id),created_atTEXTNOTNULL,expires_atTEXTNOTNULL,revoked_atTEXT,CHECK(expires_at>created_at),CHECK(revoked_atISNULLORrevoked_at>=created_at))'));

INSERT INTO kalcode_account_schema_recovery_guard VALUES ((SELECT count(*) = 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_rate_limits' AND replace(replace(replace(replace(replace(sql, char(10), ''), char(13), ''), char(9), ''), ' ', ''), '"', '') = 'CREATETABLEauth_rate_limits(bucket_hashTEXTNOTNULLCHECK(length(bucket_hash)=43),actionTEXTNOTNULLCHECK(actionIN(''oauth_start'',''oauth_complete'')),window_started_atTEXTNOTNULL,request_countINTEGERNOTNULLCHECK(request_countBETWEEN1AND100000),PRIMARYKEY(bucket_hash,action))'));

INSERT INTO kalcode_account_schema_recovery_guard VALUES ((SELECT count(*) = 1 FROM sqlite_master WHERE type = 'table' AND name = 'billing_subscriptions' AND replace(replace(replace(replace(replace(sql, char(10), ''), char(13), ''), char(9), ''), ' ', ''), '"', '') = 'CREATETABLEbilling_subscriptions(stripe_subscription_idTEXTPRIMARYKEYCHECK(stripe_subscription_idGLOB''sub_*''),account_idTEXTNOTNULLREFERENCESaccounts(id),stripe_customer_idTEXTNOTNULLREFERENCESbilling_customers(stripe_customer_id),tierTEXTNOTNULLCHECK(tierIN(''pro'',''max'',''max2x'')),statusTEXTNOTNULLCHECK(length(status)BETWEEN1AND32),period_startTEXTNOTNULL,period_endTEXTNOTNULL,reconciled_atTEXTNOTNULL,CHECK(period_end>period_start))'));

INSERT INTO kalcode_account_schema_recovery_guard VALUES ((SELECT count(*) = 1 FROM sqlite_master WHERE type = 'table' AND name = 'billing_webhook_events' AND replace(replace(replace(replace(replace(sql, char(10), ''), char(13), ''), char(9), ''), ' ', ''), '"', '') = 'CREATETABLEbilling_webhook_events(event_idTEXTPRIMARYKEYCHECK(event_idGLOB''evt_*''),event_typeTEXTNOTNULLCHECK(length(event_type)BETWEEN1AND100),received_atTEXTNOTNULL,processed_atTEXT,resultTEXTCHECK(resultISNULLORresultIN(''applied'',''ignored'')))'));

INSERT INTO kalcode_account_schema_recovery_guard VALUES ((SELECT count(*) = 0 FROM sqlite_master WHERE name IN ('active_owner_accounts', 'auth_rate_limits_expiry', 'billing_action_limits', 'billing_checkout_intents', 'billing_checkout_invalidations', 'billing_checkout_invalidations_pending', 'email_signin_attempts', 'email_signin_attempts_expiry', 'entitlement_grants_require_live_account', 'owner_grant_activates_account', 'owner_grant_refuses_open_checkout')));

-- Legacy receipts lack an authenticated subject binding. Never guess or silently bind them.
INSERT INTO kalcode_account_schema_recovery_guard VALUES ((SELECT count(*) = 0 FROM billing_webhook_events));

ALTER TABLE accounts ADD COLUMN activated_at TEXT;

ALTER TABLE accounts ADD COLUMN deleted_at TEXT;

UPDATE accounts SET activated_at = created_at WHERE activated_at IS NULL;

CREATE TABLE account_sessions_recovery_20260926 (
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

INSERT INTO account_sessions_recovery_20260926 (token_hash, account_id, created_at, expires_at, revoked_at, client_kind, rotated_to_hash) SELECT token_hash, account_id, created_at, expires_at, revoked_at, 'desktop', NULL FROM account_sessions;

DROP TABLE account_sessions;

ALTER TABLE account_sessions_recovery_20260926 RENAME TO account_sessions;

CREATE INDEX account_sessions_account ON account_sessions (account_id, expires_at, revoked_at);

CREATE TABLE auth_rate_limits_recovery_20260926 (
  bucket_hash TEXT NOT NULL CHECK (length(bucket_hash) = 43),
  action TEXT NOT NULL CHECK (action IN ('oauth_start', 'oauth_complete', 'email_start', 'email_verify', 'email_poll', 'session_refresh', 'account_delete')),
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 100000),
  PRIMARY KEY (bucket_hash, action)
);

INSERT INTO auth_rate_limits_recovery_20260926 (bucket_hash, action, window_started_at, request_count) SELECT bucket_hash, action, window_started_at, request_count FROM auth_rate_limits;

DROP TABLE auth_rate_limits;

ALTER TABLE auth_rate_limits_recovery_20260926 RENAME TO auth_rate_limits;

CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits (window_started_at);

DROP TRIGGER owner_grant_refuses_unsettled_subscription;

CREATE TABLE billing_subscriptions_recovery_20260926 (
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

INSERT INTO billing_subscriptions_recovery_20260926 (stripe_subscription_id, account_id, stripe_customer_id, tier, status, period_start, period_end, reconciled_at) SELECT stripe_subscription_id, account_id, stripe_customer_id, tier, status, period_start, period_end, reconciled_at FROM billing_subscriptions;

DROP TABLE billing_subscriptions;

ALTER TABLE billing_subscriptions_recovery_20260926 RENAME TO billing_subscriptions;

CREATE INDEX billing_subscriptions_account ON billing_subscriptions (account_id, status);

CREATE TRIGGER owner_grant_refuses_unsettled_subscription
BEFORE INSERT ON entitlement_grants
WHEN NEW.tier = 'owner' AND NEW.source = 'grant' AND EXISTS (
  SELECT 1 FROM billing_subscriptions
  WHERE account_id = NEW.account_id AND status NOT IN ('canceled', 'incomplete_expired')
)
BEGIN
  SELECT RAISE(ABORT, 'OWNER grant requires paid subscriptions to be settled');
END;

CREATE TABLE billing_webhook_events_recovery_20260926 (
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


DROP TABLE billing_webhook_events;

ALTER TABLE billing_webhook_events_recovery_20260926 RENAME TO billing_webhook_events;

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

CREATE TABLE billing_checkout_invalidations (
  stripe_checkout_session_id TEXT PRIMARY KEY CHECK (stripe_checkout_session_id GLOB 'cs_*'),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_subscription_id TEXT NOT NULL CHECK (source_subscription_id GLOB 'sub_*'),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

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

CREATE INDEX billing_checkout_invalidations_pending
  ON billing_checkout_invalidations (source_subscription_id, completed_at);

CREATE INDEX email_signin_attempts_expiry ON email_signin_attempts (expires_at);

CREATE VIEW active_owner_accounts AS
SELECT account_id FROM entitlement_grants
WHERE tier = 'owner' AND source = 'grant' AND revoked_at IS NULL;

CREATE TRIGGER entitlement_grants_require_live_account
BEFORE INSERT ON entitlement_grants
WHEN EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND deleted_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'deleted accounts cannot receive entitlement grants');
END;

CREATE TRIGGER owner_grant_activates_account
AFTER INSERT ON entitlement_grants
WHEN NEW.tier = 'owner' AND NEW.source = 'grant'
BEGIN
  UPDATE accounts SET activated_at = COALESCE(activated_at, NEW.granted_at)
  WHERE id = NEW.account_id AND deleted_at IS NULL;
  DELETE FROM billing_checkout_intents WHERE account_id = NEW.account_id;
END;

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

DROP TABLE kalcode_account_schema_recovery_guard;
