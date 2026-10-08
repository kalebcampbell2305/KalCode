-- KalCode games (KAL University): lifetime ownership, the payments behind it, perk claims, device
-- sign-in for the game and game-license sessions. Policy: docs/BILLING.md §13.
--
-- Invariants enforced here, so no application path can bypass them:
--   * Ownership exists only because of a recorded qualifying payment (standalone or a subscription
--     invoice). The OWNER operator account is resolved at read time and never stored here.
--   * Ownership is revoked only when no counting payment ('paid' or 'refunded_late') remains, and
--     every grant, revocation and restoration writes audit_log in the same statement.
--   * Perk claims are insert-only: they persist after cancellation and can never be claimed twice.
--   * Payments, ownership and claims are never deleted. Deleted accounts can gain nothing.
--   * Device codes, user codes and license refresh tokens are stored only as SHA-256 hashes.

CREATE TABLE game_payments (
  payment_ref TEXT PRIMARY KEY CHECK (
    length(payment_ref) BETWEEN 4 AND 255 AND (payment_ref GLOB 'in_*' OR payment_ref GLOB 'cs_*')
  ),
  payment_intent TEXT NOT NULL UNIQUE CHECK (length(payment_intent) BETWEEN 4 AND 255 AND payment_intent GLOB 'pi_*'),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  game_id TEXT NOT NULL CHECK (game_id IN ('kal_university')),
  source TEXT NOT NULL CHECK (source IN ('standalone', 'pro', 'max', 'max2x')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  paid_at TEXT NOT NULL,
  -- paid: counts. refunded_late: fully refunded after the revocation window, still counts.
  -- refunded: fully refunded inside the window. fraud: refunded as fraudulent. dispute_lost.
  status TEXT NOT NULL CHECK (status IN ('paid', 'refunded_late', 'refunded', 'fraud', 'dispute_lost')),
  status_at TEXT NOT NULL,
  CHECK ((source = 'standalone') = (payment_ref GLOB 'cs_*'))
);
CREATE INDEX game_payments_account ON game_payments (account_id, game_id, status);

CREATE TABLE game_entitlements (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  game_id TEXT NOT NULL CHECK (game_id IN ('kal_university')),
  source TEXT NOT NULL CHECK (source IN ('standalone', 'pro', 'max', 'max2x')),
  granted_at TEXT NOT NULL,
  granting_payment_ref TEXT NOT NULL REFERENCES game_payments(payment_ref),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revoked_at TEXT,
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR revoked_reason IN ('refund', 'fraud', 'dispute_lost')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, game_id),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
  )
);

CREATE TRIGGER game_entitlements_require_live_account
BEFORE INSERT ON game_entitlements
WHEN EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND deleted_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'deleted accounts cannot own games');
END;

CREATE TRIGGER game_entitlements_identity_immutable
BEFORE UPDATE ON game_entitlements
WHEN NEW.account_id IS NOT OLD.account_id OR NEW.game_id IS NOT OLD.game_id
BEGIN
  SELECT RAISE(ABORT, 'game ownership identity is immutable');
END;

-- Revocation needs proof: no counting payment may remain for that account and game.
CREATE TRIGGER game_entitlements_revoke_requires_no_counting_payment
BEFORE UPDATE OF status ON game_entitlements
WHEN NEW.status = 'revoked' AND EXISTS (
  SELECT 1 FROM game_payments
  WHERE account_id = NEW.account_id AND game_id = NEW.game_id AND status IN ('paid', 'refunded_late')
)
BEGIN
  SELECT RAISE(ABORT, 'game ownership cannot be revoked while a counting payment remains');
END;

-- Ownership is granted or restored only by a counting payment of the same account and game.
CREATE TRIGGER game_entitlements_grant_requires_counting_payment
BEFORE INSERT ON game_entitlements
WHEN NOT EXISTS (
  SELECT 1 FROM game_payments
  WHERE payment_ref = NEW.granting_payment_ref AND account_id = NEW.account_id AND game_id = NEW.game_id
    AND status IN ('paid', 'refunded_late')
)
BEGIN
  SELECT RAISE(ABORT, 'game ownership requires a counting payment');
END;

CREATE TRIGGER game_entitlements_restore_requires_counting_payment
BEFORE UPDATE OF status ON game_entitlements
WHEN NEW.status = 'active' AND OLD.status = 'revoked' AND NOT EXISTS (
  SELECT 1 FROM game_payments
  WHERE payment_ref = NEW.granting_payment_ref AND account_id = NEW.account_id AND game_id = NEW.game_id
    AND status IN ('paid', 'refunded_late')
)
BEGIN
  SELECT RAISE(ABORT, 'game ownership requires a counting payment');
END;

CREATE TRIGGER game_entitlements_no_delete
BEFORE DELETE ON game_entitlements
BEGIN
  SELECT RAISE(ABORT, 'game ownership cannot be deleted; it is revoked');
END;

CREATE TRIGGER game_payments_no_delete
BEFORE DELETE ON game_payments
BEGIN
  SELECT RAISE(ABORT, 'game payments cannot be deleted');
END;

CREATE TRIGGER game_payments_identity_immutable
BEFORE UPDATE ON game_payments
WHEN NEW.payment_ref IS NOT OLD.payment_ref OR NEW.payment_intent IS NOT OLD.payment_intent
  OR NEW.account_id IS NOT OLD.account_id OR NEW.game_id IS NOT OLD.game_id OR NEW.source IS NOT OLD.source
  OR NEW.amount_cents IS NOT OLD.amount_cents OR NEW.currency IS NOT OLD.currency OR NEW.paid_at IS NOT OLD.paid_at
BEGIN
  SELECT RAISE(ABORT, 'game payments are immutable except for their status');
END;

CREATE TRIGGER game_entitlements_audit_insert
AFTER INSERT ON game_entitlements
BEGIN
  INSERT INTO audit_log (occurred_at, actor, action, account_id, details)
  VALUES (
    NEW.granted_at, 'billing', 'game.ownership_granted', NEW.account_id,
    json_object('game_id', NEW.game_id, 'source', NEW.source, 'payment', NEW.granting_payment_ref)
  );
END;

CREATE TRIGGER game_entitlements_audit_status
AFTER UPDATE OF status ON game_entitlements
WHEN NEW.status IS NOT OLD.status
BEGIN
  INSERT INTO audit_log (occurred_at, actor, action, account_id, details)
  VALUES (
    NEW.updated_at, 'billing',
    CASE NEW.status WHEN 'revoked' THEN 'game.ownership_revoked' ELSE 'game.ownership_restored' END,
    NEW.account_id,
    json_object('game_id', NEW.game_id, 'source', NEW.source, 'payment', NEW.granting_payment_ref,
      'reason', NEW.revoked_reason)
  );
END;

CREATE TABLE game_perk_claims (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  game_id TEXT NOT NULL CHECK (game_id IN ('kal_university')),
  perk_id TEXT NOT NULL CHECK (length(perk_id) BETWEEN 1 AND 64 AND perk_id NOT GLOB '*[^a-z0-9_]*'),
  tier TEXT NOT NULL CHECK (tier IN ('pro', 'max', 'max2x')),
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (account_id, game_id, perk_id)
);

CREATE TRIGGER game_perk_claims_immutable
BEFORE UPDATE ON game_perk_claims
BEGIN
  SELECT RAISE(ABORT, 'perk claims are immutable');
END;

CREATE TRIGGER game_perk_claims_no_delete
BEFORE DELETE ON game_perk_claims
BEGIN
  SELECT RAISE(ABORT, 'perk claims cannot be deleted');
END;

CREATE TRIGGER game_perk_claims_require_live_account
BEFORE INSERT ON game_perk_claims
WHEN EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND deleted_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'deleted accounts cannot claim perks');
END;

-- Device sign-in for the game (OAuth 2.0 device authorization grant shape, RFC 8628).
CREATE TABLE game_device_authorizations (
  device_code_hash TEXT PRIMARY KEY CHECK (length(device_code_hash) = 43),
  user_code_hash TEXT NOT NULL UNIQUE CHECK (length(user_code_hash) = 43),
  game_id TEXT NOT NULL CHECK (game_id IN ('kal_university')),
  device_hash TEXT CHECK (device_hash IS NULL OR length(device_hash) = 43),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_polled_at TEXT,
  approved_at TEXT,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  consumed_at TEXT,
  CHECK (expires_at > created_at),
  CHECK ((approved_at IS NULL) = (account_id IS NULL)),
  CHECK (consumed_at IS NULL OR approved_at IS NOT NULL)
);
CREATE INDEX game_device_authorizations_expiry ON game_device_authorizations (expires_at);

-- A signed-in game install. The opaque refresh token only renews this game's license.
CREATE TABLE game_license_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 43),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  game_id TEXT NOT NULL CHECK (game_id IN ('kal_university')),
  device_hash TEXT CHECK (device_hash IS NULL OR length(device_hash) = 43),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (expires_at > created_at)
);
CREATE INDEX game_license_sessions_account ON game_license_sessions (account_id, game_id);

-- Event ids already handled by the game webhook (its own endpoint and signing secret).
CREATE TABLE game_webhook_events (
  event_id TEXT PRIMARY KEY CHECK (event_id GLOB 'evt_*'),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  received_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('applied', 'ignored'))
);

-- Rolling per-account / per-network counters for game routes.
CREATE TABLE game_rate_limits (
  bucket TEXT NOT NULL CHECK (length(bucket) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK (action IN ('device_start', 'device_poll', 'device_approve', 'license_refresh', 'checkout', 'download')),
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 100000),
  PRIMARY KEY (bucket, action)
);
CREATE INDEX game_rate_limits_expiry ON game_rate_limits (window_started_at);
