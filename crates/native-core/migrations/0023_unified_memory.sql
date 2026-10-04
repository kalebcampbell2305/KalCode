-- Schema v23: local project knowledge belongs to a KalCode account and workspace, never a provider.
CREATE TABLE unified_memory (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  record_json TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX unified_memory_scope ON unified_memory(account_id, workspace_id, pinned DESC, updated_at DESC);
CREATE INDEX unified_memory_fingerprint ON unified_memory(account_id, workspace_id, fingerprint);
CREATE VIRTUAL TABLE unified_memory_fts USING fts5(title, content, category, content='unified_memory', content_rowid='rowid', tokenize='porter unicode61');
CREATE TRIGGER unified_memory_insert AFTER INSERT ON unified_memory BEGIN
  INSERT INTO unified_memory_fts(rowid, title, content, category) VALUES (new.rowid, new.title, new.content, new.category);
END;
CREATE TRIGGER unified_memory_delete AFTER DELETE ON unified_memory BEGIN
  INSERT INTO unified_memory_fts(unified_memory_fts, rowid, title, content, category) VALUES ('delete', old.rowid, old.title, old.content, old.category);
END;
CREATE TRIGGER unified_memory_update AFTER UPDATE OF title, content, category ON unified_memory BEGIN
  INSERT INTO unified_memory_fts(unified_memory_fts, rowid, title, content, category) VALUES ('delete', old.rowid, old.title, old.content, old.category);
  INSERT INTO unified_memory_fts(rowid, title, content, category) VALUES (new.rowid, new.title, new.content, new.category);
END;
-- Removing an automatic memory suppresses rediscovery of that same claim.
CREATE TABLE unified_memory_dismissed (
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(account_id, workspace_id, fingerprint)
) STRICT;
CREATE TABLE unified_memory_settings (
  account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  auto_capture INTEGER NOT NULL DEFAULT 1,
  sharing_enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(account_id, workspace_id)
) STRICT;
