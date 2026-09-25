-- KalCode schema v4: permissions (campaign Z4). Owner: crates/permissions.
-- Append-only. Never edit after release; add a new numbered migration instead.
-- No foreign keys into workspaces (v2) or threads (v3): thread and workspace ids are validated
-- by the permissions crate, and approval history must outlive a removed workspace or thread.

-- Custom permission profiles saved by the user. Built-in profiles live in code.
CREATE TABLE permission_profiles (
  id         TEXT PRIMARY KEY NOT NULL,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  base_mode  TEXT NOT NULL CHECK (base_mode IN ('plan', 'approve', 'auto', 'bypass', 'custom')),
  rules      TEXT NOT NULL CHECK (json_valid(rules)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Permission preferences (default mode for new threads, …) as JSON values.
CREATE TABLE permission_settings (
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
) STRICT;

-- Approval requests. Only requests the policy answered with "ask" are stored.
-- `origin_kind` says who asked (the Trust Kernel's `ActionOrigin`, docs/CONTRACTS_ADVANCED.md §2):
-- today every request comes from a provider session in a thread; KalVoice, automations,
-- Environment Doctor repairs and other origins arrive later and may have no thread.
CREATE TABLE approvals (
  id                TEXT PRIMARY KEY NOT NULL,
  origin_kind       TEXT NOT NULL CHECK (origin_kind IN (
                      'user', 'system', 'thread', 'kalvoice', 'agent', 'delegation', 'automation',
                      'doctor', 'continuity', 'utility', 'remote')),
  origin_id         TEXT,
  thread_id         TEXT,
  workspace_id      TEXT NOT NULL,
  provider_id       TEXT NOT NULL,
  action_id         TEXT NOT NULL,
  request           TEXT NOT NULL CHECK (json_valid(request)),   -- NormalizedAction
  decision          TEXT NOT NULL CHECK (json_valid(decision)),  -- PolicyDecision
  allowed_decisions TEXT NOT NULL CHECK (json_valid(allowed_decisions)),
  context           TEXT CHECK (context IS NULL OR json_valid(context)),
  fingerprint       TEXT NOT NULL,
  grant_matcher     TEXT,
  grant_coverage    TEXT NOT NULL,
  permission_mode   TEXT NOT NULL CHECK (permission_mode IN ('plan', 'approve', 'auto', 'bypass', 'custom')),
  status            TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  resolved_decision TEXT CHECK (resolved_decision IS NULL OR resolved_decision IN
                      ('deny', 'approve_once', 'approve_for_thread', 'approve_for_workspace', 'allow_via_rule')),
  resolved_at       TEXT,
  resolved_by       TEXT CHECK (resolved_by IS NULL OR resolved_by IN ('user', 'system')),
  -- Why a request expired. `answered_in_provider`: the user answered in the provider's own prompt
  -- (interactive panes), so KalCode's copy of the request no longer applies.
  expire_reason     TEXT CHECK (expire_reason IS NULL OR expire_reason IN (
                      'thread_stopped', 'superseded', 'mode_changed', 'process_restarted',
                      'answered_in_provider')),
  created_at        TEXT NOT NULL,
  CHECK (origin_kind <> 'thread' OR thread_id IS NOT NULL),
  -- Defense in depth: an approved request must have been an approvable "ask", with an
  -- approving decision the request allowed; a denied one carries "deny".
  CHECK (json_extract(decision, '$.effect') = 'ask'),
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK (status <> 'approved' OR (
    json_extract(decision, '$.approvable') = 1
    AND resolved_decision IN ('approve_once', 'approve_for_thread', 'approve_for_workspace', 'allow_via_rule')
    AND resolved_by = 'user'
    AND instr(allowed_decisions, '"' || resolved_decision || '"') > 0
  )),
  CHECK (status <> 'denied' OR resolved_decision = 'deny'),
  CHECK (status <> 'expired' OR resolved_decision IS NULL)
) STRICT;

CREATE INDEX approvals_status_idx ON approvals (status, created_at);
CREATE INDEX approvals_thread_idx ON approvals (thread_id, status);
-- At most one pending request per provider action.
CREATE UNIQUE INDEX approvals_pending_action_idx ON approvals (thread_id, action_id) WHERE status = 'pending';

-- A request's content never changes, and a resolved request never changes at all.
CREATE TRIGGER approvals_content_immutable
BEFORE UPDATE OF id, origin_kind, origin_id, thread_id, workspace_id, provider_id, action_id, request,
  decision, allowed_decisions, context, fingerprint, grant_matcher, grant_coverage, permission_mode,
  created_at
ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approval requests are immutable');
END;

CREATE TRIGGER approvals_resolved_immutable
BEFORE UPDATE ON approvals
WHEN OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'resolved approvals are immutable');
END;

CREATE TRIGGER approvals_never_deleted
BEFORE DELETE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are never deleted');
END;

-- Standing grants created by "Approve for thread / workspace" and "Allow via rule".
CREATE TABLE permission_grants (
  id                TEXT PRIMARY KEY NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('thread', 'workspace', 'rule')),
  thread_id         TEXT,
  workspace_id      TEXT,
  scopes            TEXT NOT NULL CHECK (json_valid(scopes) AND json_array_length(scopes) > 0),
  fingerprint       TEXT NOT NULL,
  matcher           TEXT,
  source_request_id TEXT NOT NULL REFERENCES approvals (id),
  created_at        TEXT NOT NULL,
  expires_at_ms     INTEGER,
  revoked_at        TEXT,
  revoke_reason     TEXT,
  CHECK (kind <> 'thread' OR (thread_id IS NOT NULL AND workspace_id IS NOT NULL AND expires_at_ms IS NOT NULL)),
  CHECK (kind <> 'workspace' OR (workspace_id IS NOT NULL AND expires_at_ms IS NOT NULL)),
  CHECK (kind <> 'rule' OR matcher IS NOT NULL),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
) STRICT;

CREATE INDEX permission_grants_thread_idx ON permission_grants (thread_id) WHERE revoked_at IS NULL;
CREATE INDEX permission_grants_workspace_idx ON permission_grants (workspace_id) WHERE revoked_at IS NULL;

-- Grants can only be revoked, once; their content never changes and rows are never deleted.
CREATE TRIGGER permission_grants_content_immutable
BEFORE UPDATE OF id, kind, thread_id, workspace_id, scopes, fingerprint, matcher,
  source_request_id, created_at, expires_at_ms
ON permission_grants
BEGIN
  SELECT RAISE(ABORT, 'grants are immutable');
END;

CREATE TRIGGER permission_grants_revoked_immutable
BEFORE UPDATE ON permission_grants
WHEN OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'revoked grants are immutable');
END;

CREATE TRIGGER permission_grants_never_deleted
BEFORE DELETE ON permission_grants
BEGIN
  SELECT RAISE(ABORT, 'grants are never deleted');
END;

-- Append-only audit trail of consequential permission decisions.
CREATE TABLE permission_audit (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  occurred_at  TEXT NOT NULL,
  -- The Trust Kernel kinds (docs/campaigns/ADVANCED.md §6) are listed up front: SQLite can't
  -- widen a CHECK without rebuilding this append-only table.
  kind         TEXT NOT NULL CHECK (kind IN (
                 'approval.requested', 'approval.approved', 'approval.denied', 'approval.expired',
                 'grant.created', 'grant.revoked', 'permission.mode_changed',
                 'permission.default_mode_changed', 'permission.bypass_enabled',
                 'permission.bypass_refused',
                 'trust.action_blocked', 'trust.ceiling_applied', 'trust.invariant_enforced',
                 'grant.ceiling_clamped')),
  actor        TEXT NOT NULL CHECK (actor IN ('user', 'system', 'agent', 'kalvoice', 'automation')),
  thread_id    TEXT,
  workspace_id TEXT,
  request_id   TEXT,
  detail       TEXT NOT NULL CHECK (json_valid(detail))
) STRICT;

CREATE INDEX permission_audit_thread_idx ON permission_audit (thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX permission_audit_request_idx ON permission_audit (request_id) WHERE request_id IS NOT NULL;

CREATE TRIGGER permission_audit_no_update
BEFORE UPDATE ON permission_audit
BEGIN
  SELECT RAISE(ABORT, 'the permission audit log is append-only');
END;

CREATE TRIGGER permission_audit_no_delete
BEFORE DELETE ON permission_audit
BEGIN
  SELECT RAISE(ABORT, 'the permission audit log is append-only');
END;
