# Shared contracts (v1)

Owner: the lead / integrator. Campaigns **consume** these; they never redefine them. Changes are
additive within v1 and go through the lead (open a note in your hand-off; do not edit
`crates/contracts` from a campaign branch).

## Where contracts live

| Contract | Rust (source of truth) | TypeScript |
| --- | --- | --- |
| IDs (UUIDv7 strings, `new_id`, `is_valid_id`) | `crates/contracts/src/ids.rs` | `string` |
| Event catalog (`EventPayload`, envelope, correlation) | `crates/contracts/src/events.rs` | generated |
| Thread states, `ThreadSummary`, `ThreadMessage` | `crates/contracts/src/threads.rs` | generated |
| Provider contract (`ProviderId`, `AgentEvent`, `SessionConfig`, capabilities, detection, `AgentProvider` / `AgentSession` / `AgentEventSink` traits) | `crates/contracts/src/agent.rs` | generated types |
| Permissions (`PermissionMode`, `PermissionScope`, rules, profiles, `NormalizedAction`, `PolicyDecision`, `ApprovalRequest`, `ApprovalDecision`, `PermissionGate` trait) | `crates/contracts/src/permissions.rs` | generated types |
| Plans and prices | — | `packages/protocol/src/plans.ts` |

TypeScript is generated with ts-rs into `packages/protocol/src/generated` (`pnpm gen:protocol`).
`native-core` re-exports the event types (`kalcode_core::events::*`) and stores/delivers them.

## Dependency seams

```text
Z2 providers ──implements──▶ AgentProvider / AgentSession ◀──drives── Z3 thread runtime
                                                                   │
Z2 adapters emit AgentEvent (incl. ApprovalRequired{NormalizedAction})│
                                                                   ▼
Z4 engine ──implements──▶ PermissionGate ◀──────────────calls───── Z3
Z4 emits approval.* events ──event bus──▶ Z3 forwards decisions to the session
Z5 Dashboard reads ThreadSummary / ApprovalRequest / events (fixtures until Z3/Z4 land)
```

- Z3 may develop against `AskUnlessReadGate` (contracts) and a fake `AgentProvider` until Z2's
  Claude Code adapter and Z4's engine merge.
- Z5 builds the production Dashboard UI against typed fixtures of these exact types
  (`ThreadSummary`, `ApprovalRequest`, `EventEnvelope`) and swaps to live IPC as Z3/Z4 land.

## Persistence boundaries (SQLite migrations)

Schema versions are contiguous; a migration's number is its schema version and is fixed once
merged (files are checksummed, see `docs/DATA_MODEL.md`).

| Migration (schema version) | Owner | Tables | Status |
| --- | --- | --- | --- |
| `0001` (v1) | Z0 | `app_meta`, `settings`, `events` | merged |
| `0002` (v2) | Z1 | `workspaces`, `terminals` | merged (wave 2) |
| `0003` (v3) | Z3 | `threads`, `thread_messages`, `tool_calls`, `thread_files` | merged (wave 2) |
| `0004` (v4) | Z4 | `permission_profiles`, `permission_settings`, `approvals` (with `origin_kind` / `origin_id`; `thread_id`, `workspace_id`, `provider_id` required for thread origins, optional for others), `permission_grants`, `permission_audit` (kinds include the Trust Kernel's `trust.*` / `grant.ceiling_clamped`) | merged (wave 2) |
| `0005` (v5) | — | reserved: the next campaign that needs storage takes it | free |

Z2 shipped no migration (provider state is detected, never stored). `threads.permission_profile_id`
(v3) holds a Custom thread's profile; only the permission engine writes it. Numbers are assigned at
integration in merge order; a campaign branch registers its migration after the last merged one.

A table has exactly one owning campaign. Others read it through that campaign's Rust API, not
with their own SQL.

## IPC surfaces (names and shapes are fixed here)

| Command | Owner | Input | Output |
| --- | --- | --- | --- |
| `workspace_list` / `workspace_active` / `workspace_open_dialog` / `workspace_activate` / `workspace_remove` | Z1 | — / id | `Workspace` |
| `terminal_*`, `shells_list`, `terminals_running` | Z1 | see `docs/CODE_MODE.md` | `TerminalInfo` |
| `terminal_attach` | Z1 | `{ terminalId }` + `Channel<ArrayBuffer>` | attachment id (`number \| null`); replay first, then live bytes |
| `terminal_ack` | Z1 | `{ attachmentId, bytes }` | `bool` — flow control; `false`: the view fell > 4 MB behind and must re-attach |
| `terminal_detach` | Z1 | `{ attachmentId }` (id-based; only the calling webview's own attachments) | `bool` |
| `providers_list` / `providers_detect` | Z2 | — | `ProviderStatus[]` (detection + capabilities + adapter state) |
| `thread_list` | Z3 | `{ workspaceId?, includeArchived? }` | `ThreadSummary[]` |
| `thread_get` | Z3 | `{ threadId }` | `ThreadSummary` |
| `thread_messages` | Z3 | `{ threadId, limit, before? }` | `ThreadMessage[]` |
| `thread_tool_calls` | Z3 | `{ threadId, limit }` | `ToolCallRecord[]` (type in `kalcode_threads::types`) |
| `thread_options` | Z3 | — | `ThreadOptions { providers: ProviderOption[], workspaces: WorkspaceOption[], permissionModes, defaultPermissionMode }` — only providers with an adapter that detection reports usable; only workspaces whose folder exists. Runs provider detection first if it hasn't run this session |
| `thread_create` | Z3 | `{ providerId, workspaceId, model?, permissionMode, prompt, name? }` | `ThreadSummary` |
| `thread_send` | Z3 | `{ threadId, text }` | `ThreadSummary` |
| `thread_resume` | Z3 | `{ threadId, text? }` (also retries a failed thread) | `ThreadSummary` |
| `thread_interrupt` / `thread_stop` | Z3 | `{ threadId }` | `ThreadSummary` |
| `thread_rename` | Z3 | `{ threadId, name }` | `ThreadSummary` |
| `thread_archive` | Z3 | `{ threadId }` | `ThreadSummary` |
| `thread_stream` | Z3 | `{ threadId }` + channel | `AgentEvent` stream (message deltas; live only) |
| `approval_list` | Z4 | `{ status?: "pending" \| "approved" \| "denied" \| "expired" }` | `ApprovalView[]` (`ApprovalRequest` + `allowedDecisions`, `grantCoverage`, `context`, `createdAt`, `expireReason`; contract change requested) |
| `approval_decide` | Z4 | `{ requestId, decision: ApprovalDecision }` | `ApprovalView` |
| `permission_profiles_list` | Z4 | — | `PermissionProfile[]` |
| `thread_set_permission_mode` | Z4 | `{ threadId, mode, confirmBypass?, profileId? }` | `ThreadSummary` — through the permission engine, which stores the mode via the thread runtime (`ThreadModeStore`) and records `permission.mode_changed` + audit once |
| `permission_settings_get` / `permission_settings_update` | Z4 | — / `{ defaultMode, profileId?, confirmBypass? }` | `PermissionSettings` (additive; contract change requested) |
| `test_permission_probe` | Z4 (test hook) | `{ workspaceId }` | evaluations of two fixed actions; refused unless test hooks are compiled in (debug and `e2e` builds) |

Rules that bind every command: ids validated with `is_valid_id`; the WebView never supplies paths,
executables or shell strings; Bypass can only be set by a user action with `confirmBypass: true`
and never by an agent or KalVoice; every consequential decision is an event. Every
permission mode is available on every plan.

## Test and dev isolation

See `docs/DEVELOPMENT.md` (ports, isolated data folders, migration reservations).

| Thread | UI test port | E2E DevTools port |
| --- | --- | --- |
| Z3 threads | 1434 | 9434 |
| Z4 permissions | 1435 | 9435 |
| Z5 dashboard | 1436 | 9436 |
| Test infrastructure | 1437 | 9437 |
