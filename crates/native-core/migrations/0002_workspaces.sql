-- KalCode schema v2: workspaces and terminal tabs.
-- Append-only. Never edit after release; add a new numbered migration instead.

CREATE TABLE workspaces (
  id                 TEXT PRIMARY KEY NOT NULL,
  name               TEXT NOT NULL,
  -- Canonical absolute path of the project folder. One workspace per folder.
  root_path          TEXT NOT NULL UNIQUE,
  created_at         TEXT NOT NULL,
  last_opened_at     TEXT NOT NULL,
  -- The terminal tab shown when the workspace opens (layout state).
  active_terminal_id TEXT
) STRICT;

CREATE INDEX workspaces_last_opened_idx ON workspaces (last_opened_at DESC);

-- One row per terminal tab. Output is never stored; only metadata for restoring tabs.
CREATE TABLE terminals (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  shell_id     TEXT NOT NULL,
  title        TEXT NOT NULL,
  position     INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  ended_at     TEXT,
  exit_code    INTEGER,
  end_reason   TEXT CHECK (end_reason IN ('exited', 'app_closed'))
) STRICT;

CREATE INDEX terminals_workspace_idx ON terminals (workspace_id, position);
