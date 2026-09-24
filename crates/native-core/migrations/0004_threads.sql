-- KalCode schema: threads (campaign Z3; migration number 0004 is reserved for Z3).
-- Append-only. Never edit after release; add a new numbered migration instead.
--
-- `threads.workspace_id` identifies a row of `workspaces` (Z1, migration 0002). It is stored
-- without a FOREIGN KEY clause so this migration does not depend on 0002's table at apply
-- time; the thread runtime resolves every workspace through Z1's API before use. See
-- docs/AGENT_RUNTIME.md §Persistence for the integration plan for the constraint.
--
-- Nothing here stores credentials: provider accounts are referenced by label only, and the
-- session's secret reference (if any) is never persisted.

CREATE TABLE threads (
  id                  TEXT PRIMARY KEY NOT NULL,
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  provider_id         TEXT NOT NULL,
  provider_name       TEXT NOT NULL,
  model               TEXT,
  account_label       TEXT,
  workspace_id        TEXT NOT NULL,
  workspace_name      TEXT NOT NULL,
  cwd                 TEXT NOT NULL,
  permission_mode     TEXT NOT NULL
    CHECK (permission_mode IN ('plan', 'approve', 'auto', 'bypass', 'custom')),
  status              TEXT NOT NULL CHECK (status IN (
    'starting', 'active', 'thinking', 'running_tool', 'running_command', 'editing', 'testing',
    'reviewing', 'idle', 'waiting_for_permission', 'waiting_for_user', 'waiting_for_dependency',
    'paused', 'completed', 'failed', 'interrupted', 'recovering', 'offline')),
  current_activity    TEXT,
  provider_session_id TEXT,
  created_at          TEXT NOT NULL,
  last_activity_at    TEXT NOT NULL,
  -- Highest thread_messages.seq the user has seen (drives ThreadSummary.unreadMessages).
  last_read_seq       INTEGER NOT NULL DEFAULT 0,
  -- Approval requests the thread is waiting on. Live-session state: reset by crash recovery.
  pending_approvals   INTEGER NOT NULL DEFAULT 0 CHECK (pending_approvals >= 0),
  archived_at         TEXT,
  error_code          TEXT,
  error_message       TEXT,
  input_tokens        INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd_micros     INTEGER NOT NULL DEFAULT 0 CHECK (cost_usd_micros >= 0)
) STRICT;

CREATE INDEX threads_workspace_id_idx     ON threads (workspace_id);
CREATE INDEX threads_last_activity_at_idx ON threads (last_activity_at);
CREATE INDEX threads_open_status_idx      ON threads (status) WHERE archived_at IS NULL;

CREATE TABLE thread_messages (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  id                  TEXT NOT NULL UNIQUE,
  thread_id           TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  role                TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content             TEXT NOT NULL,
  provider_message_id TEXT,
  created_at          TEXT NOT NULL
) STRICT;

CREATE INDEX thread_messages_thread_idx ON thread_messages (thread_id, seq);

CREATE TABLE tool_calls (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT NOT NULL UNIQUE,
  thread_id        TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  provider_call_id TEXT NOT NULL,
  tool             TEXT NOT NULL,
  summary          TEXT NOT NULL,
  status           TEXT NOT NULL
    CHECK (status IN ('requested', 'running', 'completed', 'failed', 'cancelled')),
  result_summary   TEXT,
  requested_at     TEXT NOT NULL,
  started_at       TEXT,
  completed_at     TEXT
) STRICT;

CREATE INDEX tool_calls_thread_idx   ON tool_calls (thread_id, seq);
CREATE INDEX tool_calls_provider_idx ON tool_calls (thread_id, provider_call_id);

-- Distinct files a thread changed (drives ThreadSummary.filesChanged). Paths are
-- workspace-relative where possible; file contents are never stored.
CREATE TABLE thread_files (
  thread_id  TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  change     TEXT NOT NULL CHECK (change IN ('created', 'modified', 'deleted')),
  changed_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, path)
) STRICT;
