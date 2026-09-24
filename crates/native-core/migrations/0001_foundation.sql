-- KalCode schema v1: foundation.
-- Append-only. Never edit after release; add a new numbered migration instead.

CREATE TABLE app_meta (
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE settings (
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL,
  version      INTEGER NOT NULL CHECK (version >= 1),
  occurred_at  TEXT NOT NULL,
  source       TEXT NOT NULL,
  workspace_id TEXT,
  thread_id    TEXT,
  mission_id   TEXT,
  provider_id  TEXT,
  request_id   TEXT,
  payload      TEXT NOT NULL CHECK (json_valid(payload))
) STRICT;

CREATE INDEX events_type_idx         ON events (type);
CREATE INDEX events_occurred_at_idx  ON events (occurred_at);
CREATE INDEX events_workspace_id_idx ON events (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX events_thread_id_idx    ON events (thread_id)    WHERE thread_id IS NOT NULL;
CREATE INDEX events_mission_id_idx   ON events (mission_id)   WHERE mission_id IS NOT NULL;
CREATE INDEX events_provider_id_idx  ON events (provider_id)  WHERE provider_id IS NOT NULL;
