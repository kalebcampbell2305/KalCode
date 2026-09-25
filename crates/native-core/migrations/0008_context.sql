-- KalCode schema v8: context packages and the Context Firewall (CTX/FW, ADVANCED.md §5.2).
-- Append-only. Never edit after release; add a new numbered migration instead.
-- References only: item content is never stored. It is re-read and re-hashed at send time.
-- No foreign keys to tables owned by other systems (workspaces, threads, missions): those ids
-- are resolved through their owners' APIs.

CREATE TABLE context_packages (
  id                 TEXT PRIMARY KEY NOT NULL,
  workspace_id       TEXT,
  purpose            TEXT NOT NULL CHECK (purpose IN
                       ('drop','handoff','memory','automation','delegation','reasoning')),
  target_thread_id   TEXT,
  target_provider_id TEXT,
  status             TEXT NOT NULL CHECK (status IN ('previewed','sent','discarded','blocked')),
  content_sha256     TEXT NOT NULL CHECK (length(content_sha256) = 64),
  total_bytes        INTEGER NOT NULL CHECK (total_bytes >= 0),
  created_at         TEXT NOT NULL,
  sent_at            TEXT
) STRICT;

CREATE INDEX context_packages_workspace_idx
  ON context_packages (workspace_id, created_at DESC) WHERE workspace_id IS NOT NULL;

-- A package leaves 'previewed' once, and a finished package never changes again.
CREATE TRIGGER context_packages_final_status
BEFORE UPDATE ON context_packages
WHEN OLD.status <> 'previewed'
BEGIN
  SELECT RAISE(ABORT, 'finished context packages are immutable');
END;

CREATE TRIGGER context_packages_identity_immutable
BEFORE UPDATE OF id, workspace_id, purpose, target_thread_id, target_provider_id, created_at
ON context_packages
BEGIN
  SELECT RAISE(ABORT, 'context package identity is immutable');
END;

CREATE TABLE context_items (
  package_id  TEXT NOT NULL REFERENCES context_packages (id) ON DELETE CASCADE,
  position    INTEGER NOT NULL CHECK (position >= 0),
  -- {kind, path?, lines?, label, contentSha256, bytes}: a reference, never the content.
  source      TEXT NOT NULL CHECK (json_valid(source)),
  bytes       INTEGER NOT NULL CHECK (bytes >= 0),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public','internal','confidential','secret')),
  verdict     TEXT NOT NULL CHECK (verdict IN ('allow','redact','block')),
  redactions  INTEGER NOT NULL DEFAULT 0 CHECK (redactions >= 0),
  included    INTEGER NOT NULL CHECK (included IN (0,1)),
  PRIMARY KEY (package_id, position)
) STRICT;

-- Append-only decision log (FW-03): no UPDATE, no DELETE — not even by KalCode.
CREATE TABLE context_firewall_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  package_id  TEXT NOT NULL,
  position    INTEGER,
  rule        TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('blocked','redacted','overridden_by_user','warned')),
  detail      TEXT NOT NULL CHECK (json_valid(detail))
) STRICT;

CREATE INDEX context_firewall_log_package_idx ON context_firewall_log (package_id, seq);

CREATE TRIGGER context_firewall_log_no_update
BEFORE UPDATE ON context_firewall_log
BEGIN
  SELECT RAISE(ABORT, 'the context firewall log is append-only');
END;

CREATE TRIGGER context_firewall_log_no_delete
BEFORE DELETE ON context_firewall_log
BEGIN
  SELECT RAISE(ABORT, 'the context firewall log is append-only');
END;

CREATE TABLE context_never_share (
  scope_id    TEXT NOT NULL DEFAULT '',  -- '' = all workspaces, else a workspace id
  pattern     TEXT NOT NULL CHECK (length(pattern) BETWEEN 1 AND 256),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('confidential','secret')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (scope_id, pattern)
) STRICT;
