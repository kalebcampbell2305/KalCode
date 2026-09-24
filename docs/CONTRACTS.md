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

| Migration | Owner | Tables |
| --- | --- | --- |
| `0001` | Z0 | `app_meta`, `settings`, `events` |
| `0002` | Z1 | `workspaces`, `terminals` |
| `0003` | Z2 | provider/account metadata (if needed; never secrets) |
| `0004` | Z3 | `threads`, `thread_messages`, `tool_calls` |
| `0005` | Z4 | `permission_profiles`, `approvals`, `permission_grants`, `permission_audit` |

A table has exactly one owning campaign. Others read it through that campaign's Rust API, not
with their own SQL.

## IPC surfaces (names and shapes are fixed here)

| Command | Owner | Input | Output |
| --- | --- | --- | --- |
| `workspace_list` / `workspace_active` / `workspace_open_dialog` / `workspace_activate` / `workspace_remove` | Z1 | — / id | `Workspace` |
| `terminal_*`, `shells_list`, `terminals_running` | Z1 | see `docs/CODE_MODE.md` | `TerminalInfo` |
| `providers_list` / `providers_detect` | Z2 | — | `ProviderDetection[]` (+ capabilities) |
| `thread_list` | Z3 | `{ workspaceId?, includeArchived? }` | `ThreadSummary[]` |
| `thread_get` | Z3 | `{ threadId }` | `ThreadSummary` |
| `thread_messages` | Z3 | `{ threadId, limit, before? }` | `ThreadMessage[]` |
| `thread_create` | Z3 | `{ providerId, workspaceId, model?, permissionMode, prompt, name? }` | `ThreadSummary` |
| `thread_send` / `thread_interrupt` / `thread_resume` / `thread_stop` | Z3 | `{ threadId, text? }` | `ThreadSummary` |
| `thread_rename` / `thread_archive` | Z3 | `{ threadId, name? }` | `ThreadSummary` |
| `thread_stream` | Z3 | `{ threadId }` + channel | `AgentEvent` stream (message deltas; live only) |
| `approval_list` | Z4 | `{ status?: "pending" }` | `ApprovalRequest[]` |
| `approval_decide` | Z4 | `{ requestId, decision: ApprovalDecision }` | `ApprovalRequest` |
| `permission_profiles_list` | Z4 | — | `PermissionProfile[]` |
| `thread_set_permission_mode` | Z4 | `{ threadId, mode, confirmBypass? }` | `ThreadSummary` |

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
