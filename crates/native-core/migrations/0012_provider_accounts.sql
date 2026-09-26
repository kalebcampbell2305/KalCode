-- KalCode schema v12: credential-free provider account metadata and scoped account bindings.
-- Provider authentication material remains in provider-native managed profiles or the OS secure
-- store. Removing these rows never removes a profile, auth file, provider installation, or key.

CREATE TABLE provider_accounts (
  id                         TEXT PRIMARY KEY NOT NULL,
  provider_id                TEXT NOT NULL CHECK (provider_id IN ('claude-code', 'codex', 'gemini-cli')),
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

CREATE UNIQUE INDEX provider_accounts_one_default
  ON provider_accounts (provider_id) WHERE is_default = 1 AND archived_at IS NULL;
CREATE UNIQUE INDEX provider_accounts_active_label
  ON provider_accounts (provider_id, display_name COLLATE NOCASE) WHERE archived_at IS NULL;
CREATE INDEX provider_accounts_provider
  ON provider_accounts (provider_id, created_at, id);

CREATE TABLE provider_account_bindings (
  provider_id TEXT NOT NULL CHECK (provider_id IN ('claude-code', 'codex', 'gemini-cli')),
  kind        TEXT NOT NULL CHECK (kind IN ('workspace', 'agent', 'mission', 'thread', 'provider_profile')),
  scope_id    TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  PRIMARY KEY (provider_id, kind, scope_id),
  FOREIGN KEY (account_id, provider_id)
    REFERENCES provider_accounts (id, provider_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX provider_account_bindings_account
  ON provider_account_bindings (account_id);

-- Legacy account_label remains as the historical display snapshot. The stable account id is the
-- authority for new/resumed execution. NULL legacy rows must be resolved before provider launch.
ALTER TABLE threads ADD COLUMN provider_account_id TEXT
  REFERENCES provider_accounts (id) ON DELETE SET NULL;
CREATE INDEX threads_provider_account_idx
  ON threads (provider_account_id) WHERE provider_account_id IS NOT NULL;
