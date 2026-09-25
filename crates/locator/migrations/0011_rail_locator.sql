-- KalCode schema v11 (campaign Z7-W2): workspace rail state and the Session Locator index.
-- Append-only. Never edit after release; add a new numbered migration instead.
--
-- Z1 stays the only writer of `workspaces`. Rail state (pin, group, archive, order, the rail's own
-- display name, collapse, message-text search opt-in) lives here, keyed by workspace id and
-- resolved through Z1's API. `workspace_rail.workspace_id` deliberately has no FOREIGN KEY to
-- `workspaces` (another campaign's table): removing a workspace deletes its rail row through the
-- rail's own API instead.
--
-- The locator index is derived and rebuildable: `locator_entries` holds names and statuses only
-- (already redacted), `locator_fts` is a contentless FTS5 table (no text is stored in it; it can
-- only answer "which rows match"). Message text reaches `body` only for workspaces whose owner
-- turned on message-text search (off by default, ADVANCED.md decision 6). Search queries are
-- never stored anywhere.

CREATE TABLE workspace_groups (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  position    INTEGER NOT NULL,
  collapsed   INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  created_at  TEXT NOT NULL
) STRICT;

CREATE TABLE workspace_rail (
  workspace_id   TEXT PRIMARY KEY NOT NULL,
  -- The name shown in the rail; NULL shows the folder's name. Renaming never touches the folder.
  name           TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 80),
  group_id       TEXT REFERENCES workspace_groups (id) ON DELETE SET NULL,
  pinned_at      TEXT,
  archived_at    TEXT,
  position       INTEGER,
  collapsed      INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  index_messages INTEGER NOT NULL DEFAULT 0 CHECK (index_messages IN (0, 1)),
  updated_at     TEXT NOT NULL
) STRICT;

CREATE INDEX workspace_rail_pinned_idx ON workspace_rail (pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX workspace_rail_group_idx  ON workspace_rail (group_id)  WHERE group_id IS NOT NULL;

CREATE TABLE locator_entries (
  id           INTEGER PRIMARY KEY,
  entity_kind  TEXT NOT NULL CHECK (entity_kind IN (
    'thread', 'workspace', 'remote_workspace', 'terminal', 'provider', 'agent', 'mission', 'task',
    'worktree', 'automation', 'file', 'command', 'activity')),
  entity_id    TEXT NOT NULL,
  workspace_id TEXT,
  provider_id  TEXT,
  title        TEXT NOT NULL,
  subtitle     TEXT,
  status       TEXT,
  updated_at   TEXT NOT NULL,
  -- 1 when opted-in message text is in this entry's FTS row.
  has_body     INTEGER NOT NULL DEFAULT 0 CHECK (has_body IN (0, 1)),
  UNIQUE (entity_kind, entity_id)
) STRICT;

CREATE INDEX locator_entries_recency_idx   ON locator_entries (updated_at DESC);
CREATE INDEX locator_entries_workspace_idx ON locator_entries (workspace_id) WHERE workspace_id IS NOT NULL;

CREATE VIRTUAL TABLE locator_fts USING fts5(
  title, subtitle, body,
  content = '', contentless_delete = 1,
  tokenize = 'trigram remove_diacritics 1'
);
