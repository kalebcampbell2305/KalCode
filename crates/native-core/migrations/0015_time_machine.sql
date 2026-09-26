-- KalCode schema v15: durable Time Machine restore and replay operation authority.
-- Append-only after release. Native-core registers these exact bytes in the canonical sequence.
-- Operations retain only bounded typed metadata; file contents, patches, approval tokens and
-- provider/model output are prohibited by the closed JSON shapes below.

CREATE TABLE restore_operations (
  id                      TEXT PRIMARY KEY NOT NULL,
  schema_version          INTEGER NOT NULL CHECK (schema_version = 1),
  workspace_id            TEXT NOT NULL,
  checkpoint_id           TEXT NOT NULL,
  kind                    TEXT NOT NULL CHECK (kind IN ('files', 'new_branch', 'new_worktree', 'reset_branch')),
  plan_fingerprint        TEXT NOT NULL CHECK (
                            length(plan_fingerprint) = 64 AND
                            plan_fingerprint NOT GLOB '*[^0-9a-f]*'),
  plan_summary            TEXT NOT NULL CHECK (
                            json_valid(plan_summary) AND length(plan_summary) <= 16384),
  approval_binding_digest TEXT NOT NULL CHECK (
                            length(approval_binding_digest) = 64 AND
                            approval_binding_digest NOT GLOB '*[^0-9a-f]*'),
  expires_at              TEXT NOT NULL CHECK (
                            length(expires_at) = 24 AND
                            strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  safety_checkpoint_id    TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('planned', 'running', 'completed', 'failed', 'cancelled')),
  recovery_required       INTEGER NOT NULL DEFAULT 0 CHECK (recovery_required IN (0, 1)),
  planned_at              TEXT NOT NULL CHECK (
                            length(planned_at) = 24 AND
                            strftime('%Y-%m-%dT%H:%M:%fZ', planned_at) IS planned_at),
  started_at              TEXT CHECK (
                            started_at IS NULL OR
                            (length(started_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS started_at)),
  finished_at             TEXT CHECK (
                            finished_at IS NULL OR
                            (length(finished_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', finished_at) IS finished_at)),
  evidence                TEXT CHECK (evidence IS NULL OR (json_valid(evidence) AND length(evidence) <= 16384)),
  error_code              TEXT CHECK (
                            error_code IS NULL OR
                            (length(error_code) BETWEEN 1 AND 64 AND error_code NOT GLOB '*[^a-z0-9_]*')),
  CHECK (safety_checkpoint_id IS NULL OR safety_checkpoint_id <> checkpoint_id),
  CHECK (expires_at > planned_at),
  CHECK (started_at IS NULL OR (started_at >= planned_at AND started_at < expires_at)),
  CHECK (finished_at IS NULL OR finished_at >= coalesce(started_at, planned_at)),
  CHECK (status <> 'planned' OR
         (safety_checkpoint_id IS NULL AND started_at IS NULL AND finished_at IS NULL AND
          evidence IS NULL AND error_code IS NULL AND recovery_required = 0)),
  CHECK (status <> 'running' OR
         (started_at IS NOT NULL AND finished_at IS NULL AND evidence IS NULL AND
          error_code IS NULL AND recovery_required = 0)),
  CHECK (status <> 'completed' OR
         (started_at IS NOT NULL AND finished_at IS NOT NULL AND evidence IS NOT NULL AND
          error_code IS NULL AND recovery_required = 0)),
  CHECK (status NOT IN ('failed', 'cancelled') OR
         (finished_at IS NOT NULL AND evidence IS NOT NULL)),
  CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CHECK (recovery_required = 0 OR status = 'failed'),
  -- Destructive operations may fail/cancel during planning. Once execution starts, the safety
  -- checkpoint is mandatory and permanently bound.
  CHECK (kind NOT IN ('files', 'reset_branch') OR started_at IS NULL OR safety_checkpoint_id IS NOT NULL)
) STRICT;

CREATE INDEX restore_operations_workspace_idx
  ON restore_operations (workspace_id, planned_at DESC, id DESC);
CREATE INDEX restore_operations_running_idx
  ON restore_operations (id) WHERE status = 'running';

CREATE TABLE replay_runs (
  id                      TEXT PRIMARY KEY NOT NULL,
  schema_version          INTEGER NOT NULL CHECK (schema_version = 1),
  workspace_id            TEXT NOT NULL,
  checkpoint_id           TEXT NOT NULL,
  from_seq                INTEGER NOT NULL CHECK (from_seq >= 0),
  to_seq                  INTEGER NOT NULL CHECK (to_seq >= from_seq),
  steps_total             INTEGER NOT NULL CHECK (steps_total >= 0),
  steps_done              INTEGER NOT NULL DEFAULT 0 CHECK (steps_done >= 0 AND steps_done <= steps_total),
  plan_fingerprint        TEXT NOT NULL CHECK (
                            length(plan_fingerprint) = 64 AND
                            plan_fingerprint NOT GLOB '*[^0-9a-f]*'),
  plan_summary            TEXT NOT NULL CHECK (
                            json_valid(plan_summary) AND length(plan_summary) <= 16384),
  approval_binding_digest TEXT NOT NULL CHECK (
                            length(approval_binding_digest) = 64 AND
                            approval_binding_digest NOT GLOB '*[^0-9a-f]*'),
  expires_at              TEXT NOT NULL CHECK (
                            length(expires_at) = 24 AND
                            strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  safety_checkpoint_id    TEXT,
  status                  TEXT NOT NULL CHECK (status IN ('planned', 'running', 'completed', 'stopped', 'failed')),
  recovery_required       INTEGER NOT NULL DEFAULT 0 CHECK (recovery_required IN (0, 1)),
  planned_at              TEXT NOT NULL CHECK (
                            length(planned_at) = 24 AND
                            strftime('%Y-%m-%dT%H:%M:%fZ', planned_at) IS planned_at),
  started_at              TEXT CHECK (
                            started_at IS NULL OR
                            (length(started_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS started_at)),
  finished_at             TEXT CHECK (
                            finished_at IS NULL OR
                            (length(finished_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', finished_at) IS finished_at)),
  evidence                TEXT CHECK (evidence IS NULL OR (json_valid(evidence) AND length(evidence) <= 16384)),
  error_code              TEXT CHECK (
                            error_code IS NULL OR
                            (length(error_code) BETWEEN 1 AND 64 AND error_code NOT GLOB '*[^a-z0-9_]*')),
  CHECK (safety_checkpoint_id IS NULL OR safety_checkpoint_id <> checkpoint_id),
  CHECK (expires_at > planned_at),
  CHECK (started_at IS NULL OR (started_at >= planned_at AND started_at < expires_at)),
  CHECK (finished_at IS NULL OR finished_at >= coalesce(started_at, planned_at)),
  CHECK (status <> 'planned' OR
         (steps_done = 0 AND safety_checkpoint_id IS NULL AND started_at IS NULL AND
          finished_at IS NULL AND evidence IS NULL AND error_code IS NULL AND recovery_required = 0)),
  CHECK (status <> 'running' OR
         (safety_checkpoint_id IS NOT NULL AND started_at IS NOT NULL AND finished_at IS NULL AND
          evidence IS NULL AND error_code IS NULL AND recovery_required = 0)),
  CHECK (status <> 'completed' OR
         (steps_done = steps_total AND safety_checkpoint_id IS NOT NULL AND started_at IS NOT NULL AND
          finished_at IS NOT NULL AND evidence IS NOT NULL AND error_code IS NULL AND recovery_required = 0)),
  CHECK (status NOT IN ('stopped', 'failed') OR
         (finished_at IS NOT NULL AND evidence IS NOT NULL)),
  CHECK (status <> 'failed' OR error_code IS NOT NULL),
  CHECK (recovery_required = 0 OR status = 'failed'),
  CHECK (started_at IS NULL OR safety_checkpoint_id IS NOT NULL)
) STRICT;

CREATE INDEX replay_runs_workspace_idx
  ON replay_runs (workspace_id, planned_at DESC, id DESC);
CREATE INDEX replay_runs_running_idx
  ON replay_runs (id) WHERE status = 'running';

-- INSERT OR REPLACE must not erase retained terminal evidence or mint a different authority row.
CREATE TRIGGER restore_operations_no_replace
BEFORE INSERT ON restore_operations
WHEN EXISTS (SELECT 1 FROM restore_operations WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'restore_operation_exists');
END;

CREATE TRIGGER replay_runs_no_replace
BEFORE INSERT ON replay_runs
WHEN EXISTS (SELECT 1 FROM replay_runs WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'replay_run_exists');
END;

CREATE TRIGGER restore_operations_insert_planned_only
BEFORE INSERT ON restore_operations
WHEN NEW.status <> 'planned'
BEGIN
  SELECT RAISE(ABORT, 'restore_must_begin_planned');
END;

CREATE TRIGGER replay_runs_insert_planned_only
BEFORE INSERT ON replay_runs
WHEN NEW.status <> 'planned'
BEGIN
  SELECT RAISE(ABORT, 'replay_must_begin_planned');
END;

-- Checkpoint bindings are live, same-workspace rows at plan/start time. Pruning later does not
-- erase history or invalidate already-retained evidence.
CREATE TRIGGER restore_operations_checkpoint_binding
BEFORE INSERT ON restore_operations
WHEN NOT EXISTS (
  SELECT 1 FROM checkpoints
  WHERE id = NEW.checkpoint_id AND workspace_id = NEW.workspace_id AND pruned_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'restore_checkpoint_unavailable');
END;

CREATE TRIGGER replay_runs_checkpoint_binding
BEFORE INSERT ON replay_runs
WHEN NOT EXISTS (
  SELECT 1 FROM checkpoints
  WHERE id = NEW.checkpoint_id AND workspace_id = NEW.workspace_id AND pruned_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'replay_checkpoint_unavailable');
END;

CREATE TRIGGER restore_operations_safety_binding
BEFORE UPDATE OF safety_checkpoint_id ON restore_operations
WHEN NEW.safety_checkpoint_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM checkpoints
  WHERE id = NEW.safety_checkpoint_id AND workspace_id = NEW.workspace_id AND pruned_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'restore_safety_checkpoint_unavailable');
END;

CREATE TRIGGER replay_runs_safety_binding
BEFORE UPDATE OF safety_checkpoint_id ON replay_runs
WHEN NEW.safety_checkpoint_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM checkpoints
  WHERE id = NEW.safety_checkpoint_id AND workspace_id = NEW.workspace_id AND pruned_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'replay_safety_checkpoint_unavailable');
END;

-- Closed plan metadata. Unknown/duplicate keys, inconsistent totals and free-form payload fields
-- fail before any authority row is created.
CREATE TRIGGER restore_operations_plan_shape
BEFORE INSERT ON restore_operations
WHEN json_type(NEW.plan_summary) IS NOT 'object'
  OR json_type(NEW.plan_summary, '$.schemaVersion') IS NOT 'integer'
  OR json_extract(NEW.plan_summary, '$.schemaVersion') <> 1
  OR json_type(NEW.plan_summary, '$.changesTotal') IS NOT 'integer'
  OR json_type(NEW.plan_summary, '$.overwrite') IS NOT 'integer'
  OR json_type(NEW.plan_summary, '$.create') IS NOT 'integer'
  OR json_type(NEW.plan_summary, '$.delete') IS NOT 'integer'
  OR json_type(NEW.plan_summary, '$.keep') IS NOT 'integer'
  OR json_extract(NEW.plan_summary, '$.changesTotal') < 0
  OR json_extract(NEW.plan_summary, '$.overwrite') < 0
  OR json_extract(NEW.plan_summary, '$.create') < 0
  OR json_extract(NEW.plan_summary, '$.delete') < 0
  OR json_extract(NEW.plan_summary, '$.keep') < 0
  OR json_extract(NEW.plan_summary, '$.changesTotal') <>
     json_extract(NEW.plan_summary, '$.overwrite') + json_extract(NEW.plan_summary, '$.create') +
     json_extract(NEW.plan_summary, '$.delete') + json_extract(NEW.plan_summary, '$.keep')
  OR (json_type(NEW.plan_summary, '$.resetBranch') IS NOT 'true' AND
      json_type(NEW.plan_summary, '$.resetBranch') IS NOT 'false')
  OR (NEW.kind = 'reset_branch') <> (json_extract(NEW.plan_summary, '$.resetBranch') = 1)
  OR EXISTS (
       SELECT 1 FROM json_each(NEW.plan_summary)
       WHERE key NOT IN ('schemaVersion', 'changesTotal', 'overwrite', 'create', 'delete', 'keep', 'resetBranch'))
  OR (SELECT count(*) FROM json_each(NEW.plan_summary)) <> 7
  OR (SELECT count(DISTINCT key) FROM json_each(NEW.plan_summary)) <>
     (SELECT count(*) FROM json_each(NEW.plan_summary))
BEGIN
  SELECT RAISE(ABORT, 'restore_plan_metadata_invalid');
END;

CREATE TRIGGER replay_runs_plan_shape
BEFORE INSERT ON replay_runs
WHEN json_type(NEW.plan_summary) IS NOT 'object'
  OR json_type(NEW.plan_summary, '$.schemaVersion') IS NOT 'integer'
  OR json_extract(NEW.plan_summary, '$.schemaVersion') <> 1
  OR json_type(NEW.plan_summary, '$.stepsTotal') IS NOT 'integer'
  OR json_type(NEW.plan_summary, '$.replayable') IS NOT 'integer'
  OR json_type(NEW.plan_summary, '$.notReplayable') IS NOT 'integer'
  OR json_extract(NEW.plan_summary, '$.stepsTotal') < 0
  OR json_extract(NEW.plan_summary, '$.replayable') < 0
  OR json_extract(NEW.plan_summary, '$.notReplayable') < 0
  OR json_extract(NEW.plan_summary, '$.stepsTotal') <> NEW.steps_total
  OR json_extract(NEW.plan_summary, '$.stepsTotal') <>
     json_extract(NEW.plan_summary, '$.replayable') + json_extract(NEW.plan_summary, '$.notReplayable')
  OR EXISTS (
       SELECT 1 FROM json_each(NEW.plan_summary)
       WHERE key NOT IN ('schemaVersion', 'stepsTotal', 'replayable', 'notReplayable'))
  OR (SELECT count(*) FROM json_each(NEW.plan_summary)) <> 4
  OR (SELECT count(DISTINCT key) FROM json_each(NEW.plan_summary)) <>
     (SELECT count(*) FROM json_each(NEW.plan_summary))
BEGIN
  SELECT RAISE(ABORT, 'replay_plan_metadata_invalid');
END;

-- Immutable authority, including TTL. Safety can only be bound once, while atomically claiming
-- a planned operation. A terminal record and its failure evidence can never be overwritten.
CREATE TRIGGER restore_operations_immutable_authority
BEFORE UPDATE ON restore_operations
WHEN NEW.id IS NOT OLD.id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.checkpoint_id IS NOT OLD.checkpoint_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.plan_fingerprint IS NOT OLD.plan_fingerprint
  OR NEW.plan_summary IS NOT OLD.plan_summary
  OR NEW.approval_binding_digest IS NOT OLD.approval_binding_digest
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.planned_at IS NOT OLD.planned_at
  OR (NEW.started_at IS NOT OLD.started_at AND NOT (
        OLD.status = 'planned' AND NEW.status = 'running' AND
        OLD.started_at IS NULL AND NEW.started_at IS NOT NULL))
  OR (NEW.safety_checkpoint_id IS NOT OLD.safety_checkpoint_id AND NOT (
        OLD.status = 'planned' AND NEW.status = 'running' AND
        OLD.safety_checkpoint_id IS NULL AND NEW.safety_checkpoint_id IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'restore_authority_immutable');
END;

CREATE TRIGGER replay_runs_immutable_authority
BEFORE UPDATE ON replay_runs
WHEN NEW.id IS NOT OLD.id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.checkpoint_id IS NOT OLD.checkpoint_id
  OR NEW.from_seq IS NOT OLD.from_seq
  OR NEW.to_seq IS NOT OLD.to_seq
  OR NEW.steps_total IS NOT OLD.steps_total
  OR NEW.plan_fingerprint IS NOT OLD.plan_fingerprint
  OR NEW.plan_summary IS NOT OLD.plan_summary
  OR NEW.approval_binding_digest IS NOT OLD.approval_binding_digest
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.planned_at IS NOT OLD.planned_at
  OR (NEW.started_at IS NOT OLD.started_at AND NOT (
        OLD.status = 'planned' AND NEW.status = 'running' AND
        OLD.started_at IS NULL AND NEW.started_at IS NOT NULL))
  OR (NEW.safety_checkpoint_id IS NOT OLD.safety_checkpoint_id AND NOT (
        OLD.status = 'planned' AND NEW.status = 'running' AND
        OLD.safety_checkpoint_id IS NULL AND NEW.safety_checkpoint_id IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'replay_authority_immutable');
END;

CREATE TRIGGER restore_operations_terminal_immutable
BEFORE UPDATE ON restore_operations
WHEN OLD.status IN ('completed', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'restore_terminal_immutable');
END;

CREATE TRIGGER replay_runs_terminal_immutable
BEFORE UPDATE ON replay_runs
WHEN OLD.status IN ('completed', 'failed', 'stopped')
BEGIN
  SELECT RAISE(ABORT, 'replay_terminal_immutable');
END;

CREATE TRIGGER restore_operations_valid_transition
BEFORE UPDATE OF status ON restore_operations
WHEN NOT (
  (OLD.status = 'planned' AND NEW.status IN ('running', 'failed', 'cancelled')) OR
  (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'cancelled')))
BEGIN
  SELECT RAISE(ABORT, 'restore_transition_invalid');
END;

CREATE TRIGGER replay_runs_valid_transition
BEFORE UPDATE OF status ON replay_runs
WHEN NOT (
  (OLD.status = 'planned' AND NEW.status IN ('running', 'failed', 'stopped')) OR
  (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'stopped')))
BEGIN
  SELECT RAISE(ABORT, 'replay_transition_invalid');
END;

CREATE TRIGGER restore_operations_start_before_expiry
BEFORE UPDATE OF status ON restore_operations
WHEN NEW.status = 'running' AND
     (NEW.started_at IS NULL OR NEW.started_at >= NEW.expires_at OR NEW.started_at < NEW.planned_at)
BEGIN
  SELECT RAISE(ABORT, 'restore_plan_expired');
END;

CREATE TRIGGER replay_runs_start_before_expiry
BEFORE UPDATE OF status ON replay_runs
WHEN NEW.status = 'running' AND
     (NEW.started_at IS NULL OR NEW.started_at >= NEW.expires_at OR NEW.started_at < NEW.planned_at)
BEGIN
  SELECT RAISE(ABORT, 'replay_plan_expired');
END;

CREATE TRIGGER restore_operations_target_live_at_start
BEFORE UPDATE OF status ON restore_operations
WHEN NEW.status = 'running' AND NOT EXISTS (
  SELECT 1 FROM checkpoints
  WHERE id = NEW.checkpoint_id AND workspace_id = NEW.workspace_id AND pruned_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'restore_checkpoint_unavailable');
END;

CREATE TRIGGER replay_runs_target_live_at_start
BEFORE UPDATE OF status ON replay_runs
WHEN NEW.status = 'running' AND NOT EXISTS (
  SELECT 1 FROM checkpoints
  WHERE id = NEW.checkpoint_id AND workspace_id = NEW.workspace_id AND pruned_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'replay_checkpoint_unavailable');
END;

CREATE TRIGGER replay_runs_progress_monotonic
BEFORE UPDATE OF steps_done ON replay_runs
WHEN NEW.steps_done < OLD.steps_done OR NEW.steps_done > NEW.steps_total OR
     (NEW.steps_done <> OLD.steps_done AND OLD.status <> 'running')
BEGIN
  SELECT RAISE(ABORT, 'replay_progress_invalid');
END;

-- Closed terminal evidence shape. References are ids; there is no message/content field.
CREATE TRIGGER restore_operations_evidence_shape
BEFORE UPDATE OF evidence ON restore_operations
WHEN NEW.evidence IS NOT NULL AND (
  json_type(NEW.evidence) IS NOT 'object'
  OR json_type(NEW.evidence, '$.schemaVersion') IS NOT 'integer'
  OR json_extract(NEW.evidence, '$.schemaVersion') <> 1
  OR json_type(NEW.evidence, '$.outcome') IS NOT 'text'
  OR json_extract(NEW.evidence, '$.outcome') NOT IN ('completed', 'failed', 'cancelled', 'restart_interrupted')
  OR json_type(NEW.evidence, '$.stage') IS NOT 'text'
  OR json_extract(NEW.evidence, '$.stage') NOT IN ('planned', 'safety_checkpoint', 'execution', 'verification', 'recovery')
  OR json_type(NEW.evidence, '$.effects') IS NOT 'text'
  OR json_extract(NEW.evidence, '$.effects') NOT IN ('none', 'partial', 'complete', 'unknown')
  OR json_type(NEW.evidence, '$.affectedItems') IS NOT 'integer'
  OR json_extract(NEW.evidence, '$.affectedItems') < 0
  OR (json_type(NEW.evidence, '$.resultRef') IS NOT NULL AND
      (json_type(NEW.evidence, '$.resultRef') IS NOT 'text' OR length(json_extract(NEW.evidence, '$.resultRef')) > 36))
  OR (json_type(NEW.evidence, '$.retainedCheckpointId') IS NOT NULL AND
      (json_type(NEW.evidence, '$.retainedCheckpointId') IS NOT 'text' OR length(json_extract(NEW.evidence, '$.retainedCheckpointId')) > 36))
  OR EXISTS (
       SELECT 1 FROM json_each(NEW.evidence)
       WHERE key NOT IN ('schemaVersion', 'outcome', 'stage', 'effects', 'affectedItems', 'resultRef', 'retainedCheckpointId'))
  OR (SELECT count(*) FROM json_each(NEW.evidence)) <>
     5 + CASE WHEN json_type(NEW.evidence, '$.resultRef') IS NULL THEN 0 ELSE 1 END +
         CASE WHEN json_type(NEW.evidence, '$.retainedCheckpointId') IS NULL THEN 0 ELSE 1 END
  OR (SELECT count(DISTINCT key) FROM json_each(NEW.evidence)) <>
     (SELECT count(*) FROM json_each(NEW.evidence))
  OR (NEW.status = 'completed' AND json_extract(NEW.evidence, '$.outcome') <> 'completed')
  OR (NEW.status = 'failed' AND json_extract(NEW.evidence, '$.outcome') NOT IN ('failed', 'restart_interrupted'))
  OR (NEW.status = 'cancelled' AND json_extract(NEW.evidence, '$.outcome') <> 'cancelled'))
BEGIN
  SELECT RAISE(ABORT, 'restore_evidence_invalid');
END;

CREATE TRIGGER replay_runs_evidence_shape
BEFORE UPDATE OF evidence ON replay_runs
WHEN NEW.evidence IS NOT NULL AND (
  json_type(NEW.evidence) IS NOT 'object'
  OR json_type(NEW.evidence, '$.schemaVersion') IS NOT 'integer'
  OR json_extract(NEW.evidence, '$.schemaVersion') <> 1
  OR json_type(NEW.evidence, '$.outcome') IS NOT 'text'
  OR json_extract(NEW.evidence, '$.outcome') NOT IN ('completed', 'failed', 'stopped', 'restart_interrupted')
  OR json_type(NEW.evidence, '$.stage') IS NOT 'text'
  OR json_extract(NEW.evidence, '$.stage') NOT IN ('planned', 'safety_checkpoint', 'execution', 'verification', 'recovery')
  OR json_type(NEW.evidence, '$.effects') IS NOT 'text'
  OR json_extract(NEW.evidence, '$.effects') NOT IN ('none', 'partial', 'complete', 'unknown')
  OR json_type(NEW.evidence, '$.affectedItems') IS NOT 'integer'
  OR json_extract(NEW.evidence, '$.affectedItems') < 0
  OR (json_type(NEW.evidence, '$.resultRef') IS NOT NULL AND
      (json_type(NEW.evidence, '$.resultRef') IS NOT 'text' OR length(json_extract(NEW.evidence, '$.resultRef')) > 36))
  OR (json_type(NEW.evidence, '$.retainedCheckpointId') IS NOT NULL AND
      (json_type(NEW.evidence, '$.retainedCheckpointId') IS NOT 'text' OR length(json_extract(NEW.evidence, '$.retainedCheckpointId')) > 36))
  OR EXISTS (
       SELECT 1 FROM json_each(NEW.evidence)
       WHERE key NOT IN ('schemaVersion', 'outcome', 'stage', 'effects', 'affectedItems', 'resultRef', 'retainedCheckpointId'))
  OR (SELECT count(*) FROM json_each(NEW.evidence)) <>
     5 + CASE WHEN json_type(NEW.evidence, '$.resultRef') IS NULL THEN 0 ELSE 1 END +
         CASE WHEN json_type(NEW.evidence, '$.retainedCheckpointId') IS NULL THEN 0 ELSE 1 END
  OR (SELECT count(DISTINCT key) FROM json_each(NEW.evidence)) <>
     (SELECT count(*) FROM json_each(NEW.evidence))
  OR (NEW.status = 'completed' AND json_extract(NEW.evidence, '$.outcome') <> 'completed')
  OR (NEW.status = 'failed' AND json_extract(NEW.evidence, '$.outcome') NOT IN ('failed', 'restart_interrupted'))
  OR (NEW.status = 'stopped' AND json_extract(NEW.evidence, '$.outcome') <> 'stopped'))
BEGIN
  SELECT RAISE(ABORT, 'replay_evidence_invalid');
END;

-- Retention is deliberately future-governed. Ordinary code cannot delete authority or evidence.
CREATE TRIGGER restore_operations_no_delete
BEFORE DELETE ON restore_operations
BEGIN
  SELECT RAISE(ABORT, 'restore_retention_governed');
END;

CREATE TRIGGER replay_runs_no_delete
BEFORE DELETE ON replay_runs
BEGIN
  SELECT RAISE(ABORT, 'replay_retention_governed');
END;
