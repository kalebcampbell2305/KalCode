-- v14 (UD): Developer Utility Dock.
-- Scratchpads are per-workspace notes (workspace_id NULL = not tied to a workspace).
-- Saved API Inspector requests never hold sensitive header values: they are dropped natively
-- before the row is written (the request JSON keeps the header name with an empty value).
-- No foreign keys to other campaigns' tables: a scratchpad outlives a removed workspace until
-- the person deletes it.

CREATE TABLE scratchpads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  content TEXT NOT NULL CHECK (length(content) <= 1048576),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX scratchpads_by_workspace ON scratchpads (workspace_id, updated_at DESC);

CREATE TABLE http_saved_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  method TEXT NOT NULL CHECK (method IN ('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS')),
  url TEXT NOT NULL CHECK (length(url) <= 8192),
  request TEXT NOT NULL CHECK (json_valid(request)),
  redactions INTEGER NOT NULL DEFAULT 0 CHECK (redactions >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

