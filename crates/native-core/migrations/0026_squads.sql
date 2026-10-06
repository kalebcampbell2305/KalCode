-- Durable reusable Squad templates, Recipes, and launch-to-Operation relationships.
-- Operations remain the only authority for queue/run/session execution state.
ALTER TABLE operations ADD COLUMN attention_reason TEXT CHECK (
  attention_reason IS NULL OR length(CAST(attention_reason AS BLOB)) BETWEEN 1 AND 512
);

CREATE TABLE squad_definitions (
  id              TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  name            TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 120),
  goal            TEXT NOT NULL CHECK (length(CAST(goal AS BLOB)) BETWEEN 0 AND 16384),
  definition_json TEXT NOT NULL CHECK (
                    json_valid(definition_json) AND json_type(definition_json) = 'object'
                  ),
  updated_at      TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX squad_definitions_name_idx
  ON squad_definitions (name COLLATE NOCASE);

CREATE TABLE squad_recipes (
  id         TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  name       TEXT NOT NULL COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 120),
  squad_id   TEXT NOT NULL REFERENCES squad_definitions (id) ON DELETE CASCADE,
  goal       TEXT CHECK (goal IS NULL OR length(CAST(goal AS BLOB)) BETWEEN 0 AND 16384),
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX squad_recipes_name_idx ON squad_recipes (name COLLATE NOCASE);

CREATE TABLE squad_launches (
  id                  TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  request_id          TEXT NOT NULL UNIQUE CHECK (length(request_id) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  -- Snapshot identity: deleting or editing a reusable template never rewrites run history.
  squad_id            TEXT NOT NULL CHECK (length(squad_id) = 36),
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  goal                TEXT NOT NULL CHECK (length(CAST(goal AS BLOB)) BETWEEN 0 AND 16384),
  workspace_id        TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_at          TEXT NOT NULL
) STRICT;

CREATE INDEX squad_launches_created_idx ON squad_launches (created_at DESC, id DESC);
CREATE INDEX squad_launches_workspace_idx
  ON squad_launches (workspace_id, created_at DESC, id DESC);

CREATE TABLE squad_launch_members (
  launch_id   TEXT NOT NULL REFERENCES squad_launches (id) ON DELETE CASCADE,
  member_key  TEXT NOT NULL CHECK (length(member_key) BETWEEN 1 AND 64),
  role        TEXT NOT NULL CHECK (length(role) BETWEEN 0 AND 80),
  manager_key TEXT CHECK (manager_key IS NULL OR length(manager_key) BETWEEN 1 AND 64),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations (id),
  owned_paths TEXT NOT NULL CHECK (json_valid(owned_paths) AND json_type(owned_paths) = 'array'),
  worktree    INTEGER NOT NULL CHECK (worktree IN (0, 1)),
  position    INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (launch_id, member_key)
) STRICT, WITHOUT ROWID;

CREATE INDEX squad_launch_members_operation_idx ON squad_launch_members (operation_id);
