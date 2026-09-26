-- Context delivery is a durable, one-shot state machine. Source content is never stored here.
-- Canonical schema v18. Registered by kalcode-native-core and re-exported by kalcode-context.
-- Append-only: never edit after release; add a later numbered migration instead.

CREATE TABLE context_delivery_attempts (
  package_id        TEXT PRIMARY KEY NOT NULL
                    REFERENCES context_packages (id) ON DELETE RESTRICT
                    CHECK (
                      length(package_id) = 36 AND
                      substr(package_id, 9, 1) = '-' AND
                      substr(package_id, 14, 1) = '-' AND
                      substr(package_id, 19, 1) = '-' AND
                      substr(package_id, 24, 1) = '-' AND
                      length(replace(package_id, '-', '')) = 32 AND
                      package_id = lower(package_id) AND
                      package_id NOT GLOB '*[^0-9a-f-]*'
                    ),
  state             TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'failed_uncertain')),
  target_account_id TEXT CHECK (
                    target_account_id IS NULL OR (
                      length(target_account_id) = 36 AND
                      substr(target_account_id, 9, 1) = '-' AND
                      substr(target_account_id, 14, 1) = '-' AND
                      substr(target_account_id, 19, 1) = '-' AND
                      substr(target_account_id, 24, 1) = '-' AND
                      length(replace(target_account_id, '-', '')) = 32 AND
                      target_account_id = lower(target_account_id) AND
                      target_account_id NOT GLOB '*[^0-9a-f-]*'
                    )),
  claimed_at        TEXT NOT NULL
                    CHECK (
                      length(claimed_at) = 24 AND
                      strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at) IS claimed_at
                    ),
  finished_at       TEXT,
  CHECK (
    (state = 'sending' AND finished_at IS NULL)
    OR
    (state IN ('sent', 'failed_uncertain')
      AND finished_at IS NOT NULL
      AND length(finished_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', finished_at) IS finished_at
      AND finished_at >= claimed_at)
  )
) STRICT;

-- The first state is always sending and a completion time cannot be pre-written.
CREATE TRIGGER context_delivery_insert_sending_only
BEFORE INSERT ON context_delivery_attempts
WHEN NEW.state <> 'sending' OR NEW.finished_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'context delivery must begin in sending');
END;

-- `INSERT OR REPLACE` must not reset an existing one-shot attempt. This explicit existence
-- guard is independent of SQLite recursive-trigger settings.
CREATE TRIGGER context_delivery_no_replace
BEFORE INSERT ON context_delivery_attempts
WHEN EXISTS (
  SELECT 1 FROM context_delivery_attempts WHERE package_id = NEW.package_id
)
BEGIN
  SELECT RAISE(ABORT, 'context delivery replacement is forbidden');
END;

-- Only sending -> sent/failed_uncertain is legal. Identity and claim time are immutable and a
-- final row cannot transition again. Startup recovery uses sending -> failed_uncertain.
CREATE TRIGGER context_delivery_final_transition_only
BEFORE UPDATE ON context_delivery_attempts
WHEN OLD.state <> 'sending'
  OR NEW.state NOT IN ('sent', 'failed_uncertain')
  OR NEW.finished_at IS NULL
  OR length(NEW.finished_at) <> 24
  OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.finished_at) IS NOT NEW.finished_at
  OR NEW.finished_at < OLD.claimed_at
  OR NEW.package_id <> OLD.package_id
  OR NEW.target_account_id IS NOT OLD.target_account_id
  OR NEW.claimed_at <> OLD.claimed_at
BEGIN
  SELECT RAISE(ABORT, 'invalid context delivery transition');
END;

-- Once a delivery claim exists, its preview hash and size are pinned. The package header may
-- only close to the final state proven by the delivery row.
CREATE TRIGGER context_delivery_pins_package
BEFORE UPDATE ON context_packages
WHEN EXISTS (
       SELECT 1 FROM context_delivery_attempts WHERE package_id = OLD.id
     )
 AND (
       NEW.content_sha256 <> OLD.content_sha256
       OR NEW.total_bytes <> OLD.total_bytes
       OR NOT EXISTS (
         SELECT 1
           FROM context_delivery_attempts d
          WHERE d.package_id = OLD.id
            AND ((d.state = 'sent' AND NEW.status = 'sent')
              OR (d.state = 'failed_uncertain' AND NEW.status = 'blocked'))
       )
     )
BEGIN
  SELECT RAISE(ABORT, 'context delivery pins package preview');
END;

-- An ambiguous or interrupted attempt also closes the package header. This runs inside the same
-- statement/transaction as the delivery transition, so durable truth cannot say `previewed`
-- while its one allowed attempt is already final.
CREATE TRIGGER context_delivery_uncertain_blocks_package
AFTER UPDATE OF state ON context_delivery_attempts
WHEN OLD.state = 'sending' AND NEW.state = 'failed_uncertain'
BEGIN
  UPDATE context_packages
     SET status = 'blocked'
   WHERE id = NEW.package_id AND status = 'previewed';
END;

-- Delivery evidence is append-only. Retention must be implemented by a later governed
-- migration rather than deleting an individual authority record.
CREATE TRIGGER context_delivery_no_delete
BEFORE DELETE ON context_delivery_attempts
BEGIN
  SELECT RAISE(ABORT, 'context delivery deletion is forbidden');
END;
