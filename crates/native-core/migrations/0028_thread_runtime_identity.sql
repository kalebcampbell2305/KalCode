-- Provider-confirmed identity for the currently running provider session. The existing model and
-- effort columns remain the user's durable launch/resume configuration. NULL is truthful unknown
-- until the provider reports structured runtime metadata for this session.

ALTER TABLE threads ADD COLUMN active_model TEXT CHECK (
  active_model IS NULL OR length(CAST(active_model AS BLOB)) BETWEEN 1 AND 512
);

ALTER TABLE threads ADD COLUMN active_effort TEXT CHECK (
  active_effort IS NULL OR (
    length(active_effort) BETWEEN 1 AND 32
    AND active_effort NOT GLOB '*[^A-Za-z0-9_-]*'
  )
);

-- Runtime identity and execution-history projections are sequence-bounded per thread. The
-- composite index keeps paged history from scanning another thread's event stream.
CREATE INDEX IF NOT EXISTS events_thread_type_seq_idx
  ON events (thread_id, type, seq)
  WHERE thread_id IS NOT NULL;
