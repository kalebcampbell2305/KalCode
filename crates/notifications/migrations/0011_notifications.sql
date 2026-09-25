-- v11 (Z7-W3): the notification center, shared by every system that notifies
-- (docs/CONTRACTS_ADVANCED.md §9). Adds to the proposed table: `workspace_id` (focusing a thread
-- opens its workspace), `updated_at` (last raise; lists are ordered by it) and `count` (events
-- coalesced into the row). Titles and bodies are short KalCode-written facts, never model prose.
CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('thread_completed', 'thread_failed',
                 'permission_required', 'mission_done', 'provider_disconnected',
                 'recovery_available', 'automation_finished', 'doctor_finding', 'health_changed')),
  severity     TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title        TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  body         TEXT NOT NULL CHECK (length(body) <= 1000),
  entity_kind  TEXT CHECK (entity_kind IS NULL OR entity_kind IN ('thread', 'workspace', 'provider', 'approval')),
  entity_id    TEXT CHECK (entity_id IS NULL OR length(entity_id) BETWEEN 1 AND 128),
  workspace_id TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  read_at      TEXT,
  dismissed_at TEXT,
  count        INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1),
  CHECK ((entity_kind IS NULL) = (entity_id IS NULL))
) STRICT;

CREATE INDEX notifications_recent_idx ON notifications (updated_at DESC, id DESC);
CREATE INDEX notifications_unread_idx ON notifications (updated_at DESC)
  WHERE read_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX notifications_key_idx ON notifications (kind, entity_kind, entity_id);
