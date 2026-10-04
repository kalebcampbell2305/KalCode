-- Schema v23: admit Cursor without changing existing account IDs, labels or bindings.
-- The migration runner backs up the database and executes this whole file atomically.
-- Keep foreign_keys enabled. Dropping the old parent temporarily nulls thread account links;
-- restore those exact links before commit. No credentials or provider files are touched.

CREATE TEMP TABLE cursor_migration_thread_accounts AS
  SELECT id, provider_account_id FROM threads WHERE provider_account_id IS NOT NULL;
CREATE TEMP TABLE cursor_migration_bindings AS SELECT * FROM provider_account_bindings;

CREATE TABLE provider_accounts_cursor (
  id                         TEXT PRIMARY KEY NOT NULL,
  provider_id                TEXT NOT NULL CHECK (provider_id IN ('claude-code', 'codex', 'gemini-cli', 'cursor')),
  display_name               TEXT COLLATE NOCASE NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  provider_reported_identity TEXT CHECK (
    provider_reported_identity IS NULL OR length(provider_reported_identity) BETWEEN 1 AND 320
  ),
  authentication_state       TEXT NOT NULL CHECK (
    authentication_state IN ('authenticated', 'not_authenticated', 'unknown')
  ),
  is_default                 INTEGER NOT NULL CHECK (is_default IN (0, 1)),
  created_at                 TEXT NOT NULL,
  last_used_at               TEXT,
  last_checked_at            TEXT,
  last_error_code            TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 64),
  archived_at                TEXT,
  UNIQUE (id, provider_id)
) STRICT;

INSERT INTO provider_accounts_cursor SELECT * FROM provider_accounts;
DROP TABLE provider_account_bindings;
DROP TABLE provider_accounts;
ALTER TABLE provider_accounts_cursor RENAME TO provider_accounts;

CREATE UNIQUE INDEX provider_accounts_one_default
  ON provider_accounts (provider_id) WHERE is_default = 1 AND archived_at IS NULL;
CREATE UNIQUE INDEX provider_accounts_active_label
  ON provider_accounts (provider_id, display_name COLLATE NOCASE) WHERE archived_at IS NULL;
CREATE INDEX provider_accounts_provider
  ON provider_accounts (provider_id, created_at, id);

CREATE TABLE provider_account_bindings (
  provider_id TEXT NOT NULL CHECK (provider_id IN ('claude-code', 'codex', 'gemini-cli', 'cursor')),
  kind        TEXT NOT NULL CHECK (kind IN ('workspace', 'agent', 'mission', 'thread', 'provider_profile')),
  scope_id    TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  PRIMARY KEY (provider_id, kind, scope_id),
  FOREIGN KEY (account_id, provider_id)
    REFERENCES provider_accounts (id, provider_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX provider_account_bindings_account
  ON provider_account_bindings (account_id);

INSERT INTO provider_account_bindings SELECT * FROM cursor_migration_bindings;
UPDATE threads SET provider_account_id = (
  SELECT provider_account_id FROM cursor_migration_thread_accounts saved WHERE saved.id = threads.id
) WHERE id IN (SELECT id FROM cursor_migration_thread_accounts);
DROP TABLE cursor_migration_bindings;
DROP TABLE cursor_migration_thread_accounts;

-- Cursor has one native sign-in per OS user; metadata must not simulate isolated accounts.
CREATE UNIQUE INDEX provider_accounts_cursor_singleton
  ON provider_accounts (provider_id) WHERE provider_id = 'cursor' AND archived_at IS NULL;
