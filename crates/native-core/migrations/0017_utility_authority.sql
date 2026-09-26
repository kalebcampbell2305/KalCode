-- v17 (UD authority): durable, at-most-once claims for sealed Utility Dock effects.
-- The exact sensitive request body or SQL statement stays only in the authenticated runtime's
-- bounded in-memory operation map. This table records the immutable approval/operation binding
-- before an external effect begins, so a crash or ambiguous result can never replay authority.

CREATE TABLE utility_approval_claims (
  approval_id       TEXT PRIMARY KEY NOT NULL
                    REFERENCES approvals(id) ON DELETE RESTRICT
                    CHECK (length(approval_id) = 36 AND
                           substr(approval_id, 9, 1) = '-' AND
                           substr(approval_id, 14, 1) = '-' AND
                    substr(approval_id, 19, 1) = '-' AND
                    substr(approval_id, 24, 1) = '-' AND
                    length(replace(approval_id, '-', '')) = 32 AND
                    approval_id = lower(approval_id) AND
                           approval_id NOT GLOB '*[^0-9a-f-]*'),
  operation_id      TEXT NOT NULL UNIQUE CHECK (
                    length(operation_id) = 36 AND
                    substr(operation_id, 9, 1) = '-' AND
                    substr(operation_id, 14, 1) = '-' AND
                    substr(operation_id, 19, 1) = '-' AND
                    substr(operation_id, 24, 1) = '-' AND
                    length(replace(operation_id, '-', '')) = 32 AND
                    operation_id = lower(operation_id) AND
                    operation_id NOT GLOB '*[^0-9a-f-]*'),
  runtime_generation INTEGER NOT NULL CHECK (runtime_generation >= 0),
  workspace_id      TEXT,
  tool              TEXT NOT NULL CHECK (tool IN ('api_inspector', 'processes', 'sqlite')),
  effect_kind       TEXT NOT NULL CHECK (effect_kind IN ('http', 'process_signal', 'sqlite_write')),
  claimed_at        TEXT NOT NULL CHECK (
                    length(claimed_at) = 24 AND
                    strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at) IS claimed_at),
  CHECK (workspace_id IS NULL OR (
    length(workspace_id) = 36 AND
    substr(workspace_id, 9, 1) = '-' AND
    substr(workspace_id, 14, 1) = '-' AND
    substr(workspace_id, 19, 1) = '-' AND
    substr(workspace_id, 24, 1) = '-' AND
    length(replace(workspace_id, '-', '')) = 32 AND
    workspace_id = lower(workspace_id) AND
    workspace_id NOT GLOB '*[^0-9a-f-]*'
  )),
  CHECK ((tool = 'api_inspector' AND effect_kind = 'http') OR
         (tool = 'processes' AND effect_kind = 'process_signal') OR
         (tool = 'sqlite' AND effect_kind = 'sqlite_write'))
) STRICT;

CREATE INDEX utility_approval_claims_runtime
  ON utility_approval_claims (runtime_generation, claimed_at DESC);

-- INSERT OR REPLACE cannot erase a retained tombstone, whether it collides by approval or by
-- sealed operation. This trigger is required even when recursive_triggers is disabled.
CREATE TRIGGER utility_approval_claims_no_replace
BEFORE INSERT ON utility_approval_claims
WHEN EXISTS (
  SELECT 1 FROM utility_approval_claims
  WHERE approval_id = NEW.approval_id OR operation_id = NEW.operation_id
)
BEGIN
  SELECT RAISE(ABORT, 'utility_approval_claim_exists');
END;

CREATE TRIGGER utility_approval_claims_immutable
BEFORE UPDATE ON utility_approval_claims
BEGIN
  SELECT RAISE(ABORT, 'utility approval claims are immutable');
END;

CREATE TRIGGER utility_approval_claims_no_delete
BEFORE DELETE ON utility_approval_claims
BEGIN
  SELECT RAISE(ABORT, 'utility approval claims are retained');
END;
