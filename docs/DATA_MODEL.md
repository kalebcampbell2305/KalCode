# KalCode Data Model

Status: Z0 schema v1 implemented; later entities defined for planning.

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
| `workspaces` | id, name, root_path (canonical), created_at, last_opened_at, layout JSON | Z1 |
| `terminals` | id, workspace_id FK, shell, cwd, created_at, exited_at, exit_code | Z1 |
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

No IP addresses or user agents are stored.

## 4. Cloud data (API, Cloudflare D1 `kalcode-api`)

Local only until Z13 deploys the API (`apps/api`, docs/BILLING.md). Migrations:
`apps/api/migrations/`. Timestamps are UTC ISO-8601 with milliseconds, so string order is time
order. Most invariants are enforced by the database itself (CHECK constraints, a partial unique
index and triggers), not only by application code.

```sql
-- 0001_entitlements.sql
accounts(
  id TEXT PRIMARY KEY,                       -- server-generated
  email TEXT NOT NULL UNIQUE COLLATE NOCASE, -- verified identity (sign-in verifies before insert)
  email_verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL                   -- Free KalVoice cycle anchor
)
entitlement_grants(                          -- Free = no active grant
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  tier TEXT NOT NULL CHECK (tier IN ('pro','max','owner')),
  source TEXT NOT NULL CHECK (source IN ('billing','grant')),
  granted_by TEXT NOT NULL, reason TEXT NOT NULL, granted_at TEXT NOT NULL,
  expires_at TEXT,                           -- billing: end of paid period (required); owner: always NULL
  revoked_at TEXT, revoked_by TEXT, revoke_reason TEXT,
  CHECK (tier <> 'owner' OR source = 'grant'),       -- owner_requires_operator_grant
  CHECK (tier <> 'owner' OR expires_at IS NULL),     -- owner_never_expires
  CHECK (source <> 'billing' OR expires_at IS NOT NULL)
)
-- UNIQUE (account_id) WHERE tier = 'owner' AND revoked_at IS NULL   one active OWNER per account
-- triggers: identity fields immutable, revocation final, no deletes;
--           every insert / revocation / period change writes audit_log in the same statement
audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  account_id TEXT, details TEXT NOT NULL /* JSON, never secrets */
)                                            -- append-only (UPDATE/DELETE abort)

-- 0002_kalvoice_requests.sql
kalvoice_requests(                           -- one row per counted top-level KalVoice Request
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  client_request_id TEXT NOT NULL,           -- opaque idempotency key, [A-Za-z0-9_-]{8,128}
  recorded_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('online','offline_replay')),
  over_allowance INTEGER NOT NULL DEFAULT 0, -- offline replay that landed beyond the allowance
  UNIQUE (account_id, client_request_id)
)                                            -- append-only; index (account_id, recorded_at)
```

The ledger stores no request text, transcripts, audio, model names or provider output, and never
provider model tokens. Stripe customer/subscription ids arrive with the Z13 billing webhook.
