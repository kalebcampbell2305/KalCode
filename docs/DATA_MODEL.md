# KalCode Data Model

Status: schema v2 implemented (Z0 v1 + Z1 workspaces and terminals); later entities defined for
planning.

## 1. Local database (SQLite, `<app-data>/kalcode.db`)

### Implemented — schema version 1 (`0001_foundation.sql`)

```sql
schema_migrations(version INTEGER PK, name TEXT, checksum TEXT, applied_at TEXT)
app_meta(key TEXT PK, value TEXT, updated_at TEXT)           -- install id, first run, last version
settings(key TEXT PK, value TEXT /* JSON */, updated_at TEXT)
events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  workspace_id TEXT, thread_id TEXT, mission_id TEXT, provider_id TEXT, request_id TEXT,
  payload TEXT NOT NULL /* JSON */
)
-- indexes: events(type), events(occurred_at), events(workspace_id), events(thread_id),
--          events(mission_id), events(provider_id)
```

`schema_migrations` is created by the migration runner itself (not by a migration), so the
runner can always determine the current version.

### Implemented — schema version 2 (`0002_workspaces.sql`, Z1)

```sql
workspaces(
  id TEXT PK,                      -- UUIDv7
  name TEXT NOT NULL,              -- folder name
  root_path TEXT NOT NULL UNIQUE,  -- canonical absolute path; one workspace per folder
  created_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL,    -- orders the list
  active_terminal_id TEXT          -- tab in front (layout state)
) -- index: workspaces(last_opened_at DESC)
terminals(
  id TEXT PK,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shell_id TEXT NOT NULL,          -- detected shell id, e.g. "pwsh"
  title TEXT NOT NULL,             -- shell display name
  position INTEGER NOT NULL,       -- tab order
  created_at TEXT NOT NULL,
  started_at TEXT, ended_at TEXT, exit_code INTEGER,
  end_reason TEXT CHECK (end_reason IN ('exited', 'app_closed'))
) -- index: terminals(workspace_id, position)
```

`app_meta.active_workspace_id` holds the active workspace. Terminal output is never stored. A
tab with `started_at` set and `ended_at` null is running; at startup any such tab (left by a
crash) is marked `app_closed`. The v1 to v2 upgrade is tested with v1 data
(`crates/native-core/tests/upgrade_and_persistence.rs`).

### Migration rules

1. Migrations are append-only, numbered, embedded in the binary, and checksummed.
2. Each migration runs in its own transaction; failure rolls back and surfaces a
   `Database/migration_failed` error. The app does not start on a half-migrated database.
3. A backup is taken before migrating any existing database.
4. A database whose version is newer than the app understands is refused
   (`Database/schema_too_new`) — the app never downgrades user data.
5. Editing an applied migration is detected (`Database/migration_checksum_mismatch`).
6. Destructive changes require an explicit, reviewed data-preserving plan. No silent drops.
7. Every migration ships with an upgrade test from the previous version with representative data.

### Settings keys (v1)

| Key | Type | Default |
| --- | --- | --- |
| `appearance.theme` | `"system" \| "light" \| "dark"` | `"system"` |
| `appearance.motion` | `"system" \| "reduced" \| "full"` | `"system"` |
| `appearance.density` | `"comfortable" \| "compact"` | `"comfortable"` |
| `layout.sidebarCollapsed` | `boolean` | `false` |

Unknown keys are ignored on read (forward compatibility); invalid values fall back to defaults
and are logged.

## 2. Planned entities (defined now, created by their campaigns)

| Entity | Key fields | Campaign |
| --- | --- | --- |
| `providers` | id, kind, display_name, detected_version, capabilities JSON, last_ok_at | Z2 |
| `provider_accounts` | id, provider_id FK, label, auth_kind, secret_ref (→ secure store) | Z2 |
| `threads` | id, name, provider_id, account_id, model, workspace_id, cwd, permission_profile_id, status, branch, worktree, created_at, last_activity_at, error JSON | Z3 |
| `thread_messages` | id, thread_id FK, role, content, created_at | Z3 |
| `tool_calls` | id, thread_id FK, tool, input JSON (redacted), status, started_at, finished_at | Z3 |
| `permission_profiles` | id, name, base_mode, rules JSON, builtin | Z4 |
| `approvals` | id, thread_id, scope, request JSON, decision, decided_by, decided_at | Z4 |
| `agents`, `missions`, `mission_tasks`, `verifications`, `skills`, `automations`, `memory_records` | — | Z8–Z11 |

Secrets are **never** stored in SQLite; rows hold an opaque `secret_ref` resolved through the
secure store.

## 3. Cloud data (website, Cloudflare D1 `kalcode-web`)

```sql
early_access(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL,
  source TEXT,          -- page the form was submitted from
  consent_version TEXT NOT NULL
)
```

No IP addresses or user agents are stored. Accounts, subscriptions and entitlements
(PostgreSQL) arrive in Z13 and are documented in `docs/BILLING.md` then.
