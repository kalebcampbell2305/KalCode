-- Operations is the canonical durable identity for queued work and its resulting run.
-- Queue, Runs, Activity and environment projections read this same state; no command is
-- launched by this schema or by the store that owns it.
CREATE TABLE operations_state (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  revision  INTEGER NOT NULL CHECK (revision >= 0),
  paused    INTEGER NOT NULL CHECK (paused IN (0, 1))
) STRICT;

INSERT INTO operations_state (singleton, revision, paused) VALUES (1, 0, 0);

CREATE TABLE operations (
  id                  TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  -- Forgetting a workspace removes its scoped Operations history, exactly like its terminals;
  -- removing a workspace never deletes project files.
  workspace_id        TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  kind                TEXT NOT NULL CHECK (kind IN (
                        'agent', 'build', 'test', 'script', 'deploy', 'release',
                        'background', 'service'
                      )),
  command             TEXT,
  prompt              TEXT,
  provider_id         TEXT,
  -- Historical selection, deliberately not a foreign key. Account removal cannot silently
  -- retarget pending work; the store validates this id again at claim time and fails closed.
  provider_account_id TEXT,
  model               TEXT,
  effort              TEXT,
  dependencies        TEXT NOT NULL CHECK (json_valid(dependencies) AND json_type(dependencies) = 'array'),
  priority            INTEGER NOT NULL,
  lane                TEXT NOT NULL CHECK (lane IN ('next', 'later')),
  environment         TEXT NOT NULL CHECK (environment IN ('local', 'preview', 'staging', 'production')),
  urls                TEXT NOT NULL CHECK (json_valid(urls) AND json_type(urls) = 'array'),
  env_keys            TEXT NOT NULL CHECK (json_valid(env_keys) AND json_type(env_keys) = 'array'),
  source              TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  status              TEXT NOT NULL CHECK (status IN (
                        'queued', 'starting', 'running', 'paused', 'blocked',
                        'succeeded', 'failed', 'cancelled', 'interrupted'
                      )),
  branch              TEXT,
  version             TEXT,
  account_label       TEXT,
  terminal_id         TEXT,
  thread_id           TEXT,
  created_at          TEXT NOT NULL,
  started_at          TEXT,
  ended_at            TEXT,
  current_action      TEXT,
  outcome             TEXT,
  -- Redacted before persistence and bounded to 512 KiB by OperationsStore::record_output.
  logs                TEXT CHECK (
                        logs IS NULL OR length(CAST(logs AS BLOB)) <= 524288
                      ),
  position            INTEGER NOT NULL CHECK (position >= 0)
) STRICT;

CREATE INDEX operations_queue_idx ON operations (status, lane, position, created_at);
CREATE INDEX operations_workspace_idx ON operations (workspace_id, created_at DESC);
CREATE INDEX operations_terminal_idx ON operations (terminal_id) WHERE terminal_id IS NOT NULL;
CREATE INDEX operations_thread_idx ON operations (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX operations_history_idx ON operations (started_at DESC, id DESC)
  WHERE started_at IS NOT NULL;
CREATE INDEX operations_environment_truth_idx
  ON operations (kind, workspace_id, environment, created_at DESC, id DESC)
  WHERE kind IN ('deploy', 'release')
    AND status IN ('succeeded', 'failed', 'cancelled', 'interrupted');
CREATE INDEX operations_service_truth_idx
  ON operations (workspace_id, name, command, created_at DESC, id DESC)
  WHERE kind = 'service'
    AND status IN ('succeeded', 'failed', 'cancelled', 'interrupted');

CREATE TABLE operation_moments (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  operation_id TEXT NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
  at           TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  message      TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 512)
) STRICT;

CREATE INDEX operation_moments_run_idx ON operation_moments (operation_id, seq);
