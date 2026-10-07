-- Agent Handoff Chains (migration 28): chain-only facts over an ad-hoc Squad launch.
-- Operations remain the only authority for queue/run/session execution state; phases are derived.
CREATE TABLE chains (
  launch_id         TEXT PRIMARY KEY NOT NULL REFERENCES squad_launches (id) ON DELETE CASCADE,
  acceptance        TEXT NOT NULL CHECK (json_valid(acceptance) AND json_type(acceptance) = 'array'),
  worktree          TEXT NOT NULL CHECK (worktree IN ('shared', 'project')),
  -- The Operation id that owns the shared worktree (the root step's first attempt) and its branch.
  worktree_owner_id TEXT CHECK (worktree_owner_id IS NULL OR length(worktree_owner_id) = 36),
  branch            TEXT CHECK (branch IS NULL OR length(branch) BETWEEN 1 AND 255),
  paused            INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  cancelled         INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
  superseded_reason TEXT CHECK (
                      superseded_reason IS NULL
                      OR length(CAST(superseded_reason AS BLOB)) BETWEEN 1 AND 512
                    )
) STRICT;

CREATE TABLE chain_steps (
  launch_id     TEXT NOT NULL REFERENCES chains (launch_id) ON DELETE CASCADE,
  step_key      TEXT NOT NULL CHECK (length(step_key) BETWEEN 1 AND 48),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  intent        TEXT NOT NULL CHECK (intent IN ('implement', 'review', 'fix', 'test', 'continue')),
  instructions  TEXT CHECK (instructions IS NULL OR length(CAST(instructions AS BLOB)) BETWEEN 1 AND 8192),
  depends_on    TEXT NOT NULL CHECK (json_valid(depends_on) AND json_type(depends_on) = 'array'),
  position      INTEGER NOT NULL CHECK (position >= 0),
  -- The current attempt. Earlier attempts stay in chain_step_attempts.
  operation_id  TEXT NOT NULL UNIQUE REFERENCES operations (id),
  attempt       INTEGER NOT NULL CHECK (attempt >= 1),
  skipped       INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0, 1)),
  skip_reason   TEXT CHECK (skip_reason IS NULL OR length(CAST(skip_reason AS BLOB)) BETWEEN 1 AND 512),
  report        TEXT CHECK (report IS NULL OR (json_valid(report) AND json_type(report) = 'object')),
  PRIMARY KEY (launch_id, step_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE chain_step_attempts (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES operations (id),
  launch_id    TEXT NOT NULL,
  step_key     TEXT NOT NULL,
  attempt      INTEGER NOT NULL CHECK (attempt >= 1),
  FOREIGN KEY (launch_id, step_key) REFERENCES chain_steps (launch_id, step_key) ON DELETE CASCADE,
  UNIQUE (launch_id, step_key, attempt)
) STRICT;
