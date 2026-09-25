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
| Permissions (`PermissionMode`, `PermissionScope`, rules, profiles, `NormalizedAction` + `ActionOrigin`, `PolicyDecision`, `ApprovalRequest` (incl. the former `ApprovalView` fields) + `ApprovalContext`, `ApprovalDecision`, `MemoryScope`, `PermissionGate` trait) | `crates/contracts/src/permissions.rs` | generated types; `ApprovalView = ApprovalRequest` alias in `packages/protocol/src/permissions.ts` |
| Trust Kernel phase 1 (`AuthorityCeiling`, `CeilingSource`, `ActionRequest`, `KernelInvariant`, `KernelDecision`, `DecisionExplanation`, `ExplanationStep`, `TrustKernel` trait) | `crates/contracts/src/trust.rs` | generated types |
| Thread options and tool calls (`ThreadOptions`, `ProviderOption`, `WorkspaceOption`, `ToolCallRecord`, `ToolCallStatus`, `ThreadCreateInput`, `ThreadRuntimeKind`) | `crates/contracts/src/threads.rs` (moved from `kalcode_threads::types`, same JSON) | generated types |
| File handles and paging (`FileHandle`, `FileRef`, `PageRequest`, `Page<T>`) | `crates/contracts/src/refs.rs` | generated types |
| Git (`FileEntry`, `GitStatusSummary`, `Worktree*`, `GitFileChange`, `DiffFile`, `DiffTarget`, `Diff`, `FileDiff`, `Hunk`, `DiffLine`, `LineKind`, `StatusFile`, `ConflictKind`, `BranchState`, `Commit`, `Branch`, `BranchKind`) | `crates/contracts/src/git.rs` (re-exported by `kalcode_git`) | generated types |
| Checkpoints (`Checkpoint`, `CheckpointTrigger`, `PlannedChange`) | `crates/contracts/src/timeline.rs` | generated types |
| Context and firewall (`ContextPurpose`, `Sensitivity`, `IgnoreSource`, `FirewallRule`, `RuleEffect` (TS `FirewallRuleEffect`), `FirewallReason`, `FirewallVerdict`, `ItemKind`, `ItemOrigin`, `TranslationPlan`, `RefusalReason`, `Modality`, `LineRange`, `ContextItemPreview`, `ContextPreview`) | `crates/contracts/src/context.rs` (re-exported by `kalcode_context`) | generated types |
| Resource Governor (`GovernorMode`, `CustomResourceLimits`, `GpuLimits`, `Reading<T>`, `ResourceSnapshot` and its readings, `ResourcePressure`, `PressureSummary`, `Signal` (TS `PressureSignal`), `CapacityAdvice`, `ResourceHoldReason`, `ResourceReleaseCause`, …) | `crates/contracts/src/resources.rs` (re-exported by `kalcode_resources`) | generated types |
| Z7 display statuses and panes (`DisplayStatus`, `DisplayQualifier`, `DashboardChip`, `StatusTone`, `PaneLayout`, `PaneNode`, `PaneContent`, `SplitAxis`, `LayoutPreset`; `ThreadStatus::display` / `chip`) | `crates/contracts/src/workspace_ui.rs`, `threads.rs` | generated types; the mapping in `packages/protocol/src/display-status.ts` |
| Provider panes (`InteractiveSupport`, `StatusChannel`, `ProviderCapabilities.interactive`) | `crates/contracts/src/agent.rs` | generated types |
| Surfaces and features (`SurfaceId` incl. `CommandCenter`, `FeatureId`, `FeaturePlacement`) | `crates/contracts/src/app.rs`; flags in `crates/native-core/src/flags.rs` | generated types; plan placement in `packages/protocol/src/features.ts` |
| Event query (`EventQuery`, `CorrelationFilter`, `SeqOrder`, `EventPage`) | `crates/contracts/src/events.rs` | generated types |
| Plans and prices | — | `packages/protocol/src/plans.ts` |

TypeScript is generated with ts-rs into `packages/protocol/src/generated` (`pnpm gen:protocol`,
which runs the ts-rs exports of contracts, native-core, providers, threads, permissions and
kalvoice).
`native-core` re-exports the event types (`kalcode_core::events::*`) and stores/delivers them.

### CA-1 (advanced systems, phase P0/P1 contracts)

Adopted from `docs/CONTRACTS_ADVANCED.md` and the campaign requests (Z3, Z4, Z6a, CTX, RG, Z7).
Everything is additive: new fields on existing types are `#[serde(default)]`, so JSON stored or
cached before CA-1 still decodes (tested per type). Moved types keep their exact JSON; the owning
crates re-export them so their Rust paths still work.

- **Threads:** `ThreadSummary` gains `archivedAt`, `resumable` (resume restores the provider's
  conversation: the provider supports resume and a session id is stored), `permissionProfileId`,
  `runtimeKind`, `terminalId`. `branch` already existed and stays `null`: `threads` has no branch
  column yet (the worktree binding arrives with L-2, migration v12). `thread_create` accepts
  optional `confirmBypass` and `profileId` (`ThreadCreateInput`): `profileId` is validated and
  Bypass without `confirmBypass: true` is refused, but the runtime still refuses Bypass and
  Custom at creation — they are set through `thread_set_permission_mode` until it supports them.
- **Permissions:** `ApprovalRequest` adopts `allowedDecisions`, `grantCoverage`, `context`,
  `createdAt`, `expireReason`; Z4's `ApprovalView` is now an alias of it (same JSON).
  `NormalizedAction.origin: ActionOrigin | null` (absent = the thread origin; `kind` values are
  exactly the v4 `approvals.origin_kind` CHECK values, tested against the SQL). New scopes
  `process.control`, `remote.connect`, `context.share`, `memory.write`, `automation.manage`,
  `agent.delegate`, `tool.unknown`; new action kinds `process_signal`, `remote_connect`,
  `context_share`, `memory_write`, `delegate`, `restore`, `automation_change`, `doctor_fix`.
  Until TK-1 the engine classifies the new kinds as opaque (always an explicit, one-time
  approval) and does not yet report `tool.unknown` (unrecognized tools stay `terminal.execute`,
  opaque); the new scopes are not in the built-in profiles yet.
- **KalVoice (Z12 requests, accepted by the lead):** `ActionOrigin::KalVoice { requestId }`
  and a Z4 entry point for non-thread origins, `PermissionService::request_for_origin` (KalVoice
  today; other origins in TK-1): the action is evaluated under Approve (a non-thread origin never
  selects or changes a mode), standing grants and rules never apply, and when the policy asks an
  approval is filed with `origin_kind = 'kalvoice'` and `thread_id` / `provider_id` NULL as v4
  allows, answerable only by the user with Approve once or Deny (the existing answerer checks
  refuse KalVoice). New action kinds `create_threads { providerId, count, workspaceId? }` and
  `resume_threads { scope }` with the new scope `thread.start`, so KalVoice's consequential
  intents go through the real engine instead of its interim confirm gate. `KalVoiceIntent` gains
  `split`, `resize`, `focus`, `search`, `close`, `switch_provider` and `request_permission_mode`
  (`RequestableMode` has no Bypass, so a Bypass request is not representable; the person confirms
  any change in KalCode). `KalVoiceMode` gains `talk` (one push-to-talk gesture); `dictation`
  and `command` are deprecated but still decode. Event `kalvoice.talk_routed { requestId,
  outcome }` with `TalkRoute` = `command | dictation | request` (never words).
- **Display statuses (Z7):** 18 runtime statuses → 12 display statuses, one mapping in Rust
  (`ThreadStatus::display`, `chip`, `DisplayStatus::tone`) and its TypeScript mirror
  (`displayStatusOf`), kept identical by a test. Colours: working green; waiting and permission
  required neutral grey; idle, starting and offline muted; done high-contrast neutral; failed
  red; paused amber (the only amber); recovering blue. `interrupted` and `waiting_for_dependency`
  show as IDLE with a qualifier; FAILED counts under "Waiting for you".
- **Features:** `SurfaceId::CommandCenter` (gated) and per-feature flags (`FeatureFlags.features`,
  every feature gated today). Plan placement (`FeatureId::placement`, source of truth
  `packages/protocol/src/features.ts`): **safety, every plan** — Trust Kernel explain, Context
  Firewall, host-key verification, Environment Doctor, safe restore, automation kill switch;
  **Free** — provider health, session locator, process continuity, Utility Dock, Git core,
  context drop (lead), resource governor (lead), workspace home/rail, pane system, provider
  panes, notification center, account sign-in (lead: core UX); **Pro** — agent organization,
  provider profiles, blueprints, Time Machine, provider handoff, remote workspaces, automations,
  memory (lead), missions and verification (lead; advanced missions stay MAX through the
  existing `advancedMissions` entitlement); **MAX** — Command Center, scheduler, benchmark lab,
  failure autopsy (lead), diff intelligence. OWNER is unrestricted. Evaluated on the verified,
  signed tier (`kalcode_entitlements::Tier::includes`, `featureIncluded` in TypeScript), never
  as a frontend-only check. The entitlement document format is unchanged (its feature list is
  the separate `EntitlementFeatureId`).

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
| `0005` (v5) | lead (L-1) | `events` + `agent_id`, `task_id`, `automation_id`, `causation_id` and partial indexes (plus `events(request_id)`) | merged |
| `0006` (v6) | Z12 KalVoice | `kalvoice_requests` (local KalVoice Request ledger), `kalvoice_preferences` | merged (integrate/kalvoice) |
| `0007` (v7) | Z6a git core | `git_worktrees`, `checkpoints` (`kalcode_core::db::GIT_MIGRATION`, re-exported as `kalcode_git::store::GIT_MIGRATION`) | registered (z7/panes Step 0) |
| `0008` (v8) | CTX/FW | `context_packages`, `context_items`, `context_firewall_log`, `context_never_share` (`kalcode_core::db::CONTEXT_MIGRATION`, re-exported as `kalcode_context::MIGRATION_V8`) | registered (z7/panes Step 0) |
| `0009` (v9) | Z7-W1 pane system | `workspace_layouts` (one validated `PaneLayout` per workspace), `layout_presets` (saved layout shapes, no content ids) (`kalcode_core::db::WORKSPACE_UI_MIGRATION`, re-exported by `kalcode_workspace_ui`) | branch z7/panes |

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
| `thread_create` | Z3 | `ThreadCreateInput`: `{ providerId, workspaceId, model?, permissionMode, prompt, name?, confirmBypass?, profileId? }` (the last two CA-1; see above) | `ThreadSummary` |
| `thread_send` | Z3 | `{ threadId, text }` | `ThreadSummary` |
| `thread_resume` | Z3 | `{ threadId, text? }` (also retries a failed thread) | `ThreadSummary` |
| `thread_interrupt` / `thread_stop` | Z3 | `{ threadId }` | `ThreadSummary` |
| `thread_rename` | Z3 | `{ threadId, name }` | `ThreadSummary` |
| `thread_archive` | Z3 | `{ threadId }` | `ThreadSummary` |
| `thread_stream` | Z3 | `{ threadId }` + channel | `AgentEvent` stream (message deltas; live only) |
| `approval_list` | Z4 | `{ status?: "pending" \| "approved" \| "denied" \| "expired" }` | `ApprovalView[]` (= `ApprovalRequest`, which carries `allowedDecisions`, `grantCoverage`, `context`, `createdAt`, `expireReason` since CA-1) |
| `approval_decide` | Z4 | `{ requestId, decision: ApprovalDecision }` | `ApprovalView` |
| `permission_profiles_list` | Z4 | — | `PermissionProfile[]` |
| `thread_set_permission_mode` | Z4 | `{ threadId, mode, confirmBypass?, profileId? }` (`profileId` confirmed in CA-1: Custom needs a profile) | `ThreadSummary` — through the permission engine, which stores the mode via the thread runtime (`ThreadModeStore`) and records `permission.mode_changed` + audit once |
| `permission_settings_get` / `permission_settings_update` | Z4 | — / `{ defaultMode, profileId?, confirmBypass? }` | `PermissionSettings` (confirmed in CA-1) |
| `events_query` | lead (L-1) | `{ query: EventQuery }` — `types` (exact or `domain.*`, ≤ 32), `correlation` (any subset of the nine ids; all given must match; entity ids must be KalCode ids), `afterSeq` / `beforeSeq`, `from` / `to` (RFC 3339), `order` (`asc` \| `desc`), `limit` 1..=500 | `EventPage { events, nextCursor }` — `nextCursor` is the last `seq` of a full page (pass it as `beforeSeq` descending or `afterSeq` ascending); read on the core's read-only WAL connection |
| `test_permission_probe` | Z4 (test hook) | `{ workspaceId }` | evaluations of two fixed actions; exists only in debug and `e2e` builds (`#[cfg]`-gated command, declared in build.rs `TEST_HOOK_COMMANDS`, granted at runtime by `test-capabilities/test-hooks.json`); release builds neither register nor grant it |

Rules that bind every command: ids validated with `is_valid_id`; the WebView never supplies paths,
executables or shell strings; Bypass can only be set by a user action with `confirmBypass: true`
and never by an agent or KalVoice; every consequential decision is an event. Every
permission mode is available on every plan.

**Native confirmations (ADVANCED.md §3 D8, K10).** Because the WebView is treated as possibly
compromised, `confirmBypass: true` from IPC is not proof of a person's intent. L-1 adds the
Rust-side helper: `kalcode_core::confirm` composes the dialog text natively from structured
facts (untrusted names and summaries are redacted, stripped of control, bidi and zero-width
characters, clipped and quoted) and issues a `ConfirmationReceipt` only after a
`NativeConfirmer` reports the confirm button; failure to show a dialog is a refusal. The desktop
implementation is `apps/desktop/src-tauri/src/native_confirm.rs` (an OS message dialog parented
to the main window; E2E builds answer with `KALCODE_E2E_NATIVE_CONFIRM=accept|decline`). Wiring it
into Bypass enablement and remote-consequential approvals is TK-1.

**Shared redactor.** `kalcode_core::redact` (secret detection + structure-preserving redaction,
extracted from `kalcode_context` in L-1) is the one redactor: log lines use `redact_log_line`
(`logging::redact` delegates to it; every logging test vector still passes), the Context
Firewall uses the labelled form, and later tools (Utility Dock, locator snippets, memory) reuse
it.

## Test and dev isolation

See `docs/DEVELOPMENT.md` (ports, isolated data folders, migration reservations).

| Thread | UI test port | E2E DevTools port |
| --- | --- | --- |
| Z3 threads | 1434 | 9434 |
| Z4 permissions | 1435 | 9435 |
| Z5 dashboard | 1436 | 9436 |
| Test infrastructure | 1437 | 9437 |
