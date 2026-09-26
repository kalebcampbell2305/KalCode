-- v16 (DOC): Environment Doctor remembered ignores and the non-replayable fix journal.
-- The journal stores inverse data for exact recovery/undo; it is never exposed over IPC.

CREATE TABLE doctor_ignores (
  finding_code TEXT NOT NULL CHECK (length(finding_code) BETWEEN 1 AND 128),
  scope_kind   TEXT NOT NULL CHECK (scope_kind IN ('global', 'workspace')),
  scope_id     TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 200),
  ignored_at   TEXT NOT NULL,
  PRIMARY KEY (finding_code, scope_kind, scope_id),
  CHECK ((scope_kind = 'global' AND scope_id = '')
      OR (scope_kind = 'workspace' AND length(scope_id) = 36))
) STRICT;

CREATE TABLE doctor_runs (
  id            TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  workspace_id  TEXT,
  status        TEXT NOT NULL CHECK (status IN ('completed', 'cancelled')),
  snapshot      TEXT NOT NULL CHECK (json_valid(snapshot) AND length(snapshot) <= 2000000),
  started_at    TEXT NOT NULL,
  finished_at   TEXT NOT NULL,
  stored_at     TEXT NOT NULL
) STRICT;

CREATE INDEX doctor_runs_latest ON doctor_runs (finished_at DESC, id DESC);

CREATE TABLE doctor_fix_log (
  id               TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  run_id           TEXT NOT NULL CHECK (length(run_id) = 36),
  finding_code     TEXT NOT NULL CHECK (length(finding_code) BETWEEN 1 AND 128),
  finding_version  TEXT NOT NULL CHECK (length(finding_version) = 36),
  fix_code         TEXT NOT NULL CHECK (length(fix_code) BETWEEN 1 AND 64),
  workspace_id     TEXT,
  summary          TEXT NOT NULL CHECK (length(summary) <= 300),
  target_ref       TEXT NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 200),
  status           TEXT NOT NULL CHECK (status IN ('applying', 'applied', 'failed', 'reverting', 'reverted')),
  undo             TEXT NOT NULL CHECK (json_valid(undo) AND length(undo) <= 600000),
  approval_id      TEXT,
  revert_approval_id TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL,
  applied_at       TEXT,
  reverted_at      TEXT,
  UNIQUE (run_id, finding_code, finding_version, fix_code),
  UNIQUE (approval_id),
  UNIQUE (revert_approval_id)
) STRICT;

CREATE INDEX doctor_fix_log_by_time ON doctor_fix_log (created_at DESC);
CREATE INDEX doctor_fix_log_interrupted ON doctor_fix_log (status)
  WHERE status IN ('applying', 'reverting');

-- Approval ids are claimed forever even when an interrupted undo becomes retryable and the log's
-- current revert approval changes. This table is internal and never crosses IPC.
CREATE TABLE doctor_approval_claims (
  approval_id TEXT PRIMARY KEY NOT NULL CHECK (length(approval_id) = 36),
  fix_log_id  TEXT NOT NULL REFERENCES doctor_fix_log(id) ON DELETE RESTRICT,
  phase       TEXT NOT NULL CHECK (phase IN ('apply', 'revert')),
  claimed_at  TEXT NOT NULL
) STRICT;

CREATE INDEX doctor_approval_claims_by_fix ON doctor_approval_claims (fix_log_id, phase);

