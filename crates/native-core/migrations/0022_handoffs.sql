-- Durable metadata and one-shot delivery authority for real coding-agent handoffs.
-- Prompt text remains process-local in the ContextPackage registry and is never persisted here.

CREATE TABLE handoffs (
  id                  TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  context_package_id  TEXT NOT NULL UNIQUE
                      REFERENCES context_packages (id) ON DELETE CASCADE,
  source_thread_id    TEXT NOT NULL CHECK (length(source_thread_id) = 36),
  target_thread_id    TEXT NOT NULL CHECK (length(target_thread_id) = 36),
  source_workspace_id TEXT NOT NULL CHECK (length(source_workspace_id) = 36),
  target_workspace_id TEXT NOT NULL CHECK (length(target_workspace_id) = 36),
  source_name         TEXT NOT NULL CHECK (length(source_name) BETWEEN 1 AND 200),
  target_name         TEXT NOT NULL CHECK (length(target_name) BETWEEN 1 AND 200),
  task                TEXT NOT NULL CHECK (task IN ('review', 'test', 'fix', 'continue')),
  status              TEXT NOT NULL CHECK (status IN (
                        'queued', 'delivered', 'working', 'needs_you',
                        'completed', 'failed', 'cancelled', 'interrupted'
                      )),
  delivery_state      TEXT NOT NULL CHECK (delivery_state IN (
                        'pending', 'dispatching', 'sent', 'uncertain'
                      )),
  target_instance_id  TEXT NOT NULL CHECK (length(target_instance_id) BETWEEN 1 AND 200),
  preview_hash        TEXT NOT NULL CHECK (
                        length(preview_hash) = 64 AND
                        preview_hash = lower(preview_hash) AND
                        preview_hash NOT GLOB '*[^0-9a-f]*'
                      ),
  source_commit       TEXT,
  source_branch       TEXT,
  source_dirty        INTEGER NOT NULL CHECK (source_dirty IN (0, 1)),
  result              TEXT CHECK (
                        result IS NULL OR length(CAST(result AS BLOB)) BETWEEN 1 AND 32768
                      ),
  blocker             TEXT CHECK (
                        blocker IS NULL OR length(CAST(blocker AS BLOB)) BETWEEN 1 AND 1024
                      ),
  return_of_id        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  delivered_at        TEXT,
  completed_at        TEXT
) STRICT;

CREATE INDEX handoffs_source_idx ON handoffs (source_thread_id, created_at DESC);
CREATE INDEX handoffs_target_idx ON handoffs (target_thread_id, created_at DESC);
CREATE INDEX handoffs_pending_idx ON handoffs (delivery_state, created_at)
  WHERE status = 'queued';

CREATE TRIGGER handoffs_identity_immutable
BEFORE UPDATE ON handoffs
WHEN NEW.id <> OLD.id
  OR NEW.context_package_id <> OLD.context_package_id
  OR NEW.source_thread_id <> OLD.source_thread_id
  OR NEW.target_thread_id <> OLD.target_thread_id
  OR NEW.source_workspace_id <> OLD.source_workspace_id
  OR NEW.target_workspace_id <> OLD.target_workspace_id
  OR NEW.source_name <> OLD.source_name
  OR NEW.target_name <> OLD.target_name
  OR NEW.task <> OLD.task
  OR NEW.target_instance_id <> OLD.target_instance_id
  OR NEW.preview_hash <> OLD.preview_hash
  OR NEW.source_commit IS NOT OLD.source_commit
  OR NEW.source_branch IS NOT OLD.source_branch
  OR NEW.source_dirty <> OLD.source_dirty
  OR NEW.return_of_id IS NOT OLD.return_of_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'handoff identity is immutable');
END;

CREATE TRIGGER handoffs_status_transition
BEFORE UPDATE OF status ON handoffs
WHEN NEW.status <> OLD.status AND NOT (
     (OLD.status = 'queued' AND NEW.status IN ('delivered', 'cancelled', 'interrupted'))
  OR (OLD.status = 'delivered' AND NEW.status IN (
        'working', 'needs_you', 'completed', 'failed', 'cancelled', 'interrupted'
      ))
  OR (OLD.status = 'working' AND NEW.status IN (
        'needs_you', 'completed', 'failed', 'cancelled', 'interrupted'
      ))
  OR (OLD.status = 'needs_you' AND NEW.status IN (
        'working', 'completed', 'failed', 'cancelled', 'interrupted'
      ))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid handoff status transition');
END;

CREATE TRIGGER handoffs_delivery_transition
BEFORE UPDATE OF delivery_state ON handoffs
WHEN NEW.delivery_state <> OLD.delivery_state AND NOT (
     (OLD.delivery_state = 'pending' AND NEW.delivery_state = 'dispatching')
  OR (OLD.delivery_state = 'dispatching' AND NEW.delivery_state IN ('sent', 'uncertain'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid handoff delivery transition');
END;

CREATE TRIGGER handoffs_terminal_shape
BEFORE UPDATE ON handoffs
WHEN (NEW.status IN ('completed', 'failed') AND (
        NEW.result IS NULL OR NEW.completed_at IS NULL
      ))
   OR (NEW.status IN ('cancelled', 'interrupted') AND NEW.completed_at IS NULL)
   OR (NEW.status NOT IN ('completed', 'failed') AND NEW.result IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid handoff terminal state');
END;
