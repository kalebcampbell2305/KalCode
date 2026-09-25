-- KalCode schema v7 (campaign Z6a): KalCode-managed Git worktrees and checkpoints.
-- Append-only. Never edit after release; add a new numbered migration instead.
--
-- Checkpoint *objects* live in a self-contained shadow repository per workspace in KalCode's
-- data folder (docs/campaigns/ADVANCED.md §3 D2); these rows are the index over them.
-- `workspace_id` is not a foreign key: workspaces belong to Z1 and are resolved through its API.

CREATE TABLE git_worktrees (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  -- Absolute path chosen natively under KalCode's data folder; never supplied by the WebView.
  path         TEXT NOT NULL UNIQUE,
  branch       TEXT NOT NULL,
  base_commit  TEXT NOT NULL CHECK (length(base_commit) IN (40, 64)),
  purpose      TEXT NOT NULL CHECK (purpose IN ('task', 'thread', 'branch_from_checkpoint', 'user')),
  owner_ref    TEXT,
  status       TEXT NOT NULL CHECK (status IN ('active', 'merged', 'abandoned', 'removed')),
  created_at   TEXT NOT NULL,
  removed_at   TEXT,
  CHECK ((status = 'removed') = (removed_at IS NOT NULL))
) STRICT;

CREATE INDEX git_worktrees_workspace_idx ON git_worktrees (workspace_id, created_at DESC);

CREATE TABLE checkpoints (
  id           TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  commit_oid   TEXT NOT NULL CHECK (length(commit_oid) IN (40, 64)),
  parent_id    TEXT,
  -- CheckpointTrigger as JSON (`{"kind":"user"}`, `{"kind":"thread_turn","threadId":…}`, …).
  trigger      TEXT NOT NULL CHECK (json_valid(trigger)),
  -- Latest event sequence number when the checkpoint was taken (timeline interleaving).
  event_seq    INTEGER NOT NULL CHECK (event_seq >= 0),
  files        INTEGER NOT NULL CHECK (files >= 0),
  bytes_added  INTEGER NOT NULL CHECK (bytes_added >= 0),
  pinned       INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at   TEXT NOT NULL,
  pruned_at    TEXT,
  -- A pinned checkpoint is never pruned.
  CHECK (NOT (pinned = 1 AND pruned_at IS NOT NULL))
) STRICT;

CREATE INDEX checkpoints_workspace_idx ON checkpoints (workspace_id, created_at DESC)
  WHERE pruned_at IS NULL;
