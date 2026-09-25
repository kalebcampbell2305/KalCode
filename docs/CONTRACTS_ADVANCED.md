# Shared contracts — advanced systems (partly adopted in CA-1)

> **Status: partly adopted.** The parts marked **Adopted in CA-1** below are implemented in
> `crates/contracts` (with generated TypeScript), as summarized in `docs/CONTRACTS.md` §CA-1;
> where the implementation differs from the sketch here, the difference is stated next to the
> section and the code is authoritative. Everything not so marked is still **PROPOSED** — for
> lead approval, not implemented. Owner: the lead / integrator (`crates/contracts`, native-core
> event storage). Campaign agents consume these types; they never edit `crates/contracts`
> themselves (`docs/CONTRACTS.md`).
>
> Plan: `docs/campaigns/ADVANCED.md`. System codes (ORG, SCH, … BL) are defined there (§0).

This document proposes additive contract changes for twenty systems and their foundations. It was
written after inspecting `main` (`5188546`) and the in-flight branches `z1/workspace-terminal`,
`z3/threads`, `z4/permissions` and `z12/kalvoice`. Every proposal either extends an existing
contract or states why a new one is needed.

## 1. Conventions

- Rust (`crates/contracts`) is the source of truth; TypeScript is generated with ts-rs
  (ADR 0002).
- Unless stated otherwise, **structs** derive `Debug, Clone, PartialEq, Eq, Serialize,
  Deserialize, TS`, with `#[serde(rename_all = "camelCase")] #[ts(export)]`. **Enums** use
  `#[serde(rename_all = "snake_case")]`; data-carrying enums are internally tagged
  (`#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]`), as in
  `ActionKind` and `KalVoiceIntent` today. Those derives are omitted from the sketches below.
- Ids are UUIDv7 strings validated with `is_valid_id`. Times are RFC 3339 UTC strings.
- Adding a field to an existing struct uses `#[serde(default)]` so stored JSON (for example
  `approvals.request`) still deserializes. Rust struct literals in other crates must then use
  `..Default::default()` or be updated in the same lead PR.
- New modules: `trust.rs`, `refs.rs`, `profiles.rs`, `context.rs`, `remote.rs`, `timeline.rs`,
  `org.rs`, `missions.rs`, `verification.rs`, `scheduler.rs`, `memory.rs`, `automations.rs`,
  `utility.rs`, `diffintel.rs`, `outcomes.rs`, `handoff.rs`, `locator.rs`, `doctor.rs`,
  `health.rs`, `resources.rs`, `blueprints.rs`, `continuity.rs`. The name `org.rs` avoids a
  clash with the existing provider-adapter module `agent.rs`.
- Delivery follows the plan's phases (`ADVANCED.md` §0). **CA-0** (P0) = §3.1–3.2 and the Z6a,
  CTX/FW and RG types. **CA-1** (P1, Z7) = §2 (Trust Kernel), §4, §6.10 (Z7), LOC, PC,
  notifications, thread runtime kind, `ProviderCapabilities.interactive`. **CA-2** (P2) = PP, PH,
  UD, TM, DOC. **CA-3** (P3) = ORG, Z9, Z10, RW. **CA-4** (P4) = SCH, DI/BR, AUT, MEM. **CA-5**
  (P5) = CC, HS, BL/FA, BP. Each CA-n also carries its phase's event variants and KalVoice
  intents.

---

## 2. Trust Kernel: action origins, ceilings, invariants (extends `permissions.rs`)

> **Adopted in CA-1 (types only).** `ActionOrigin` (compatible form: `NormalizedAction.origin:
> Option<ActionOrigin>`, `thread_id` / `provider_id` stay non-optional), the six scopes plus
> `tool.unknown` (Z4 request), the new action kinds, `ProcessSignalKind`, `AutomationChangeKind`,
> `MemoryScope` (from §5.9, needed by `MemoryWrite`), `AuthorityCeiling`, `CeilingSource`,
> `ActionRequest`, `KernelInvariant`, `KernelDecision`, `DecisionExplanation`, `ExplanationStep`
> and the `TrustKernel` trait (`crates/contracts/src/trust.rs`). `ActionOrigin::Utility` carries
> the tool id as a string until the Utility Dock defines `UtilityTool`. `NormalizedAction.host_id`
> is not added yet (RW). No behaviour change in `crates/permissions` beyond classifying the new
> action kinds as opaque (always ask) until TK-1.

The Trust Kernel formalises the Z4 engine (`docs/TRUST_KERNEL.md`). It adds **no** second
evaluator. The Z4 crate implements the trait below; `PermissionGate` remains and is implemented
on top of it.

```rust
// permissions.rs — additive

/// Who is acting. Replaces the crate-local `Actor` in crates/permissions (same values, plus ids).
pub enum ActionOrigin {
    User,
    System,
    /// A provider session in a thread (today's only origin).
    Thread { thread_id: String },
    KalVoice { request_id: String },
    Agent { agent_id: String, thread_id: String },
    Delegation { delegation_id: String, thread_id: String },
    Automation { automation_id: String, run_id: String },
    Doctor { run_id: String, fix_code: String },
    Continuity { item_id: String },
    Utility { tool: crate::utility::UtilityTool },
    Remote { host_id: String },
}

pub struct NormalizedAction {
    // existing fields unchanged: id, thread_id, workspace_id, provider_id, action, summary, requested_at
    /// Absent in rows stored before TK-1 ⇒ `Thread { thread_id }`.
    #[serde(default)]
    pub origin: Option<ActionOrigin>,
    /// `None` for local workspaces.
    #[serde(default)]
    pub host_id: Option<String>,
}
```

`NormalizedAction.thread_id` / `provider_id` stay non-optional for wire compatibility. For
non-thread origins they hold `""`, and `origin` is authoritative. The alternative is to make them
`Option`, which is cleaner but breaks every existing consumer. The lead should choose before Z4
merges; this document assumes the compatible form, plus the Z4 schema change in `ADVANCED.md` §6.

```rust
/// New scopes (additive; wire names dotted like the existing ones).
pub enum PermissionScope {
    // … existing 19 …
    #[serde(rename = "process.control")]   ProcessControl,     // terminate/signal a process
    #[serde(rename = "remote.connect")]    RemoteConnect,      // open an SSH connection
    #[serde(rename = "context.share")]     ContextShare,       // send a context package to a provider (non-user origins)
    #[serde(rename = "memory.write")]      MemoryWrite,        // agents/automations writing memory
    #[serde(rename = "automation.manage")] AutomationManage,   // create/enable automations (non-user origins)
    #[serde(rename = "agent.delegate")]    AgentDelegate,      // start a delegation
}

/// New action kinds (additive). Classified by crates/permissions like the existing ones.
pub enum ActionKind {
    // … existing …
    ProcessSignal { pid: u32, process_name: String, signal: ProcessSignalKind },
    RemoteConnect { host_id: String, address: String },
    ContextShare { package_id: String, items: u32, bytes: u64 },
    MemoryWrite { memory_id: Option<String>, scope: crate::memory::MemoryScope },
    Delegate { contract_id: String, delegate_agent_id: String },
    Restore { checkpoint_id: String, files: u32, reset_branch: bool },
    AutomationChange { automation_id: String, change: AutomationChangeKind },
    /// A typed Doctor fix from the fixed catalog (never free-form commands).
    DoctorFix { fix_code: String, target: String },
}
pub enum ProcessSignalKind { Terminate, Kill }
pub enum AutomationChangeKind { Create, Enable, Disable, Edit, Delete }

/// A restriction applied on top of the policy. Ceilings only ever restrict (K7).
pub struct AuthorityCeiling {
    pub id: String,
    pub source: CeilingSource,
    /// The broadest mode actions may be evaluated under (never Bypass for non-user origins).
    pub max_mode: PermissionMode,
    /// `None` = no allow-list; `Some` = only these scopes may be anything other than Deny.
    pub allow_scopes: Option<Vec<PermissionScope>>,
    /// Treated as `never` rules.
    pub never: Vec<PermissionRule>,
    /// Path globs (workspace-relative) outside which filesystem scopes are denied.
    pub path_globs: Vec<String>,
    /// Parent ceiling this one was intersected with.
    pub parent_id: Option<String>,
}
pub enum CeilingSource {
    Delegation { delegation_id: String },
    Automation { automation_id: String },
    Mission { mission_id: String },
}

pub struct ActionRequest {
    pub action: NormalizedAction,
    pub mode: PermissionMode,
    pub custom_profile_id: Option<String>,
    pub ceiling: Option<AuthorityCeiling>,
}

/// Non-overridable kernel rules (docs/TRUST_KERNEL.md).
pub enum KernelInvariant {
    FailClosed,               // K1
    OpaqueNeedsApproval,      // K2
    RemoteConsequentialAsks,  // K3
    RepositoryIsNotAuthority, // K4
    OnlyUserChangesPolicy,    // K5
    BypassIsUserOnly,         // K6
    CeilingRestricts,         // K7
    ApprovalsAreUserDecided,  // K8
    Audited,                  // K9
    NativeConfirmation,       // K10
}

pub struct KernelDecision {
    /// Final result (policy result after ceilings and invariants).
    pub decision: PolicyDecision,
    pub invariants: Vec<KernelInvariant>,
    pub ceiling_applied: Option<String>,
    /// The action may proceed only after a Rust-side (native) confirmation dialog (D8 set).
    pub requires_native_confirmation: bool,
    /// Recorded in `permission_action_log`; used by `explain` and TM replay.
    pub log_id: Option<String>,
}

pub struct DecisionExplanation {
    pub action_id: String,
    pub steps: Vec<ExplanationStep>, // ordered: invariant → ceiling → profile rule → baseline → grant
    pub summary: String,             // one sentence, user-readable
}
pub struct ExplanationStep { pub scope: PermissionScope, pub source: String, pub effect: PolicyEffect, pub detail: String }

/// Implemented by crates/permissions (TK-1). The only evaluator.
pub trait TrustKernel: Send + Sync {
    fn evaluate(&self, request: &ActionRequest) -> KernelDecision;
    /// Persists an approval request (any origin) and emits `approval.requested`.
    fn open_request(&self, request: ActionRequest, decision: KernelDecision) -> Result<ApprovalRequest, String>;
    /// Records that a native confirmation happened for `log_id` (K10), then allows execution.
    fn confirm_native(&self, log_id: &str) -> Result<(), String>;
    fn explain(&self, action_id: &str) -> Option<DecisionExplanation>;
    /// Composes a child ceiling: result = parent ∩ contract. Never broader than `parent`.
    fn compose_ceiling(&self, parent: Option<&AuthorityCeiling>, child: AuthorityCeiling) -> AuthorityCeiling;
}
```

---

## 3. Event Protocol extensions

### 3.1 Envelope: correlation (protocol v1-compatible)

> **Adopted in CA-1 / L-1**, with storage in migration **v5** (not v6: L-1 took the next free
> version; KalVoice moves to v6). v5 also indexes `request_id`.

Adding optional correlation fields is non-breaking (`EVENT_PROTOCOL.md` §6). Storage: migration
**v6** adds nullable columns and partial indexes to `events`.

```rust
pub struct Correlation {
    // existing: workspace_id, thread_id, mission_id, provider_id, request_id
    #[serde(default)] pub agent_id: Option<String>,
    #[serde(default)] pub task_id: Option<String>,
    #[serde(default)] pub automation_id: Option<String>,
    /// Id of the event that directly caused this one (TM causality, AUT loop detection).
    #[serde(default)] pub causation_id: Option<String>,
}
```

Emitters set `causation_id` when a domain operation is a reaction to an event. Examples: an
automation run, a scheduler start after `mission.task_status_changed`, a delegation after a thread
action, a Doctor fix after a finding.

### 3.2 Query (`events_query`, lead)

> **Adopted in L-1.** `CorrelationFilter` also accepts `request_id`; `EventQuery` fields default
> when absent (all types, newest first, limit 100). IPC: `events_query { query }`.

```rust
pub struct EventQuery {
    /// Exact types or `domain.*` prefixes; ≤ 32 entries; empty = all.
    pub types: Vec<String>,
    pub correlation: CorrelationFilter, // any subset; all given fields must match
    pub after_seq: Option<i64>,
    pub before_seq: Option<i64>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub order: SeqOrder,                // asc | desc
    pub limit: u32,                     // 1..=500
}
pub struct CorrelationFilter {
    pub workspace_id: Option<String>, pub thread_id: Option<String>, pub mission_id: Option<String>,
    pub provider_id: Option<String>, pub agent_id: Option<String>, pub task_id: Option<String>,
    pub automation_id: Option<String>, pub causation_id: Option<String>,
}
pub enum SeqOrder { Asc, Desc }
pub struct EventPage { pub events: Vec<EventEnvelope>, pub next_cursor: Option<i64> }
```

### 3.3 New event types (all `version: 1`, payloads = ids and short facts only)

> **Adopted in CA-1:** `git.branch_changed`, `git.diff_changed`, `git.commit_created`,
> `git.worktree_created`, `git.worktree_removed`, `timeline.checkpoint_created`,
> `timeline.checkpoint_pruned`, the five `context.*` types plus `context.override_confirmed`
> (`{ packageId, position, rule }`; `context.shared.threadId` is optional), and
> `resource.pressure_changed` (plus optional `signal`, `value`, `threshold`),
> `resource.mode_changed`, `resource.task_held`, `resource.task_released` (RG), and
> `permission.default_mode_changed` (Z4). The other rows remain proposed.

"Dup-check" states why a type is *not* a duplicate of an existing one, or which existing type is
reused instead.

| Type | Payload | System | Dup-check |
| --- | --- | --- | --- |
| `git.branch_changed` | `{ workspaceId, from?, to }` | Z6a | Documented, missing from the enum. |
| `git.diff_changed` | `{ workspaceId, worktreeId?, files }` | Z6a | Debounced (≥ 1 s); transitions only. |
| `git.commit_created` | `{ workspaceId, worktreeId?, oid, byKalCode }` | Z6a | |
| `git.worktree_created` / `.worktree_removed` | `{ workspaceId, worktreeId, branch, purpose }` | Z6a | |
| `timeline.checkpoint_created` | `{ checkpointId, workspaceId, trigger, files, bytesAdded }` | Z6a/TM | |
| `timeline.checkpoint_pruned` | `{ checkpointId, reason }` | Z6a | |
| `timeline.restore_started` / `.restore_completed` / `.restore_failed` | `{ restoreId, checkpointId, kind, safetyCheckpointId, code? }` | TM | |
| `timeline.branch_created` | `{ checkpointId, branch, worktreeId? }` | TM | Distinct from `git.branch_changed`, which reports HEAD moves. |
| `timeline.replay_started` / `.replay_completed` | `{ replayId, steps, allowed?, denied?, asked? }` | TM | Each step also produces normal `tool.*` / `approval.*` events. |
| `provider_profile.created` / `.updated` / `.archived` | `{ profileId, providerId, version }` | PP | |
| `provider_profile.binding_changed` | `{ scopeKind, scopeId?, providerId, profileId? }` | PP | |
| `provider_profile.applied` | `{ profileId, version, threadId, resolvedFrom, notApplied }` | PP | Per session start, not per message. |
| `provider.health_changed` | `{ providerId, from, to, reason }` | PH | `provider.error` stays for detection errors. **Adopted in PROVIDERS-2.** |
| `provider.capacity_changed` | `{ providerId, state, activeSessions, limit?, retryAt? }` | PH | Transitions between available / saturated / backing_off only. **Adopted in PROVIDERS-2.** |
| `provider.handoff_recommended` | `{ fromThreadId, toProviderId, reason }` | HS | Assisted mode. |
| `provider.handoff_started` / `.handoff_completed` / `.handoff_failed` | `{ capsuleId, fromThreadId, toThreadId?, toProviderId, mode, code? }` | HS | |
| `context.package_created` | `{ packageId, purpose, items, bytes }` | CTX | |
| `context.blocked` | `{ packageId, rule, items }` | FW | |
| `context.redacted` | `{ packageId, items, spans }` | FW | |
| `context.shared` | `{ packageId, threadId, providerId, items, bytes, redactions }` | CTX | `agent.message` records the message; this records what context went with it. |
| `context.discarded` | `{ packageId }` | CTX | |
| `workspace.remote_connecting` / `.remote_connected` / `.remote_disconnected` / `.remote_reconnecting` / `.remote_auth_failed` | `{ hostId, workspaceId?, attempt?, method?, reason? }` | RW | Extends the `workspace.*` domain. |
| `remote_host.key_trusted` / `.key_changed` / `.key_rejected` | `{ hostId, algorithm, fingerprint, previousFingerprint? }` | RW | Fingerprints are public data. |
| `agent.created` / `.updated` / `.retired` | `{ agentId, name }` | Z8 | The `agent.` domain now covers organization agents; `agent.message` keeps its meaning (a thread message). |
| `agent.delegated` | `{ delegationId, contractId, fromAgentId, toAgentId, depth, threadId, ceilingId }` | ORG | |
| `agent.delegation_refused` | `{ contractId, fromAgentId, toAgentId, reason }` | ORG | |
| `agent.delegation_completed` | `{ delegationId, status }` | ORG | |
| `mission.created` / `.status_changed` | `{ missionId, from?, to }` | Z9 | Documented as `mission.*`. |
| `mission.task_created` / `.task_status_changed` | `{ missionId, taskId, from?, to }` | Z9 | Lifecycle only; scheduler states are separate. |
| `verification.started` / `.passed` / `.failed` / `.errored` | `{ runId, specId, taskId?, exitCode?, evidence }` | Z10 | Documented as `verification.*`. |
| `scheduler.mode_changed` | `{ from, to }` | SCH | |
| `scheduler.task_queued` / `.task_started` / `.task_blocked` / `.task_waiting` / `.task_conflicted` | `{ taskId, reasons: SchedulerReasonCode[], threadId?, worktreeId? }` | SCH | Emitted on state/reason-set change only. |
| `scheduler.override_applied` / `.override_cleared` | `{ taskId, override }` | SCH | |
| `memory.created` / `.updated` / `.verified` / `.pinned` / `.unpinned` / `.ignored` / `.deleted` | `{ memoryId, scopeKind, result? }` | MEM | Never the statement. |
| `memory.stale` | `{ memoryId, reason }` | MEM | |
| `memory.contradicted` | `{ memoryId, otherMemoryId, method }` | MEM | |
| `automation.created` / `.updated` / `.enabled` / `.disabled` / `.deleted` | `{ automationId, version }` | AUT | |
| `automation.triggered` | `{ automationId, runId, triggerEventId, chainDepth }` | AUT | |
| `automation.run_completed` | `{ runId, status }` | AUT | |
| `automation.loop_prevented` | `{ automationId, triggerEventId, chainDepth, reason }` | AUT | |
| `automation.rate_limited` | `{ automationId, reason }` | AUT | Cooldown or runs/hour. |
| `automation.kill_switch_changed` | `{ engaged }` | AUT | |
| `notification.created` | `{ notificationId, kind, severity, entityKind?, entityId? }` | Z7-W3 | Documented; now defined. Other systems create notifications through `crates/notifications`. |
| `workspace.updated` | `{ workspaceId, fields: string[] }` (`name`, `pinned`, `group`, `position`) | Z7-W2 | Rail changes; `workspace.created/opened/removed` (Z1) are unchanged. |
| `workspace.archived` / `.unarchived` | `{ workspaceId }` | Z7-W2 | Archive hides from the rail; files are never touched. |
| `utility.opened` | `{ tool }` | UD | |
| `utility.process_signaled` | `{ pid, processName, signal, owner }` | UD | |
| `utility.request_sent` | `{ method, host, status? }` | UD | Host only; never the URL path or query. |
| `impact.analysis_completed` | `{ analysisId, workspaceId, changed, impacted, maxLikelihood }` | BR | |
| `diff.analysis_completed` | `{ analysisId, workspaceId, files, classes }` | DI | Per-file attribution is a table, not events. |
| `diff.overlap_detected` | `{ workspaceId, a, b, paths, confidence }` | DI | |
| `failure.autopsy_created` | `{ autopsyId, subjectKind, subjectId, confirmed, likely, unknown }` | FA | |
| `failure.remediation_proposed` / `.remediation_decided` | `{ autopsyId, proposalId, kind, decision? }` | FA | |
| `session.located` | `{ entityKind, entityId, via }` | LOC (Z7-W2) | Emitted when a located item is *opened*; never the query. |
| `doctor.run_started` / `.run_completed` | `{ runId, checks?, findings?: {critical, warning, info} }` | DOC | |
| `doctor.fix_applied` / `.fix_failed` / `.fix_reverted` | `{ runId?, findingCode, fixCode, code? }` | DOC | |
| `doctor.finding_ignored` / `.finding_unignored` | `{ findingCode, scopeKind }` | DOC | |
| `blueprint.created` / `.updated` / `.deleted` / `.imported` / `.exported` | `{ blueprintId, version }` | BP | |
| `blueprint.applied` | `{ blueprintId, version, workspaceId, applied, skipped }` | BP | |
| `continuity.recovery_summarized` | `{ restorable, reconnectable, restartable, notRecoverable }` | PC | Per-item recovery reuses `thread.*`, `shell.*` and `workspace.remote_*`. `app.previous_session_interrupted` stays the crash signal. |
| `trust.action_blocked` | `{ actionId, originKind, scopes, reason, invariant? }` | TK | Denies were previously not events. |
| `trust.ceiling_applied` | `{ ceilingId, source, parentId? }` | TK | |
| `resource.pressure_changed` | `{ resource, from, to, mode }` | RG | Transitions only; samples use a channel. |
| `resource.mode_changed` | `{ from, to }` | RG | |
| `benchmark.recomputed` | `{ cells, observations }` | BL | |

**Not added, on purpose:**

- `trust.action_evaluated`: one per action, including every file read, would flood the log.
  Evaluations of non-read scopes go to `permission_action_log` (TK-06).
- `trust.permission_granted`: `approval.approved` already carries the decision (including
  "approve for thread / workspace / rule"), and the grant is audited in `permission_audit`.
- Per-sample `resource.*`, per-search `session.*`, and per-file `diff.*` events.

New `EventSource` values are not needed: Doctor, Continuity and Scheduler emit as `core`,
automations as `automation`.

---

## 4. Shared primitives (`refs.rs`)

> **Adopted in CA-1:** `FileHandle`, `FileRef`, `PageRequest`, `Page<T>` (identical JSON to
> `kalcode_git`). `Likelihood`, `Confidence`, `ThreadOrigin`, `WorkspaceLocation` and
> `ThreadRuntimeObserver` remain proposed.

```rust
/// Opaque, session-scoped reference to a file native code listed (ADVANCED.md §3 D4).
pub struct FileHandle { pub id: String }
/// What the UI may display about a handle.
pub struct FileRef { pub handle: FileHandle, pub workspace_id: String, pub display_path: String /* workspace-relative */ }

pub struct PageRequest { pub limit: u32 /* 1..=500 */, pub cursor: Option<String> }
pub struct Page<T> { pub items: Vec<T>, pub next_cursor: Option<String>, pub total_estimate: Option<u64> }

/// Heuristic confidence. Never rendered as certainty.
pub enum Likelihood { Low, Medium, High }
pub struct Confidence { pub score: u8 /* 0..=100 */, pub basis: Vec<String> }

/// Why a thread exists (L-2). Stored on `threads`.
pub enum ThreadOrigin {
    User,
    KalVoice { request_id: String },
    Agent { agent_id: String },
    Delegation { delegation_id: String },
    Task { task_id: String },
    AutomationRun { run_id: String },
    Handoff { capsule_id: String, from_thread_id: String },
}

/// Where a workspace lives (Z1 change requested in ADVANCED.md §6).
pub enum WorkspaceLocation {
    Local { root: String },
    Remote { host_id: String, root: String },
}

/// Observer the thread runtime calls; implemented by PH (crates/providers). Must not block.
pub trait ThreadRuntimeObserver: Send + Sync {
    fn first_output(&self, provider_id: &ProviderId, thread_id: &str, latency_ms: u64);
    fn provider_failure(&self, provider_id: &ProviderId, thread_id: &str, code: &str, recoverable: bool);
    fn session_count(&self, provider_id: &ProviderId, active: u32);
}
```

---

## 5. Layer-1 system types

### 5.1 Provider Profiles — `profiles.rs` (PP)

```rust
pub struct ProfileSettingDescriptor {        // declared by each adapter (§10)
    pub key: String,                          // stable slug, e.g. "model", "max_turns"
    pub label: String,
    pub kind: SettingKind,
    pub application: SettingApplication,
    pub default: Option<SettingValue>,
}
pub enum SettingKind { Choice { options: Vec<String> }, Integer { min: i64, max: i64 }, Toggle, Text { max_len: u16 } }
pub enum SettingApplication {
    ProviderNative { display: String },       // e.g. "--model <alias>"
    KalCodeEnforced { mechanism: String },    // e.g. "KalCode limits concurrent sessions"
    Approximate { explanation: String },
}
pub enum SettingValue { Text { value: String }, Integer { value: i64 }, Toggle { value: bool } }

pub struct ProviderProfile {
    pub id: String, pub provider_id: ProviderId, pub name: String, pub version: u32,
    pub settings: Vec<ProfileSetting>, pub archived: bool, pub created_at: String, pub updated_at: String,
}
pub struct ProfileSetting { pub key: String, pub value: SettingValue }

pub enum ProfileScope {
    Global, Workspace { workspace_id: String }, Agent { agent_id: String },
    Mission { mission_id: String }, Thread { thread_id: String },
}
pub struct ProfileBinding { pub scope: ProfileScope, pub provider_id: ProviderId, pub profile_id: String }

pub struct ResolvedProfile {
    pub profile_id: Option<String>, pub version: Option<u32>,
    pub resolved_from: Option<ProfileScopeKind>,          // thread > mission > agent > workspace > global
    pub applied: Vec<ProfileSetting>,
    pub not_applied: Vec<NotAppliedSetting>,
}
pub struct NotAppliedSetting { pub key: String, pub reason: String }
pub enum ProfileScopeKind { Global, Workspace, Agent, Mission, Thread }

/// Failover policy for HS lives with profiles (default Off).
pub enum FailoverPolicy { Off, Suggest, Automatic { targets: Vec<ProviderId>, on: Vec<HealthState> } }
```

Profiles carry **no permission fields** (PP-04). `SessionConfig` gains
`#[serde(default)] pub profile_settings: Vec<ProfileSetting>` (adapter maps them to argv).

### 5.2 Context Drop and Firewall — `context.rs` (CTX/FW)

> **Adopted in CA-1, amended per `docs/campaigns/CTX.md`:** `FirewallRule` gains
> `WorkspacePermissionDenied`, `UnsafePath`, `UserExclusion { pattern }`, `UnscannableContent`,
> `SecretDetected.count`, `IgnoredPath.rule`; the verdict is `AllowRedacted { spans }` (wire
> `allow_redacted`); new `RuleEffect` (TypeScript `FirewallRuleEffect`), `FirewallReason`,
> `ItemKind`, `ItemOrigin`, `TranslationPlan`, `RefusalReason`, `Modality`, `LineRange`;
> `ContextItemPreview` gains `kind`, `sensitivity`, `overridable`, `overrideConfirmed`,
> `translation`, `note`, `unavailable` and `rules: FirewallReason[]`;
> `ContextPreview.targetProviderId` is a (non-optional) `ProviderId`. `ContextItemSource` is not
> adopted yet (IPC, P2).

```rust
pub enum ContextPurpose { Drop, Handoff, Memory, Automation, Delegation, Reasoning }
pub enum ContextItemSource {
    File { file: FileHandle },
    FileRange { file: FileHandle, start_line: u32, end_line: u32 },
    Selection { label: String, text: String },          // text supplied by the UI (user's own selection)
    TerminalExcerpt { terminal_id: String, lines: u32 },
    Diff { workspace_id: String, worktree_id: Option<String>, base: Option<String> },
    EventRange { from_seq: i64, to_seq: i64 },
    Memory { memory_id: String },
    ThreadExcerpt { thread_id: String, message_ids: Vec<String> },
    Text { label: String, text: String },
}
pub enum Sensitivity { Public, Internal, Confidential, Secret }
pub enum FirewallRule {
    SecretDetected { detector: String },
    IgnoredPath { source: IgnoreSource },
    SensitivityLabel { level: Sensitivity },
    OutsideMissionScope { mission_id: String },
    OutsideWorkspace,
    SizeLimit { max_bytes: u64 },
    BinaryContent,
    UntrustedProviderText,                  // labelled, not blocked
}
pub enum IgnoreSource { GitIgnore, WorkspaceNeverShare, BuiltinSensitive }
pub enum FirewallVerdict { Allow, Redact { spans: u32 }, Block { overridable: bool } }

pub struct ContextItemPreview {
    pub position: u32, pub label: String, pub source_kind: String, pub bytes: u64,
    pub verdict: FirewallVerdict, pub rules: Vec<FirewallRule>,
    pub excerpt: String,                    // redacted, bounded (≤ 4 KiB)
    pub included: bool,
}
pub struct ContextPreview {
    pub package_id: String, pub purpose: ContextPurpose,
    pub target_provider_id: Option<ProviderId>, pub target_thread_id: Option<String>,
    pub items: Vec<ContextItemPreview>, pub total_bytes: u64, pub max_bytes: u64,
    pub translation_notes: Vec<String>,      // how the package becomes provider input
    pub content_sha256: String,              // must match at send time (CTX-04)
}
```

### 5.3 Git and workspace files core — part of `timeline.rs` / `refs.rs` (Z6a)

> **Adopted in CA-1** (`crates/contracts/src/git.rs`, `timeline.rs`), identical JSON to
> `kalcode_git`, plus `GitFileChange` (replaces `FileChange` in `DiffFile`, which also gains
> `path` / `oldPath` and an optional `file`), `Worktree.createdAt` / `removedAt`,
> `Checkpoint.prunedAt`, `DiffTarget`, `Diff`, `FileDiff`, `Hunk`, `DiffLine`, `LineKind`,
> `StatusFile`, `ConflictKind`, `BranchState`, `Commit`, `Branch`, `BranchKind`.

```rust
pub struct FileEntry { pub file: FileRef, pub is_dir: bool, pub bytes: Option<u64>, pub ignored: bool }
pub struct GitStatusSummary { pub workspace_id: String, pub branch: Option<String>, pub head: Option<String>, pub changed: u32, pub untracked: u32, pub ahead: Option<u32>, pub behind: Option<u32> }
pub struct Worktree { pub id: String, pub workspace_id: String, pub branch: String, pub base_commit: String, pub purpose: WorktreePurpose, pub owner_ref: Option<String>, pub status: WorktreeStatus }
pub enum WorktreePurpose { Task, Thread, BranchFromCheckpoint, User }
pub enum WorktreeStatus { Active, Merged, Abandoned, Removed }
pub struct DiffFile { pub file: FileRef, pub change: FileChange, pub additions: u32, pub deletions: u32, pub binary: bool }
pub struct Checkpoint {
    pub id: String, pub workspace_id: String, pub commit_oid: String, pub parent_id: Option<String>,
    pub trigger: CheckpointTrigger, pub event_seq: i64, pub files: u32, pub bytes_added: u64,
    pub pinned: bool, pub created_at: String,
}
pub enum CheckpointTrigger { User, ThreadTurn { thread_id: String }, TaskStart { task_id: String }, BeforeRestore { restore_id: String }, AutomationRun { run_id: String }, BeforeDoctorFix { finding_code: String } }
```

### 5.4 Time Machine — `timeline.rs` (TM)

> **Adopted in CA-1:** `PlannedChange` only, with the extra `KeepExisting` (the checkpoint has
> the file but the current one is ignored or oversized, so it is kept). The rest remains proposed.

```rust
pub enum TimelineAction { ViewHistory, RestoreFiles, BranchFromCheckpoint, ReplayActions, ResumeSession }
pub enum ActionValidity {
    Valid,
    Degraded { explanation: String },
    Invalid { code: String, explanation: String },
}
pub struct TimelineNode {
    pub event: EventEnvelope,
    pub caused_by: Option<String>,
    pub checkpoint_id: Option<String>,
    pub attribution: Option<String>,          // DI summary ("Claude Code in thread X, likely")
    pub actions: Vec<TimelineActionState>,
}
pub struct TimelineActionState { pub action: TimelineAction, pub validity: ActionValidity }

pub enum RestoreKind { Files { files: Option<Vec<FileHandle>> }, NewBranch { name: String }, NewWorktree { name: String }, ResetBranch }
pub enum PlannedChange { Overwrite, Create, Delete, KeepUntracked }
pub struct PlannedFileChange { pub display_path: String, pub change: PlannedChange }
pub enum RestoreBlocker { LiveThreadsWriting { thread_ids: Vec<String> }, CheckpointMissing, RemoteWorkspaceUnsupported, WorkspaceUnavailable }
pub struct RestorePlan {
    pub checkpoint_id: String, pub kind: RestoreKind,
    pub changes: Page<PlannedFileChange>, pub blockers: Vec<RestoreBlocker>,
    pub safety_checkpoint: bool,               // always true
}
pub enum Replayability { Replayable, NotReplayable { reason: String } }
pub struct ReplayStep { pub log_id: String, pub action: NormalizedAction, pub replayability: Replayability }
```

### 5.5 Distributed Workspaces — `remote.rs` (RW)

```rust
pub struct RemoteHost {
    pub id: String, pub label: String, pub hostname: String, pub port: u16, pub username: String,
    pub auth: RemoteAuthMethod, pub agent_forwarding: bool, pub trusted_key: Option<TrustedHostKey>,
    pub state: RemoteConnectionState, pub last_connected_at: Option<String>,
}
pub enum RemoteAuthMethod {
    Agent,
    KeyFile { display_path: String },           // chosen in the native picker; key never copied
    Password { stored: bool },                  // secret in the OS store only when stored = true
}
pub struct TrustedHostKey { pub algorithm: String, pub fingerprint_sha256: String, pub trusted_at: String, pub trusted_via: HostKeyTrustSource }
pub enum HostKeyTrustSource { FirstUseConfirmed, KnownHostsConfirmed, ReplacedAfterChange }
pub enum RemoteConnectionState {
    Offline,
    Connecting,
    AwaitingHostKeyConfirmation { algorithm: String, fingerprint_sha256: String, known_hosts_match: bool },
    Connected { since: String },
    Reconnecting { attempt: u32, next_retry_at: String },
    AuthFailed { method: String, message: String },
    HostKeyChanged { expected_sha256: String, presented_sha256: String },
}
/// Implemented in crates/remote; an embedded SSH library first, system `ssh` as a fallback (D3).
pub trait RemoteTransport: Send + Sync { /* connect, open_pty, exec_argv, sftp, close — crate-internal */ }
```

### 5.6 Agents and organization — `org.rs` (Z8 + ORG)

```rust
pub struct AgentDefinition {
    pub id: String, pub name: String, pub role: String, pub description: String,
    pub default_provider_id: Option<ProviderId>, pub default_profile_id: Option<String>,
    pub default_mode: PermissionMode,            // Plan | Approve | Auto | Custom (never Bypass)
    pub custom_profile_id: Option<String>, pub created_at: String, pub retired_at: Option<String>,
}
pub enum RelationshipKind { ReportsTo, DelegatesTo, Reviews, Peer }
pub struct AgentRelationship { pub id: String, pub from_agent_id: String, pub to_agent_id: String, pub kind: RelationshipKind }

pub struct DelegationContract {
    pub id: String, pub supersedes_id: Option<String>,
    pub delegator_agent_id: String, pub delegate_agent_id: String,
    pub may: Vec<PermissionRule>,               // allow-list (becomes ceiling.allow_scopes + rules)
    pub may_not: Vec<PermissionRule>,           // become `never` for the delegate
    pub max_depth: u8,                          // 1..=5 (global hard cap 5)
    pub may_redelegate: bool,
    pub max_duration_secs: Option<u32>,
    pub allowed_providers: Vec<ProviderId>,     // empty = delegator's provider set
    pub revoked_at: Option<String>,
}
pub enum DelegationStatus { Pending, Active, Completed, Failed, Refused, Revoked }
pub enum DelegationRefusal { DepthExceeded { max: u8 }, Cycle { agent_id: String }, PrivilegeEscalation { scope: PermissionScope }, ContractRevoked, ContractMissing, ProviderNotAllowed, RedelegationNotAllowed }
pub struct Delegation {
    pub id: String, pub contract_id: String, pub parent_delegation_id: Option<String>, pub root_delegation_id: String,
    pub depth: u8, pub path: Vec<String> /* agent ids root→leaf */, pub delegator_thread_id: String,
    pub delegate_thread_id: Option<String>, pub ceiling_id: String, pub status: DelegationStatus,
    pub refusal: Option<DelegationRefusal>,
}
pub struct GraphNode { pub id: String, pub kind: GraphNodeKind, pub label: String, pub status: Option<ThreadStatus> }
pub enum GraphNodeKind { Agent, Thread, Task }
pub struct GraphEdge { pub from: String, pub to: String, pub kind: String }
pub struct GraphSlice { pub nodes: Vec<GraphNode>, pub edges: Vec<GraphEdge>, pub truncated: bool }
```

### 5.7 Missions and verification (Z9, Z10 foundations) — `missions.rs`, `verification.rs`

```rust
pub enum MissionStatus { Draft, Active, Paused, Completed, Failed, Cancelled }
pub struct MissionScope { pub path_globs: Vec<String>, pub providers: Vec<ProviderId> }
pub struct Mission { pub id: String, pub workspace_id: String, pub name: String, pub status: MissionStatus, pub scope: MissionScope, pub created_at: String }
/// Lifecycle only. Scheduling states (queued/blocked/…) are derived by SCH and not stored here.
pub enum TaskStatus { Draft, Ready, Running, Verifying, Done, Failed, Cancelled }
pub enum RiskLevel { Low, Medium, High }
pub struct MissionTask {
    pub id: String, pub mission_id: String, pub title: String, pub status: TaskStatus,
    pub priority: u8 /* 0..=9 */, pub risk: RiskLevel, pub assigned_agent_id: Option<String>,
    pub predicted_paths: Vec<String>, pub depends_on: Vec<String>,
}
pub enum VerificationKind { Command, Test, Build, Lint, Manual }
pub enum VerificationStatus { Running, Passed, Failed, Errored, Cancelled }
pub struct VerificationRun {
    pub id: String, pub spec_id: String, pub task_id: Option<String>, pub thread_id: Option<String>,
    pub status: VerificationStatus, pub exit_code: Option<i32>, pub started_at: String,
    pub finished_at: Option<String>, pub evidence: Vec<EvidenceRef>,
}
```

### 5.8 Scheduler — `scheduler.rs` (SCH)

```rust
pub enum SchedulerMode { Auto, Manual }
pub enum ScheduledState { Running, Queued, Blocked, Waiting, Conflicted }
pub enum SchedulerReason {
    DependencyIncomplete { task_id: String },
    FileClaimHeld { pattern: String, holder_task_id: String },
    WorktreeUnavailable { detail: String },
    ProviderConcurrency { provider_id: ProviderId, running: u32, limit: u32 },
    ProviderBackoff { provider_id: ProviderId, until: Option<String> },
    ResourcePressure { resource: ResourceKind, level: PressureLevel, mode: GovernorMode },
    WaitingForApproval { request_id: String },
    WaitingForUser { thread_id: String },
    ManualHold { by: String },
    ManualMode,
    LowerPriority { ahead: u32 },
    RiskRequiresConfirmation { risk: RiskLevel },
    ConflictDetected { with_task_id: String, paths: u32, confidence: Likelihood },
    KillSwitch,
}
pub struct TaskExplanation { pub task_id: String, pub state: ScheduledState, pub reasons: Vec<SchedulerReason>, pub since: String }
pub enum SchedulerOverride { ForceStart, Hold, SetPriority { priority: u8 }, IgnoreResourceLimits }
pub enum ClaimMode { Exclusive, Shared }
pub enum ClaimSource { Predicted, Observed, User }
pub struct FileClaim { pub id: String, pub task_id: String, pub pattern: String, pub mode: ClaimMode, pub source: ClaimSource }
```

### 5.9 Memory — `memory.rs` (MEM)

```rust
pub enum MemoryScope { Global, Workspace { workspace_id: String }, Agent { agent_id: String }, Mission { mission_id: String } }
pub enum MemoryKind { Fact, Decision, Convention, Preference, Warning }
pub enum MemoryStatus { Active, Stale, Contradicted, Ignored }
pub enum MemoryOrigin { User, Agent { agent_id: Option<String>, thread_id: String }, Autopsy { autopsy_id: String }, Import }
pub enum EvidenceRef {
    Event { event_id: String },
    File { workspace_id: String, display_path: String, sha256: String, start_line: Option<u32>, end_line: Option<u32> },
    Commit { workspace_id: String, oid: String },
    Verification { run_id: String },
    ThreadMessage { thread_id: String, message_id: String },
    UserStatement { at: String },
}
pub enum EvidenceState { Valid, Changed, Missing, Unchecked }
pub struct Evidence { pub id: String, pub reference: EvidenceRef, pub captured_at: String, pub checked_at: Option<String>, pub state: EvidenceState }
pub enum StaleReason { EvidenceChanged { evidence_id: String }, EvidenceMissing { evidence_id: String }, Expired { ttl_days: u32 }, Superseded { memory_id: String } }
pub struct MemoryRecord {
    pub id: String, pub scope: MemoryScope, pub kind: MemoryKind, pub subject: String, pub statement: String,
    pub status: MemoryStatus, pub pinned: bool, pub confidence: Confidence, pub origin: MemoryOrigin,
    pub evidence: Vec<Evidence>, pub stale_reason: Option<StaleReason>, pub conflicts_with: Vec<String>,
    pub created_at: String, pub updated_at: String, pub verified_at: Option<String>,
}
pub enum MemoryAction { Correct { statement: String }, Verify, Pin, Unpin, Ignore, Unignore, Delete }
```

### 5.10 Automations and notifications — `automations.rs` (AUT)

```rust
pub enum AutomationTrigger {
    Event { types: Vec<String>, filter: CorrelationFilter },
    Schedule { cron: String /* 5-field, local time */ },
    Manual,
}
pub enum AutomationCondition {
    WorkspaceIs { workspace_id: String },
    PayloadEquals { pointer: String /* JSON pointer into the payload */, value: String },
    ThreadStatusIn { statuses: Vec<ThreadStatus> },
    NoPendingApprovals,
    TimeWindow { start: String, end: String },
}
/// Templates may interpolate only typed ids/enums from the trigger (AUT-06).
pub enum AutomationAction {
    Notify { title: String, severity: Severity },
    CreateThread { provider_id: ProviderId, workspace_id: String, prompt_template: String, profile_id: Option<String> },
    SendToThread { thread_id: String, template: String },
    RunCommand { workspace_id: String, argv: Vec<String> },       // argv only, never a shell string
    CreateCheckpoint { workspace_id: String },
    PauseThreads { scope: crate::kalvoice::ThreadScope },
    RunVerification { spec_id: String },                         // phase 2 (Z10)
    StartTask { task_id: String },                               // phase 2 (Z9)
}
pub struct AutomationLimits { pub cooldown_secs: u32, pub max_runs_per_hour: u32, pub max_chain_depth: u8 /* ≤ 5 */, pub max_concurrent_runs: u8 }
pub struct Automation {
    pub id: String, pub name: String, pub enabled: bool, pub workspace_id: Option<String>, pub version: u32,
    pub trigger: AutomationTrigger, pub conditions: Vec<AutomationCondition>, pub actions: Vec<AutomationAction>,
    pub permission_mode: PermissionMode, pub custom_profile_id: Option<String>, pub bypass_confirmed: bool,
    pub verification_spec_id: Option<String>, pub notify_on: Vec<RunStatus>, pub limits: AutomationLimits,
}
pub enum RunStatus { Queued, Running, WaitingForApproval, Succeeded, Failed, SkippedCooldown, SkippedRateLimit, LoopPrevented, Killed, Cancelled }
pub enum Severity { Info, Warning, Critical }
pub struct Notification { pub id: String, pub kind: String, pub severity: Severity, pub title: String, pub body: String, pub entity_kind: Option<String>, pub entity_id: Option<String>, pub created_at: String, pub read_at: Option<String> }
```

### 5.11 Utility Dock — `utility.rs` (UD)

```rust
pub enum UtilityTool { ApiInspector, Json, Regex, Processes, Ports, Environment, Sqlite, ScratchTerminal, Scratchpad, Diff, EncodeHash }
pub enum ProcessOwner { KalCodeSelf, KalCodeProvider { thread_id: String }, KalCodeTerminal { terminal_id: String }, CurrentUser, OtherUser, System }
pub enum Killability { Confirm, NativeConfirm, Refused { reason: String } }
pub struct ProcessInfo { pub pid: u32, pub parent_pid: Option<u32>, pub name: String, pub cpu_percent: f32, pub memory_mb: u32, pub owner: ProcessOwner, pub killable: Killability }
pub struct ListeningPort { pub protocol: TransportProtocol, pub local_address: String, pub port: u16, pub pid: Option<u32>, pub process_name: Option<String> }
pub enum TransportProtocol { Tcp, Udp }
pub enum EnvSource { KalCodeProcess, Terminal { shell_id: String }, Provider { provider_id: ProviderId } }
pub struct EnvEntry { pub name: String, pub redacted: bool, pub hint: String /* e.g. "40 chars, looks like a token" */ }
pub struct SqliteHandle { pub id: String, pub display_name: String, pub tables: Vec<String> }
pub struct SqliteQueryResult { pub columns: Vec<String>, pub rows: Vec<Vec<SqliteCell>>, pub truncated: bool, pub elapsed_ms: u32 }
pub enum SqliteCell { Null, Integer { value: i64 }, Real { value: f64 }, Text { value: String }, Blob { bytes: u32 } }
pub struct HttpRequestSpec { pub method: String, pub url: String, pub headers: Vec<HttpHeader>, pub body: Option<String>, pub timeout_ms: u32, pub follow_redirects: bool }
pub struct HttpHeader { pub name: String, pub value: String, pub sensitive: bool }
pub struct HttpResponseView { pub status: u16, pub headers: Vec<HttpHeader>, pub body_preview: String, pub bytes: u64, pub elapsed_ms: u32, pub truncated: bool }
pub struct Scratchpad { pub id: String, pub title: String, pub content: String, pub workspace_id: Option<String>, pub updated_at: String }
```

(`SqliteCell::Real` holds `f64`, so that enum derives `PartialEq` but not `Eq`.)

---

## 6. Layer-2 and cross-cutting types

### 6.1 Provider Health + Capacity — `health.rs` (PH)

> **Adopted in PROVIDERS-2** (`crates/contracts/src/health.rs`), with these differences from the
> sketch below: `detection` is `Option<DetectionState>` (unknown before the first check);
> added `display_name`, `minimum_version`, `latency_samples`, `last_failure: Option<HealthFailure>`,
> `reason_code` (stable code) next to `reason` (copy), and `checked_at`; `HealthRollup` is the
> trend row (hourly, in memory until the v13 table lands). IPC `provider_health_list`,
> `provider_health_get`, `provider_health_trend` are implemented.

```rust
pub enum HealthState { Healthy, Degraded, Unavailable, Unknown }
pub enum CapacityState { Available, Saturated, BackingOff, Unknown }
pub enum Recoverability { None, Automatic, SignIn, Update, Install, Restart, Unknown }
pub struct ProviderHealth {
    pub provider_id: ProviderId,
    pub state: HealthState,
    pub detection: DetectionState, pub auth: AuthState, pub account_label: Option<String>,
    pub version: Option<String>, pub models: Vec<ModelInfo>,
    pub process_running: bool, pub active_sessions: u32,
    pub latency_p50_ms: Option<u32>, pub latency_p95_ms: Option<u32>,   // observed, rolling 15 min
    pub recent_failures: u32,                                          // rolling 60 min
    pub capacity: CapacityState,
    pub backoff_until: Option<String>,                                  // only when the provider reported it
    pub trend: HealthTrend, pub recoverability: Recoverability, pub reason: Option<String>,
    pub observed_at: String,
}
pub enum HealthTrend { Improving, Stable, Worsening, InsufficientData }
```

### 6.2 Provider Hot-Swap — `handoff.rs` (HS)

```rust
pub enum HandoffMode { Manual, Assisted, Automatic }
pub enum HandoffTrigger { User, HealthRecommendation { reason: String }, FailoverPolicy { reason: String } }
/// Only observable or reconstructable state. Every field is optional because it may not exist yet.
pub struct HandoffCapsule {
    pub id: String, pub from_thread_id: String, pub from_provider_id: ProviderId, pub to_provider_id: ProviderId,
    pub objective: Option<String>, pub request_message_id: Option<String>,
    pub mission_id: Option<String>, pub task_id: Option<String>, pub acceptance: Vec<String>,
    pub steps_done: Vec<String>, pub steps_remaining: Vec<String>, pub decisions: Vec<String>,
    pub workspace_id: String, pub branch: Option<String>, pub worktree_id: Option<String>,
    pub files_changed: Vec<FileRef>, pub diff_included: bool,
    pub verification_runs: Vec<String>, pub build_status: Option<VerificationStatus>,
    pub errors: Vec<String>,
    pub pending_approvals: Vec<String>,          // listed for the user; never transferred (K8)
    pub memory_ids: Vec<String>, pub context_package_id: String,
    pub summary: HandoffSummary,
    pub mode: HandoffMode, pub trigger: HandoffTrigger,
}
pub struct HandoffSummary { pub structured: String, pub model_written: Option<ModelWrittenSummary> }
pub struct ModelWrittenSummary { pub provider_id: ProviderId, pub text: String /* labelled as model-written */ }
```

### 6.3 Session Locator — `locator.rs` (LOC)

```rust
pub enum LocatorEntityKind { Thread, Workspace, RemoteWorkspace, Terminal, Provider, Agent, Mission, Task, Worktree, Automation, File, Command, Activity }
pub struct LocatorQuery {
    pub text: String,                               // never stored or logged
    pub kinds: Vec<LocatorEntityKind>, pub statuses: Vec<String>, pub provider_id: Option<ProviderId>,
    pub workspace_id: Option<String>, pub since: Option<String>, pub active_only: bool,
    pub sort: LocatorSort, pub page: PageRequest,
}
pub enum LocatorSort { Relevance, Recency }
pub struct LocatorResult {
    pub kind: LocatorEntityKind, pub entity_id: String, pub title: String, pub subtitle: Option<String>,
    pub status: Option<String>, pub workspace_id: Option<String>, pub updated_at: String,
    pub snippet: Option<String>,                    // redacted
    pub score: f32, pub semantic: bool,             // true only with the on-device model installed
}
```

### 6.4 Environment Doctor — `doctor.rs` (DOC)

```rust
pub enum DoctorArea { KalCode, Providers, DevTools, System, Project }
pub enum FindingSeverity { Info, Warning, Critical }
pub enum CheckOutcome { Passed, Finding, CouldNotCheck { reason: String } }
pub struct DoctorFinding {
    pub code: String, pub area: DoctorArea, pub severity: FindingSeverity, pub title: String,
    pub details: String, pub fixes: Vec<FixOption>, pub ignored: bool,
}
/// From a fixed catalog; each maps to typed ActionKinds evaluated by TK.
pub struct FixOption {
    pub fix_code: String, pub description: String, pub scopes: Vec<PermissionScope>,
    pub reversible: Reversibility, pub show_command_only: bool,
}
pub enum Reversibility { Reversible { how: String }, Checkpointed, NotReversible { why: String } }
pub struct DoctorRun { pub id: String, pub started_at: String, pub finished_at: Option<String>, pub checks: u32, pub findings: Vec<DoctorFinding> }
```

### 6.5 Workspace Blueprints — `blueprints.rs` (BP)

```rust
pub struct BlueprintDocument {
    pub schema_version: u32,
    pub layout: Option<serde_json::Value>,             // PC layout schema, versioned
    pub provider_panes: Vec<ProviderPanePreset>,
    pub profile_bindings: Vec<BlueprintProfileBinding>, // by profile *name*, resolved on apply
    pub permissions: Option<BlueprintPermissions>,
    pub terminal_presets: Vec<TerminalPreset>,
    pub panes: Vec<String>,                             // browser/git/utility pane ids (where built)
    pub mission: Option<serde_json::Value>, pub agent_team: Vec<String>,
    pub verification_defaults: Vec<String>, pub automation_hooks: Vec<String>,
    pub governor_mode: Option<GovernorMode>,
    pub credential_aliases: Vec<String>,                // labels only; never secrets or secret refs
}
pub struct BlueprintPermissions { pub default_mode: PermissionMode, pub custom_profile_name: Option<String> }
pub struct ProviderPanePreset { pub provider_id: ProviderId, pub count: u8 }
pub struct BlueprintProfileBinding { pub provider_id: ProviderId, pub profile_name: String }
pub struct TerminalPreset { pub shell_id: String, pub title: String }
pub struct Blueprint { pub id: String, pub name: String, pub version: u32, pub source: BlueprintSource, pub document: BlueprintDocument }
pub enum BlueprintSource { Local, Imported }
pub struct ApplyPreview { pub changes: Vec<String>, pub needs_confirmation: Vec<String>, pub unavailable_parts: Vec<String> }
```

(`BlueprintDocument` holds `serde_json::Value`, so it derives `PartialEq` without `Eq`; ts-rs
exports those fields as `unknown`.)

### 6.6 Process Continuity — `continuity.rs` (PC)

```rust
pub enum RecoveryLabel { Restorable, Reconnectable, Restartable, NotRecoverable }
pub enum RecoveryItemKind { Layout, Pane, Thread, ProviderSession, Terminal, RemoteSession, PendingApproval, Mission, BrowserPane, Worktree }
pub struct RecoveryItem {
    pub id: String, pub kind: RecoveryItemKind, pub label: RecoveryLabel,
    pub entity_id: String, pub title: String, pub explanation: String,
    pub last_command: Option<String>,            // display only; never executed
    pub actions: Vec<RecoveryAction>, pub interrupted_at: Option<String>,
}
pub enum RecoveryAction { Restore, Reconnect, Restart, Resume, Dismiss }
pub struct RecoveryInventory { pub session_interrupted: bool, pub items: Vec<RecoveryItem>, pub computed_at: String }
pub struct WorkspaceLayout { pub workspace_id: String, pub schema_version: u32, pub layout: serde_json::Value, pub updated_at: String }
```

### 6.7 Diff Intelligence and Blast Radius — `diffintel.rs` (DI/BR)

```rust
pub enum ActorKind { Provider, Agent, Human, Automation, Unknown }
pub enum AttributionConfidence { Exact, Likely, Unknown }
pub struct ChangeAttribution {
    pub file: FileRef, pub actor: ActorKind, pub provider_id: Option<ProviderId>, pub thread_id: Option<String>,
    pub agent_id: Option<String>, pub task_id: Option<String>, pub tool_call_id: Option<String>,
    pub confidence: AttributionConfidence, pub observed_at: String,
}
pub enum ChangeClass { Architecture, Behaviour, ApiContract, Dependency, Database, SecuritySensitive, Config, Tests, Docs, Generated }
pub struct ClassLabel { pub class: ChangeClass, pub likelihood: Likelihood, pub rule: String }
pub struct FileAnalysis { pub file: FileRef, pub classes: Vec<ClassLabel>, pub attribution: Vec<ChangeAttribution> }
pub struct Overlap { pub a: ChangeOwner, pub b: ChangeOwner, pub paths: Vec<FileRef>, pub likelihood: Likelihood }
pub enum ChangeOwner { Thread { thread_id: String }, Worktree { worktree_id: String }, Task { task_id: String }, Human }
pub enum ImpactReason { ImportsChanged { from: FileRef }, CoChangedHistorically { count: u32 }, TestCovers { test: FileRef }, ConfigOrBuild, Migration, PublicApi, Lockfile, CiPipeline }
pub struct ImpactedItem { pub file: FileRef, pub reasons: Vec<ImpactReason>, pub likelihood: Likelihood }
pub struct ImpactAnalysis { pub id: String, pub workspace_id: String, pub changed: u32, pub impacted: Page<ImpactedItem>, pub method_version: u32, pub computed_at: String }
```

### 6.8 Resource Governor — `resources.rs` (RG)

> **Adopted in CA-1, amended per `docs/campaigns/RG.md`:** `GovernorMode`,
> `CustomResourceLimits` (replaces `GovernorThresholds`), `GpuLimits`, tagged `Reading<T>`
> (`value | unavailable | unknown`), `ResourceSnapshot` with the readings the crate measures,
> `ResourcePressure { resource, level, signal, value, threshold, approaching }`,
> `PressureSummary`, `CapacityAdvice`, `ResourceHoldReason` (wire kinds `user_limit`,
> `provider_limit`, `pressure`, `cpu_headroom`, `memory_headroom`, `kalcode_memory_cap`,
> `gpu_limit`), `ResourceReleaseCause`. `Signal` and `Tiers` are exported to TypeScript as
> `PressureSignal` and `SamplingTiers`, `Constraint` as `CapacityConstraint`.

```rust
pub enum GovernorMode { Conservative, Balanced, Performance, Custom }
pub enum ResourceKind { Cpu, Memory, Gpu, Vram, DiskIo, DiskSpace, Network, ProcessCount }
pub enum PressureLevel { Normal, Elevated, High, Critical }
pub struct GovernorThresholds { pub cpu_percent: u8, pub memory_available_mb: u32, pub disk_free_mb: u32, pub max_provider_sessions: u8 }
pub struct ResourceSnapshot {
    pub cpu_percent: f32, pub memory_total_mb: u32, pub memory_available_mb: u32,
    pub gpu_percent: Option<f32>, pub vram_used_mb: Option<u32>,             // None = not exposed by the platform
    pub disk_read_kbps: u32, pub disk_write_kbps: u32, pub disk_free_mb: Vec<VolumeFree>,
    pub net_rx_kbps: u32, pub net_tx_kbps: u32, pub process_count: u32,
    pub kalcode_tree_cpu_percent: f32, pub kalcode_tree_memory_mb: u32,
    pub pressure: Vec<ResourcePressure>, pub sampled_at: String,
}
pub struct VolumeFree { pub workspace_id: Option<String>, pub free_mb: u32 }
pub struct ResourcePressure { pub resource: ResourceKind, pub level: PressureLevel }
```

(Float fields: `PartialEq` without `Eq`.)

### 6.9 Benchmark Lab and Failure Autopsy — `outcomes.rs` (BL/FA)

```rust
pub struct TaskOutcome {
    pub task_id: String, pub provider_id: ProviderId, pub model: Option<String>, pub profile_id: Option<String>,
    pub profile_version: Option<u32>, pub task_class: String, pub first_pass: bool, pub passed: bool,
    pub attempts: u32, pub duration_ms: u64, pub tool_failures: u32, pub regression: bool,
    pub handoffs: u32, pub cost_usd_micros: Option<u64>, pub finished_at: String,
}
pub struct RateEstimate { pub value: f32, pub low: f32, pub high: f32 /* Wilson interval */ }
pub struct BenchmarkCell {
    pub provider_id: ProviderId, pub model: Option<String>, pub task_class: String, pub n: u32,
    pub enough_data: bool,                           // n ≥ minimum (default 10)
    pub pass_rate: Option<RateEstimate>, pub first_pass_rate: Option<RateEstimate>,
    pub median_duration_ms: Option<u64>, pub retries_per_task: Option<f32>, pub regression_rate: Option<RateEstimate>,
    pub cost_median_usd_micros: Option<u64>,         // only if reported and display enabled
}
pub enum FindingCertainty { Confirmed, Likely, Unknown }
pub enum FindingSource { Deterministic, ProviderAssisted { provider_id: ProviderId } }
pub struct AutopsyFinding { pub certainty: FindingCertainty, pub likelihood: Option<Likelihood>, pub summary: String, pub evidence: Vec<EvidenceRef>, pub evidence_checked: bool, pub source: FindingSource }
pub enum AutopsySubject { Thread { thread_id: String }, Task { task_id: String }, Verification { run_id: String }, AutomationRun { run_id: String } }
pub struct Autopsy { pub id: String, pub subject: AutopsySubject, pub from_seq: i64, pub to_seq: i64, pub last_good_checkpoint_id: Option<String>, pub findings: Vec<AutopsyFinding> }
pub enum RemediationKind { Test, Skill, Rule, Memory }
pub enum RemediationStatus { Proposed, Accepted, Rejected, Applied, Unavailable { reason: String } }
pub struct RemediationProposal { pub id: String, pub autopsy_id: String, pub kind: RemediationKind, pub summary: String, pub status: RemediationStatus }
```

Invariant (enforced in code and by a CHECK): `certainty = Confirmed ⇒ evidence_checked = true`.

### 6.10 Z7 Workspace UX and provider panes — `workspace_ui.rs`, additions to `threads.rs` / `agent.rs`

> **Adopted in CA-1:** `ThreadRuntimeKind` and `ThreadSummary.runtimeKind` / `terminalId`,
> `DisplayStatus`, `DisplayQualifier`, `DashboardChip`, the mapping (`ThreadStatus::display`,
> `chip`) plus a `StatusTone` per display status, `StatusChannel`, `InteractiveSupport` and
> `ProviderCapabilities.interactive`, and the pane-layout schema (`PaneNode`, `SplitAxis`,
> `PaneContent`, `PaneLayout` with native `validate()`, `LayoutPreset`). `HomeSummary`, recent
> work, rail and notification types remain proposed.

```rust
// threads.rs — additive
pub enum ThreadRuntimeKind { Headless, InteractivePty }
pub struct ThreadSummary { /* existing … */ #[serde(default)] pub runtime_kind: Option<ThreadRuntimeKind>, #[serde(default)] pub terminal_id: Option<String> }

/// The 12 display statuses (ADVANCED.md §16.3). Derived only from ThreadStatus.
pub enum DisplayStatus { Starting, Working, Testing, Reviewing, PermissionRequired, WaitingForYou, Idle, Paused, Done, Failed, Recovering, Offline }
pub enum DisplayQualifier { WaitingOnDependency, StoppedResumable }
pub enum DashboardChip { All, WaitingForYou, Working, Done, Idle }
impl ThreadStatus {
    pub fn display(self) -> (DisplayStatus, Option<DisplayQualifier>);   // total, exhaustive, unit-tested
    pub fn chip(self) -> DashboardChip;
}

// agent.rs — additive: how a provider runs in a pane (PROVIDER_PANES.md §3–4)
pub enum StatusChannel { Hooks, Notify, Osc9, ProcessOnly }
pub struct InteractiveSupport {
    pub launch_mappings: Vec<PermissionMapping>,   // interactive column; never broader than the mode
    pub status_channels: Vec<StatusChannel>,
    pub kalcode_answers_approvals: bool,           // false ⇒ approvals answered in the provider's prompt
    pub resume: Option<String>,                    // display form, e.g. "claude --resume <id>"
}
// ProviderCapabilities { …, #[serde(default)] interactive: Option<InteractiveSupport> }

// workspace_ui.rs
pub struct HomeSummary {
    pub greeting: String,                          // chosen natively from the pool; never repeats the last 5
    pub display_name: Option<String>,              // Settings `profile.displayName`; None ⇒ "Welcome back."
    pub last_session: Vec<RecentWorkItem>,         // what was I working on
    pub running: u32, pub needs_you: u32,
    pub finished_since_last_visit: Vec<String>,    // thread ids
    pub resumable: Vec<String>,                    // recovery item ids (PC)
}
pub enum RecentWorkKind { Thread, File, Workspace }
pub struct RecentWorkItem { pub kind: RecentWorkKind, pub id: String, pub title: String, pub workspace_id: Option<String>, pub last_activity_at: String }
pub enum RecentWorkWhen { Today, Yesterday, ThisWeek }

pub struct WorkspaceGroup { pub id: String, pub name: String, pub position: u32, pub collapsed: bool }
pub struct ProviderRow { pub provider_id: ProviderId, pub provider_name: String, pub threads: u32, pub working: u32, pub needs_you: u32 }
pub struct WorkspaceRailEntry {
    pub workspace_id: String, pub name: String, pub location: String /* local | ssh */, pub available: bool,
    pub pinned: bool, pub archived: bool, pub group_id: Option<String>, pub collapsed: bool,
    pub providers: Vec<ProviderRow>, pub working: u32, pub needs_you: u32, pub last_opened_at: String,
}
pub struct RailState { pub pinned: Vec<WorkspaceRailEntry>, pub recent: Vec<WorkspaceRailEntry>, pub groups: Vec<(WorkspaceGroup, Vec<WorkspaceRailEntry>)> }

/// Versioned pane tree (validated natively; unknown leaves render as unavailable).
pub enum PaneNode {
    Split { axis: SplitAxis, ratios: Vec<u16> /* per-mille, sum 1000 */, children: Vec<PaneNode> },
    Leaf { pane_id: String, tabs: Vec<PaneContent>, active_tab: u32, collapsed: bool },
}
pub enum SplitAxis { Horizontal, Vertical }
pub enum PaneContent {
    Thread { thread_id: String }, Terminal { terminal_id: String }, Dashboard,
    Widget { widget_id: String }, Browser { url: Option<String> } /* Z6b */, Git { workspace_id: String } /* Z6b */,
}
pub struct PaneLayout { pub schema_version: u32, pub root: PaneNode, pub maximized_pane_id: Option<String>, pub dock: Vec<PaneContent> }
pub enum LayoutPreset { Two, Three, Four, Six, Custom { preset_id: String } }

pub enum NotificationKind { ThreadCompleted, ThreadFailed, PermissionRequired, MissionDone, ProviderDisconnected, RecoveryAvailable, AutomationFinished, DoctorFinding, HealthChanged }
```

`profile.displayName` is a new typed key in the Z0 `settings` table (1–60 characters, no control
characters, empty = unset). It persists through `settings_update` and emits `settings.changed`,
like every setting. No OS account name is read.

---

## 7. IPC commands (proposed)

All commands validate ids with `is_valid_id`, take file **handles** (never paths), page every
list (`limit ≤ 500`), and run off the main thread. Consequential commands call
`TrustKernel::evaluate` with the right origin. "NC" marks actions that need a native confirmation
(K10).

| Command | Owner | Input | Output |
| --- | --- | --- | --- |
| `events_query` | L-1 | `EventQuery` | `EventPage` |
| `trust_explain` | TK | `{ actionId }` | `DecisionExplanation` |
| `trust_action_log` | TK | `{ threadId?, originKind?, page }` | `Page<ActionLogEntry>` |
| `provider_health_list` / `provider_health_get` | PH | — / `{ providerId }` | `ProviderHealth[]` / `ProviderHealth` |
| `provider_health_trend` | PH | `{ providerId, hours ≤ 720 }` | rollups |
| `provider_profile_list` / `_get` / `_create` / `_update` / `_archive` | PP | `{ providerId? }` / `{ id }` / `{ providerId, name, settings }` / `{ id, settings, name? }` / `{ id }` | `ProviderProfile[]` / `ProviderProfile` |
| `provider_profile_descriptors` | PP | `{ providerId }` | `ProfileSettingDescriptor[]` |
| `provider_profile_bind` / `_resolve` | PP | `ProfileBinding` (or `profileId: null` to clear) / `{ providerId, workspaceId?, agentId?, missionId?, threadId? }` | `ProfileBinding` / `ResolvedProfile` |
| `context_package_create` | CTX | `{ purpose, targetThreadId?, targetProviderId?, items: ContextItemSource[] }` | `ContextPreview` |
| `context_package_update` | CTX | `{ packageId, include: {position, included}[] , confirmOverrides?: position[] }` | `ContextPreview` |
| `context_package_send` | CTX | `{ packageId, contentSha256, message? }` | `ThreadSummary` |
| `context_package_discard` | CTX | `{ packageId }` | — |
| `context_never_share_list` / `_set` | FW | `{ workspaceId? }` / `{ workspaceId?, patterns[] }` | patterns |
| `files_list` | Z6a | `{ workspaceId, dir?: FileHandle, page }` | `Page<FileEntry>` |
| `git_status` / `git_diff` / `git_log` | Z6a | `{ workspaceId, worktreeId? }` / `+ { base?, file?: FileHandle }` / `{ workspaceId, page }` | summaries |
| `worktree_list` / `worktree_create` / `worktree_remove` | Z6a | `{ workspaceId }` / `{ workspaceId, branch, purpose }` / `{ worktreeId }` | `Worktree` |
| `checkpoint_list` / `checkpoint_create` / `checkpoint_pin` | Z6a | `{ workspaceId, page }` / `{ workspaceId }` / `{ checkpointId, pinned }` | `Checkpoint` |
| `timeline_page` | TM | `{ workspaceId?, threadId?, missionId?, cursor?, limit ≤ 200 }` | `Page<TimelineNode>` |
| `timeline_restore_plan` / `timeline_restore_execute` (NC) | TM | `{ checkpointId, kind }` / `{ planId }` | `RestorePlan` / restore id |
| `timeline_branch` | TM | `{ checkpointId, name, worktree: bool }` | `Worktree` or branch |
| `timeline_replay_plan` / `timeline_replay_run` | TM | `{ fromSeq, toSeq, workspaceId }` / `{ replayId, stepIds[] }` | `ReplayStep[]` / replay id |
| `remote_host_list` / `_create` / `_update` / `_remove` | RW | — / host fields (key via native picker) | `RemoteHost` |
| `remote_connect` / `remote_disconnect` | RW | `{ hostId }` | `RemoteHost` |
| `remote_host_key_decide` (NC) | RW | `{ hostId, fingerprint, decision: trust\|reject }` | `RemoteHost` |
| `remote_workspace_open` | RW | `{ hostId, remotePath }` (validated, contained after `realpath`) | `Workspace` |
| `agent_list` / `_create` / `_update` / `_retire` | Z8 | … | `AgentDefinition` |
| `agent_relationship_set` / `_remove` | ORG | `AgentRelationship` / `{ id }` | — |
| `delegation_contract_list` / `_create` / `_revoke` | ORG | … | `DelegationContract` |
| `delegation_list` / `agent_graph` | ORG | `{ agentId?, status?, page }` / `{ rootAgentId?, depth ≤ 4, limit ≤ 500 }` | `Page<Delegation>` / `GraphSlice` |
| `mission_*`, `task_*`, `task_graph` | Z9 | … | `Mission`, `MissionTask`, `GraphSlice` |
| `verification_spec_*`, `verification_run`, `verification_runs` | Z10 | … | `VerificationRun` |
| `scheduler_state` / `scheduler_explain` | SCH | `{ missionId?, page }` / `{ taskId }` | `Page<TaskExplanation>` / `TaskExplanation` |
| `scheduler_set_mode` / `scheduler_override` / `scheduler_clear_override` | SCH | `{ mode }` / `{ taskId, override, expiresAt? }` / `{ overrideId }` | — |
| `memory_list` / `memory_get` / `memory_search` | MEM | `{ scope?, status?, page }` / `{ id }` / `{ text, scope?, page }` | `MemoryRecord` |
| `memory_create` / `memory_act` | MEM | `{ scope, kind, subject, statement, evidence[] }` / `{ id, action: MemoryAction }` | `MemoryRecord` |
| `automation_list` / `_get` / `_save` / `_set_enabled` / `_delete` / `automation_runs` | AUT | … | `Automation`, `Page<AutomationRun>` |
| `automation_kill_switch` (NC when disengaging) | AUT | `{ engaged }` | state |
| `notification_list` / `notification_mark` | Z7-W3 | `{ unreadOnly?, page }` / `{ ids, read\|dismissed }` | `Page<Notification>` |
| `utility_processes` / `utility_ports` | UD (via RG) | `{ page }` | `Page<ProcessInfo>` / `Page<ListeningPort>` |
| `utility_process_signal` (NC for non-KalCode) | UD | `{ pid, signal }` | — |
| `utility_env_list` / `utility_env_reveal` (NC) | UD | `{ source }` / `{ source, name }` | `EnvEntry[]` / value |
| `utility_sqlite_open` (native picker) / `_query` / `_close` | UD | — / `{ handleId, sql, page }` / `{ handleId }` | `SqliteHandle` / `SqliteQueryResult` |
| `utility_http_send` (NC on new host) | UD | `HttpRequestSpec` | `HttpResponseView` |
| `utility_scratchpad_*` | UD | … | `Scratchpad` |
| `utility_scratch_terminal` | UD (Z1 PTY) | `{ workspaceId? }` | `TerminalInfo` |
| `resource_snapshot` / `resource_subscribe` | RG | — / channel | `ResourceSnapshot` / stream |
| `resource_mode_get` / `resource_mode_set` | RG | — / `{ mode, custom?: GovernorThresholds }` | mode |
| `diff_analyze` / `diff_attribution` / `diff_overlaps` | DI | `{ workspaceId, worktreeId?, base? }` / `{ file: FileHandle }` / `{ workspaceId }` | `FileAnalysis[]` / `ChangeAttribution[]` / `Overlap[]` |
| `impact_analyze` / `impact_get` | BR | `{ workspaceId, worktreeId?, base? }` / `{ analysisId, page }` | `ImpactAnalysis` |
| `handoff_prepare` / `handoff_execute` / `handoff_list` | HS | `{ threadId, toProviderId, includeModelSummary }` / `{ capsuleId, contentSha256 }` / `{ threadId?, page }` | `HandoffCapsule + ContextPreview` / `ThreadSummary` |
| `locator_search` | LOC (Z7-W2) | `LocatorQuery` | `Page<LocatorResult>` |
| `locator_open` | LOC (Z7-W2) | `{ kind, entityId, via }` | navigation target (emits `session.located`) |
| `doctor_run` / `doctor_cancel` / `doctor_last` | DOC | `{ areas? }` / `{ runId }` / — | `DoctorRun` |
| `doctor_fix` / `doctor_revert` / `doctor_ignore` | DOC | `{ findingCode, fixCode }` / `{ fixLogId }` / `{ findingCode, scope, ignored }` | result |
| `blueprint_list` / `_get` / `_save` / `_save_current` / `_delete` | BP | … | `Blueprint` |
| `blueprint_apply_preview` / `blueprint_apply` | BP | `{ blueprintId, workspaceId }` / `{ previewId, confirmations[] }` | `ApplyPreview` / result |
| `blueprint_export` (native save) / `blueprint_import` (native open) | BP | `{ blueprintId }` / — | — / `Blueprint` + `ApplyPreview` |
| `continuity_inventory` / `continuity_act` | PC (Z7-W4) | — / `{ itemId, action }` | `RecoveryInventory` / `RecoveryItem` |
| `layout_get` / `layout_save` / `layout_presets` | Z7-W1 | `{ workspaceId }` / `{ workspaceId, layout }` (validated schema) | `WorkspaceLayout` |
| `benchmark_cells` | BL | `{ taskClass?, providerId?, page }` | `Page<BenchmarkCell>` |
| `autopsy_create` / `autopsy_get` / `remediation_decide` | FA | `{ subject }` / `{ id }` / `{ proposalId, accept }` | `Autopsy` / `RemediationProposal` |
| `command_center_overview` | CC | — | counts per panel (reads other systems' APIs) |
| `home_summary` | Z7-W2 | — | `HomeSummary` (derived; marks the visit watermark) |
| `recent_work` | Z7-W2 | `{ when: RecentWorkWhen, page }` | `Page<RecentWorkItem>` |
| `rail_state` | Z7-W2 | — | `RailState` |
| `rail_update` | Z7-W2 | `{ workspaceId, pinned?, groupId?, position?, collapsed?, archived? }` | `WorkspaceRailEntry` |
| `rail_group_create` / `_rename` / `_delete` / `_reorder` | Z7-W2 | `{ name }` / `{ id, name }` / `{ id }` / `{ ids[] }` | `WorkspaceGroup` |
| `workspace_reveal` | Z7-W2 | `{ workspaceId }` | — (native opens the OS file manager) |
| `workspace_clone` | Z7-W2 (via Z6a, TK) | `{ url, parentDir: native picker }` | `Workspace` |
| `dashboard_view` | Z7-W3 | `{ chip, groupBy: status\|project\|provider\|agent\|mission, page }` | `Page<ThreadSummary>` + counts per chip |
| `widget_list` / `widget_set` | Z7-W3 | — / `{ widgetId, placement?, enabled }` | widget registry state |
| `provider_pane_create` | Z7-W4 | `{ providerId, workspaceId, model?, permissionMode, name? }` | `ThreadSummary` (runtime `interactive_pty`, with `terminalId`) |
| `provider_pane_attach` | Z7-W4 | `{ threadId }` + channel | PTY stream (Z1 attach semantics) |

---

## 8. KalVoice intents (additive to `KalVoiceIntent`)

> **Adopted in CA-1 (the Z12 request, a different set from the sketch below):** `Split { axis }`,
> `Resize { direction: PaneDirection, steps }`, `Focus { query }`, `Search { query }`,
> `Close { query? }`, `SwitchProvider { providerId }`, `RequestPermissionMode { mode:
> RequestableMode, threadQuery? }` (no Bypass value exists). The intents below remain proposed.

All are deterministic (no model). Safety asymmetry (KV-02): intents marked **P** open a
preview or confirmation in the UI instead of executing directly.

```rust
pub enum KalVoiceIntent {
    // … existing 11 …
    FindSession { query: String, kind: Option<LocatorEntityKind> },          // LOC ("find the thread about OAuth")
    ShowProviderHealth { provider_id: Option<ProviderId> },                   // PH
    RunDoctor,                                                                 // DOC (read-only run)
    ShowRecovery,                                                              // PC
    ExplainBlock { thread_id: Option<String> },                               // TK ("why was that blocked?")
    ExplainTask { query: String },                                            // SCH ("why is the login task waiting?")
    HoldTask { query: String }, ReleaseTask { query: String },                // SCH (hold = safer; release is P when it overrides)
    SetSchedulerMode { mode: SchedulerMode },                                 // SCH (auto is P)
    ShowTimeline { scope: ThreadScope },                                      // TM
    CreateCheckpoint { workspace_id: Option<String> },                        // TM
    OpenRestore { query: String },                                            // TM — P (never restores by voice)
    ConnectRemote { query: String }, DisconnectRemote { query: String },      // RW (host-key trust never by voice)
    ApplyProfile { query: String, scope: ProfileScopeKind },                  // PP — P
    AttachContext { what: ContextShortcut, thread_query: Option<String> },    // CTX — P (preview always)
    HandoffThread { thread_query: String, to_provider_id: ProviderId },       // HS — P
    ShowMemory { query: String }, PinMemory { query: String }, ForgetMemory { query: String }, // MEM (forget is P)
    AutomationsKillSwitch { engaged: bool },                                  // AUT (engage direct; disengage P)
    ShowAutomationRuns { query: Option<String> },                             // AUT
    OpenUtility { tool: UtilityTool },                                        // UD
    ShowChanges { scope: ThreadScope }, WhoChanged { file_query: String },    // DI
    AnalyzeImpact { workspace_id: Option<String> },                           // BR
    SetResourceMode { mode: GovernorMode },                                   // RG
    ShowResources,                                                             // RG
    SaveBlueprint { name: String }, ApplyBlueprint { query: String },         // BP (apply is P)
    ShowBenchmarks { task_class: Option<String> },                            // BL
    ExplainFailure { query: String },                                         // FA
    ShowAgentGraph, DelegationStatus { query: Option<String> },               // ORG
    FilterDashboard { chip: DashboardChip },                                  // Z7 ("show what's waiting for me")
    ShowCompleted,                                                             // Z7
    RecentWork { when: RecentWorkWhen },                                      // Z7 ("what was I working on yesterday")
    SplitPane { axis: SplitAxis }, MaximizePane, RestorePanes,                // Z7 (layout only; never closes processes)
    ResizePane { direction: PaneDirection, steps: u8 },                       // Z7
    ApplyLayoutPreset { preset: LayoutPreset },                               // Z7
    NewProviderPane { provider_id: ProviderId, workspace_id: Option<String> },// Z7 (real CLI in a pane)
}
pub enum PaneDirection { Left, Right, Up, Down }
pub enum ContextShortcut { CurrentFile, Selection, TerminalOutput, CurrentDiff }
```

`SurfaceId` gains `CommandCenter` (one new top-level surface). `Navigate` covers it.

---

## 9. Normalized data model (proposed SQL sketches)

Conventions as in existing migrations: `STRICT` tables, TEXT UUIDv7 ids, RFC 3339 times, JSON in
`TEXT CHECK (json_valid(…))`, append-only logs protected by triggers, no secrets (only
`secret_ref`). **No FK to a table from a later-numbered or not-yet-merged migration.** Ids of
other systems' entities are stored without an FK and resolved through that system's API (the
pattern Z3 and Z4 already use).

```sql
-- v6 (L-1): events correlation
ALTER TABLE events ADD COLUMN agent_id TEXT;
ALTER TABLE events ADD COLUMN task_id TEXT;
ALTER TABLE events ADD COLUMN automation_id TEXT;
ALTER TABLE events ADD COLUMN causation_id TEXT;
CREATE INDEX events_agent_id_idx      ON events (agent_id)      WHERE agent_id IS NOT NULL;
CREATE INDEX events_task_id_idx       ON events (task_id)       WHERE task_id IS NOT NULL;
CREATE INDEX events_automation_id_idx ON events (automation_id) WHERE automation_id IS NOT NULL;
CREATE INDEX events_causation_id_idx  ON events (causation_id)  WHERE causation_id IS NOT NULL;
-- Existing single-column indexes carry the rowid (= seq), so (column, seq) range scans need no new index.

-- v7 (Z6a, P0): worktrees and checkpoints (the checkpoint objects live in the shadow repository)
CREATE TABLE git_worktrees (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE, -- native, under app-data
  branch TEXT NOT NULL, base_commit TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('task','thread','branch_from_checkpoint','user')),
  owner_ref TEXT, status TEXT NOT NULL CHECK (status IN ('active','merged','abandoned','removed')),
  created_at TEXT NOT NULL, removed_at TEXT) STRICT;
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, commit_oid TEXT NOT NULL, parent_id TEXT,
  trigger TEXT NOT NULL CHECK (json_valid(trigger)), event_seq INTEGER NOT NULL,
  files INTEGER NOT NULL, bytes_added INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, pruned_at TEXT) STRICT;
CREATE INDEX checkpoints_workspace_idx ON checkpoints (workspace_id, created_at DESC) WHERE pruned_at IS NULL;

-- v8 (CTX/FW, P0): context packages and firewall
CREATE TABLE context_packages (
  id TEXT PRIMARY KEY, workspace_id TEXT, purpose TEXT NOT NULL CHECK (purpose IN
    ('drop','handoff','memory','automation','delegation','reasoning')),
  target_thread_id TEXT, target_provider_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('previewed','sent','discarded','blocked')),
  content_sha256 TEXT NOT NULL, total_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL, sent_at TEXT) STRICT;
CREATE TABLE context_items (                          -- references only; content is re-read and re-hashed at send
  package_id TEXT NOT NULL REFERENCES context_packages (id) ON DELETE CASCADE,
  position INTEGER NOT NULL, source TEXT NOT NULL CHECK (json_valid(source)),
  bytes INTEGER NOT NULL, sensitivity TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('allow','redact','block')),
  redactions INTEGER NOT NULL DEFAULT 0, included INTEGER NOT NULL CHECK (included IN (0,1)),
  PRIMARY KEY (package_id, position)) STRICT;
CREATE TABLE context_firewall_log (                   -- append-only (no UPDATE/DELETE triggers)
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, occurred_at TEXT NOT NULL,
  package_id TEXT NOT NULL, position INTEGER, rule TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('blocked','redacted','overridden_by_user','warned')),
  detail TEXT NOT NULL CHECK (json_valid(detail))) STRICT;
CREATE TABLE context_never_share (
  scope_id TEXT NOT NULL DEFAULT '',                   -- '' = all workspaces, else workspace id
  pattern TEXT NOT NULL, sensitivity TEXT NOT NULL CHECK (sensitivity IN ('confidential','secret')),
  created_at TEXT NOT NULL, PRIMARY KEY (scope_id, pattern)) STRICT;

-- v9 (Z7-W1): layout store (one per workspace; presets are user-saved layouts)
CREATE TABLE workspace_layouts (workspace_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL,
  layout TEXT NOT NULL CHECK (json_valid(layout)), updated_at TEXT NOT NULL) STRICT;
CREATE TABLE layout_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL,
  layout TEXT NOT NULL CHECK (json_valid(layout)), builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  created_at TEXT NOT NULL) STRICT;

-- v10 (Z7-W2): workspace rail (Z1 keeps `workspaces`; rail state is separate) and locator index (derived, rebuildable)
CREATE TABLE workspace_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  position INTEGER NOT NULL, collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0,1)), created_at TEXT NOT NULL) STRICT;
CREATE TABLE workspace_rail (workspace_id TEXT PRIMARY KEY,   -- id of a `workspaces` row, resolved through Z1's API
  group_id TEXT REFERENCES workspace_groups (id) ON DELETE SET NULL, pinned_at TEXT, archived_at TEXT,
  position INTEGER, collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0,1)), updated_at TEXT NOT NULL) STRICT;
CREATE INDEX workspace_rail_pinned_idx ON workspace_rail (pinned_at) WHERE pinned_at IS NOT NULL;
CREATE TABLE locator_entries (
  rowid INTEGER PRIMARY KEY, entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  workspace_id TEXT, provider_id TEXT, title TEXT NOT NULL, subtitle TEXT, status TEXT,
  updated_at TEXT NOT NULL, UNIQUE (entity_kind, entity_id)) STRICT;
CREATE INDEX locator_entries_recency_idx ON locator_entries (updated_at DESC);
CREATE VIRTUAL TABLE locator_fts USING fts5(title, subtitle, body, content='', tokenize='trigram');
-- contentless: snippets come from the source entity through the redactor; `body` only with per-workspace opt-in

-- v11 (Z7-W3): notification center, used by every system
CREATE TABLE notifications (id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  title TEXT NOT NULL, body TEXT NOT NULL, entity_kind TEXT, entity_id TEXT,
  created_at TEXT NOT NULL, read_at TEXT, dismissed_at TEXT) STRICT;
CREATE INDEX notifications_unread_idx ON notifications (created_at DESC) WHERE read_at IS NULL;

-- v12 (lead: TK-1 + thread runtime extensions)
CREATE TABLE permission_action_log (                  -- non-read evaluations; UPDATE refused; retention job deletes > 90 days
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, occurred_at TEXT NOT NULL,
  origin_kind TEXT NOT NULL, origin_id TEXT, thread_id TEXT, workspace_id TEXT, host_id TEXT,
  action TEXT NOT NULL CHECK (json_valid(action)),     -- NormalizedAction, summary/command redacted
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  effect TEXT NOT NULL CHECK (effect IN ('allow','ask','deny')),
  invariants TEXT CHECK (invariants IS NULL OR json_valid(invariants)),
  ceiling_id TEXT, native_confirmed_at TEXT, fingerprint TEXT) STRICT;
CREATE INDEX permission_action_log_thread_idx ON permission_action_log (thread_id, seq) WHERE thread_id IS NOT NULL;
ALTER TABLE threads ADD COLUMN origin_kind TEXT NOT NULL DEFAULT 'user'
  CHECK (origin_kind IN ('user','kalvoice','agent','delegation','task','automation_run','handoff'));
ALTER TABLE threads ADD COLUMN origin_id TEXT;
ALTER TABLE threads ADD COLUMN agent_id TEXT;
ALTER TABLE threads ADD COLUMN task_id TEXT;
ALTER TABLE threads ADD COLUMN worktree_id TEXT;
ALTER TABLE threads ADD COLUMN profile_id TEXT;
ALTER TABLE threads ADD COLUMN profile_version INTEGER;
ALTER TABLE threads ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'headless'
  CHECK (runtime_kind IN ('headless','interactive_pty'));   -- provider panes (PROVIDER_PANES.md)
ALTER TABLE threads ADD COLUMN terminal_id TEXT;              -- the Z1 PTY hosting an interactive session
CREATE INDEX threads_agent_idx ON threads (agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX threads_task_idx  ON threads (task_id)  WHERE task_id IS NOT NULL;

-- v13 (PP + PH, P2): provider profiles and health trend
CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (provider_id, name)) STRICT;
CREATE TABLE provider_profile_versions (             -- immutable (trigger); threads pin a version
  profile_id TEXT NOT NULL REFERENCES provider_profiles (id),
  version INTEGER NOT NULL, settings TEXT NOT NULL CHECK (json_valid(settings)),
  created_at TEXT NOT NULL, PRIMARY KEY (profile_id, version)) STRICT;
CREATE TABLE provider_profile_bindings (              -- one table for all five levels
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','workspace','agent','mission','thread')),
  scope_id TEXT NOT NULL DEFAULT '',                   -- '' for global
  provider_id TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES provider_profiles (id),
  failover TEXT CHECK (failover IS NULL OR json_valid(failover)),   -- FailoverPolicy (HS); global/workspace only
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, provider_id),
  CHECK ((scope_kind = 'global') = (scope_id = ''))) STRICT;
CREATE TABLE provider_health_rollups (                -- hourly buckets, pruned after 30 days
  provider_id TEXT NOT NULL, hour_start TEXT NOT NULL,
  sessions_started INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
  backoffs INTEGER NOT NULL DEFAULT 0, latency_p50_ms INTEGER, latency_p95_ms INTEGER,
  samples INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (provider_id, hour_start)) STRICT;

-- v14 (UD, P2): utility dock (resource samples are never stored; governor mode is a setting)
CREATE TABLE scratchpads (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT NOT NULL,
  content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE http_saved_requests (                    -- sensitive header values → secret_ref, never inline
  id TEXT PRIMARY KEY, name TEXT NOT NULL, method TEXT NOT NULL, url TEXT NOT NULL,
  headers TEXT NOT NULL CHECK (json_valid(headers)), body TEXT, created_at TEXT NOT NULL) STRICT;

-- v15 (TM, P2): time machine operations
CREATE TABLE restore_operations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('files','new_branch','new_worktree','reset_branch')),
  safety_checkpoint_id TEXT, plan_summary TEXT NOT NULL CHECK (json_valid(plan_summary)),
  status TEXT NOT NULL CHECK (status IN ('planned','running','completed','failed','cancelled')),
  native_confirmed_at TEXT, started_at TEXT, finished_at TEXT, error_code TEXT,
  CHECK (kind IN ('new_branch','new_worktree') OR status = 'planned' OR safety_checkpoint_id IS NOT NULL)) STRICT;
CREATE TABLE replay_runs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL,
  steps_total INTEGER NOT NULL, steps_done INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running','completed','stopped','failed')),
  created_at TEXT NOT NULL, finished_at TEXT) STRICT;

-- v16 (DOC, P2): environment doctor
CREATE TABLE doctor_ignores (finding_code TEXT NOT NULL, scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','workspace')),
  scope_id TEXT NOT NULL DEFAULT '', ignored_at TEXT NOT NULL, PRIMARY KEY (finding_code, scope_kind, scope_id)) STRICT;
CREATE TABLE doctor_fix_log (id TEXT PRIMARY KEY, finding_code TEXT NOT NULL, fix_code TEXT NOT NULL, workspace_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('applied','failed','reverted')),
  undo TEXT CHECK (undo IS NULL OR json_valid(undo)), checkpoint_id TEXT, action_log_id TEXT,
  applied_at TEXT NOT NULL, reverted_at TEXT) STRICT;

-- v17 (Z8 + ORG, P3): agents and organization
CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', default_provider_id TEXT, default_profile_id TEXT,
  default_mode TEXT NOT NULL CHECK (default_mode IN ('plan','approve','auto','custom')), -- never bypass
  custom_profile_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retired_at TEXT) STRICT;
CREATE TABLE agent_relationships (id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL REFERENCES agents (id), to_agent_id TEXT NOT NULL REFERENCES agents (id),
  kind TEXT NOT NULL CHECK (kind IN ('reports_to','delegates_to','reviews','peer')),
  created_at TEXT NOT NULL, UNIQUE (from_agent_id, to_agent_id, kind),
  CHECK (from_agent_id <> to_agent_id)) STRICT;
CREATE TABLE delegation_contracts (                   -- immutable rows; edits create a new id with supersedes_id
  id TEXT PRIMARY KEY, supersedes_id TEXT REFERENCES delegation_contracts (id),
  delegator_agent_id TEXT NOT NULL REFERENCES agents (id), delegate_agent_id TEXT NOT NULL REFERENCES agents (id),
  may TEXT NOT NULL CHECK (json_valid(may)), may_not TEXT NOT NULL CHECK (json_valid(may_not)),
  max_depth INTEGER NOT NULL CHECK (max_depth BETWEEN 1 AND 5), may_redelegate INTEGER NOT NULL CHECK (may_redelegate IN (0,1)),
  max_duration_secs INTEGER, allowed_providers TEXT NOT NULL CHECK (json_valid(allowed_providers)),
  created_at TEXT NOT NULL, revoked_at TEXT, revoke_reason TEXT,
  CHECK (delegator_agent_id <> delegate_agent_id)) STRICT;
CREATE TABLE delegations (
  id TEXT PRIMARY KEY, contract_id TEXT NOT NULL REFERENCES delegation_contracts (id),
  parent_delegation_id TEXT REFERENCES delegations (id), root_delegation_id TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 5), path TEXT NOT NULL CHECK (json_valid(path)),
  delegator_thread_id TEXT NOT NULL, delegate_thread_id TEXT, ceiling TEXT NOT NULL CHECK (json_valid(ceiling)),
  status TEXT NOT NULL CHECK (status IN ('pending','active','completed','failed','refused','revoked')),
  refusal TEXT, created_at TEXT NOT NULL, finished_at TEXT) STRICT;
CREATE INDEX delegations_root_idx ON delegations (root_delegation_id);

-- v18 (Z9, P3): missions
CREATE TABLE missions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
  goal TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('draft','active','paused','completed','failed','cancelled')),
  scope TEXT NOT NULL CHECK (json_valid(scope)), acceptance TEXT NOT NULL CHECK (json_valid(acceptance)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT) STRICT;
CREATE TABLE mission_tasks (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft','ready','running','verifying','done','failed','cancelled')),
  priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 0 AND 9),
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')), assigned_agent_id TEXT,
  predicted_paths TEXT NOT NULL CHECK (json_valid(predicted_paths)),
  acceptance TEXT NOT NULL CHECK (json_valid(acceptance)), task_class TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE task_dependencies (task_id TEXT NOT NULL REFERENCES mission_tasks (id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES mission_tasks (id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id), CHECK (task_id <> depends_on_task_id)) STRICT;
CREATE TABLE task_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES mission_tasks (id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL, thread_id TEXT, provider_id TEXT, started_at TEXT NOT NULL, finished_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('done','failed','cancelled','handed_off')),
  UNIQUE (task_id, attempt)) STRICT;

-- v19 (Z10, P3): verification (large logs live as bounded files in app-data)
CREATE TABLE verification_specs (id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace','mission','task')), scope_id TEXT NOT NULL,
  name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('command','test','build','lint','manual')),
  argv TEXT NOT NULL CHECK (json_valid(argv)), cwd_rel TEXT NOT NULL DEFAULT '', timeout_secs INTEGER NOT NULL,
  created_at TEXT NOT NULL) STRICT;
CREATE TABLE verification_runs (id TEXT PRIMARY KEY, spec_id TEXT NOT NULL REFERENCES verification_specs (id),
  task_id TEXT, thread_id TEXT, workspace_id TEXT NOT NULL, worktree_id TEXT, checkpoint_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','passed','failed','errored','cancelled')),
  exit_code INTEGER, summary TEXT, started_at TEXT NOT NULL, finished_at TEXT) STRICT;
CREATE INDEX verification_runs_task_idx ON verification_runs (task_id, started_at) WHERE task_id IS NOT NULL;
CREATE TABLE verification_evidence (run_id TEXT NOT NULL REFERENCES verification_runs (id) ON DELETE CASCADE,
  position INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('log_excerpt','report','file_hash','exit_code')),
  ref TEXT NOT NULL, sha256 TEXT, bytes INTEGER, PRIMARY KEY (run_id, position)) STRICT;

-- v20 (RW phase 1, P3): remote hosts (+ lead-approved workspace location columns)
CREATE TABLE remote_hosts (id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE, hostname TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535), username TEXT NOT NULL,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('agent','key_file','password')),
  key_file_display TEXT, secret_ref TEXT, agent_forwarding INTEGER NOT NULL DEFAULT 0 CHECK (agent_forwarding IN (0,1)),
  created_at TEXT NOT NULL, last_connected_at TEXT) STRICT;
CREATE TABLE remote_host_keys (host_id TEXT NOT NULL REFERENCES remote_hosts (id) ON DELETE CASCADE,
  algorithm TEXT NOT NULL, fingerprint_sha256 TEXT NOT NULL, public_key TEXT NOT NULL,
  trusted_via TEXT NOT NULL CHECK (trusted_via IN ('first_use_confirmed','known_hosts_confirmed','replaced_after_change')),
  trusted_at TEXT NOT NULL, replaced_at TEXT, PRIMARY KEY (host_id, algorithm, fingerprint_sha256)) STRICT;
CREATE UNIQUE INDEX remote_host_keys_active_idx ON remote_host_keys (host_id, algorithm) WHERE replaced_at IS NULL;
ALTER TABLE workspaces ADD COLUMN location TEXT NOT NULL DEFAULT 'local' CHECK (location IN ('local','ssh'));
ALTER TABLE workspaces ADD COLUMN host_id TEXT;
-- remote rows store root_path as 'ssh://<host_id>/<remote canonical path>' so UNIQUE(root_path) keeps its meaning;
-- Z1's module stays the only writer of `workspaces`.

-- v21 (SCH, P4): scheduler (mode and provider limits are settings / profile values)
CREATE TABLE scheduler_file_claims (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, pattern TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('exclusive','shared')),
  source TEXT NOT NULL CHECK (source IN ('predicted','observed','user')),
  acquired_at TEXT NOT NULL, released_at TEXT) STRICT;
CREATE INDEX scheduler_file_claims_active_idx ON scheduler_file_claims (task_id) WHERE released_at IS NULL;
CREATE TABLE scheduler_overrides (id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('force_start','hold','priority','ignore_resources')),
  value TEXT, set_by TEXT NOT NULL, set_at TEXT NOT NULL, expires_at TEXT, cleared_at TEXT) STRICT;

-- v22 (DI + BR, P4): diff intelligence and blast radius
CREATE TABLE change_attributions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, worktree_id TEXT,
  path TEXT NOT NULL, before_sha256 TEXT, after_sha256 TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('provider','agent','human','automation','unknown')),
  provider_id TEXT, thread_id TEXT, agent_id TEXT, task_id TEXT, tool_call_id TEXT, checkpoint_id TEXT,
  confidence TEXT NOT NULL CHECK (confidence IN ('exact','likely','unknown')), observed_at TEXT NOT NULL) STRICT;
CREATE INDEX change_attributions_path_idx ON change_attributions (workspace_id, path, observed_at DESC);
CREATE TABLE diff_analyses (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, diff_sha256 TEXT NOT NULL,
  method_version INTEGER NOT NULL, result TEXT NOT NULL CHECK (json_valid(result)), computed_at TEXT NOT NULL,
  UNIQUE (workspace_id, diff_sha256, method_version)) STRICT;          -- cache; rebuildable
CREATE TABLE impact_analyses (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
  diff_analysis_id TEXT NOT NULL REFERENCES diff_analyses (id) ON DELETE CASCADE,
  method_version INTEGER NOT NULL, result TEXT NOT NULL CHECK (json_valid(result)), computed_at TEXT NOT NULL) STRICT;

-- v23 (AUT, P4): automations (kill switch is a setting; notifications live in v11)
CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  workspace_id TEXT, current_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE automation_versions (automation_id TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  version INTEGER NOT NULL, definition TEXT NOT NULL CHECK (json_valid(definition)),
  permission_mode TEXT NOT NULL CHECK (permission_mode IN ('plan','approve','auto','bypass','custom')),
  bypass_confirmed_at TEXT, created_at TEXT NOT NULL, PRIMARY KEY (automation_id, version),
  CHECK (permission_mode <> 'bypass' OR bypass_confirmed_at IS NOT NULL)) STRICT;
CREATE TABLE automation_runs (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  version INTEGER NOT NULL, trigger_event_id TEXT, chain_root_run_id TEXT NOT NULL,
  chain_depth INTEGER NOT NULL CHECK (chain_depth BETWEEN 0 AND 5),
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_for_approval','succeeded','failed',
    'skipped_cooldown','skipped_rate_limit','loop_prevented','killed','cancelled')),
  started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT) STRICT;
CREATE INDEX automation_runs_recent_idx ON automation_runs (automation_id, started_at DESC);

-- v24 (MEM, P4): memory (delete removes rows; only the memory.deleted event remains)
CREATE TABLE memory_records (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','workspace','agent','mission')), scope_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('fact','decision','convention','preference','warning')),
  subject TEXT NOT NULL, statement TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','stale','contradicted','ignored')),
  pinned INTEGER NOT NULL DEFAULT 0, confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  confidence_basis TEXT NOT NULL CHECK (json_valid(confidence_basis)),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('user','agent','autopsy','import')), origin_ref TEXT,
  stale_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, verified_at TEXT, last_used_at TEXT) STRICT;
CREATE INDEX memory_subject_idx ON memory_records (scope_kind, scope_id, subject);
CREATE TABLE memory_evidence (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memory_records (id) ON DELETE CASCADE,
  reference TEXT NOT NULL CHECK (json_valid(reference)), sha256 TEXT,
  state TEXT NOT NULL CHECK (state IN ('valid','changed','missing','unchecked')),
  captured_at TEXT NOT NULL, checked_at TEXT) STRICT;
CREATE TABLE memory_revisions (memory_id TEXT NOT NULL REFERENCES memory_records (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, statement TEXT NOT NULL, changed_by TEXT NOT NULL, changed_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, revision)) STRICT;
CREATE TABLE memory_conflicts (a_id TEXT NOT NULL REFERENCES memory_records (id) ON DELETE CASCADE,
  b_id TEXT NOT NULL REFERENCES memory_records (id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('deterministic','provider_assisted')),
  detected_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT,
  PRIMARY KEY (a_id, b_id), CHECK (a_id < b_id)) STRICT;
CREATE VIRTUAL TABLE memory_fts USING fts5(subject, statement, content='memory_records', content_rowid='rowid');

-- v25 (BP, P5): workspace blueprints
CREATE TABLE blueprints (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL,
  version INTEGER NOT NULL, document TEXT NOT NULL CHECK (json_valid(document)),
  source TEXT NOT NULL CHECK (source IN ('local','imported')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;

-- v26 (HS, P5): hot-swap
CREATE TABLE handoff_capsules (id TEXT PRIMARY KEY, from_thread_id TEXT NOT NULL, to_thread_id TEXT,
  from_provider_id TEXT NOT NULL, to_provider_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('manual','assisted','automatic')),
  trigger TEXT NOT NULL CHECK (json_valid(trigger)), context_package_id TEXT NOT NULL,
  capsule TEXT NOT NULL CHECK (json_valid(capsule)),  -- references + structured summary; no file contents
  has_model_summary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('previewed','sent','failed','discarded')),
  created_at TEXT NOT NULL, sent_at TEXT) STRICT;

-- v27 (BL + FA, P5): outcomes, benchmark and autopsy (task_outcomes is rebuildable from events + Z9/Z10)
CREATE TABLE task_outcomes (task_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT,
  profile_id TEXT, profile_version INTEGER, task_class TEXT NOT NULL,
  first_pass INTEGER NOT NULL CHECK (first_pass IN (0,1)), passed INTEGER NOT NULL CHECK (passed IN (0,1)),
  attempts INTEGER NOT NULL, duration_ms INTEGER NOT NULL, tool_failures INTEGER NOT NULL,
  regression INTEGER NOT NULL DEFAULT 0, handoffs INTEGER NOT NULL DEFAULT 0, cost_usd_micros INTEGER,
  finished_at TEXT NOT NULL) STRICT;
CREATE INDEX task_outcomes_cell_idx ON task_outcomes (task_class, provider_id, model);
CREATE TABLE autopsies (id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, last_good_checkpoint_id TEXT, created_at TEXT NOT NULL) STRICT;
CREATE TABLE autopsy_findings (autopsy_id TEXT NOT NULL REFERENCES autopsies (id) ON DELETE CASCADE, position INTEGER NOT NULL,
  certainty TEXT NOT NULL CHECK (certainty IN ('confirmed','likely','unknown')), likelihood TEXT,
  summary TEXT NOT NULL, evidence TEXT NOT NULL CHECK (json_valid(evidence)),
  evidence_checked INTEGER NOT NULL CHECK (evidence_checked IN (0,1)),
  source TEXT NOT NULL CHECK (source IN ('deterministic','provider_assisted')),
  PRIMARY KEY (autopsy_id, position), CHECK (certainty <> 'confirmed' OR evidence_checked = 1)) STRICT;
CREATE TABLE remediation_proposals (id TEXT PRIMARY KEY, autopsy_id TEXT NOT NULL REFERENCES autopsies (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('test','skill','rule','memory')), summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','applied','unavailable')),
  applied_ref TEXT, decided_at TEXT) STRICT;
```

**Normalization notes (why this is not a mirror of the directive's nouns):**

- Rail state (pin, group, archive, order) lives in `workspace_rail`, keyed by workspace id, so Z1
  stays the only writer of `workspaces`. Display statuses, Dashboard counts, home summary and
  recent work are **derived**, never stored.
- Interactive provider panes are ordinary `threads` rows (`runtime_kind`, `terminal_id`), not a
  second session table. One status machine, one Dashboard, one Locator.

- Profile defaults for five levels live in **one** binding table, not in columns on workspaces,
  agents, missions and threads. Threads pin `(profile_id, version)`.
- Scheduler states are **derived**, never stored on `mission_tasks`. Only claims and overrides
  (user intent) persist.
- Health current state, resource samples, the continuity inventory, and Command Center views are
  **not tables**.
- Handoff capsules, context packages and memory evidence store **references and hashes**, not
  copies of file contents. Content is re-read and re-checked when it is used.
- Delegation contracts are immutable (edits supersede them), so every delegation points at the
  exact rules it ran under.
- Checkpoint *objects* live in a shadow repository (ADVANCED D2). The table indexes them against
  the event sequence.
- `permission_action_log` is the single action record used by TM replay, DI attribution and FA.
  There is no second "tool input" log.

---

## 10. Provider contract additions (`agent.rs`) and flags

> **Adopted in CA-1:** `FeatureId` (plus `ContextFirewall`, `HostKeyVerification`,
> `SafeRestore`, `AutomationKillSwitch`, so every safety system has an explicit placement),
> `FeatureFlag`, `FeatureFlags.features`, `FeaturePlacement` (plan placement, ADVANCED.md §14a
> decision 1). `settingDescriptors`, `contextLimits` and `AgentEvent::Backoff` remain proposed.

```rust
pub struct ProviderCapabilities {
    // existing …
    #[serde(default)] pub setting_descriptors: Vec<ProfileSettingDescriptor>, // PP
    #[serde(default)] pub context_limits: Option<ContextLimits>,              // CTX translation
}
pub struct ContextLimits { pub max_input_bytes: u64, pub accepts_images: bool }

pub enum AgentEvent {
    // existing …
    /// The provider reported it is retrying/backing off (e.g. Claude Code `system/api_retry`).
    /// Emitted only when the provider says so; never inferred.
    Backoff { attempt: u32, max_attempts: Option<u32>, retry_at: Option<String>, reason: String },
}

// flags.rs (native-core) — per-feature flags next to surface flags
pub enum FeatureId {
    ProviderHealth, ProviderProfiles, ContextDrop, UtilityDock, ResourceGovernor, SessionLocator,
    ProcessContinuity, GitCore, TrustKernelExplain, AgentOrganization, Missions, Verification,
    TimeMachine, RemoteWorkspaces, Scheduler, DiffIntelligence, Automations, Memory,
    EnvironmentDoctor, Blueprints, CommandCenter, ProviderHandoff, BenchmarkLab, FailureAutopsy,
    WorkspaceHome, WorkspaceRail, PaneSystem, ProviderPanes, NotificationCenter, AccountSignIn,
}
pub struct FeatureFlag { pub id: FeatureId, pub state: SurfaceState, pub visible: bool }
// FeatureFlags { surfaces, #[serde(default)] features: Vec<FeatureFlag> }
```

## 11. Approval checklist for the lead

- [x] `NormalizedAction` origin: compatible form (`origin: Option<ActionOrigin>`, empty strings)
      — adopted in CA-1.
- [ ] Z4 pre-merge amendments (`ADVANCED.md` §6).
- [x] Correlation fields and `events_query` (§3.1–3.2) — adopted in L-1, migration **v5**.
- [ ] Event catalog additions and the "not added" list (§3.3).
- [ ] File handles instead of paths (§4, ADVANCED D4).
- [x] New scopes and action kinds (§2) — adopted in CA-1 (types; TK-1 classifies them).
- [ ] Migration reservations v5–v40 (`ADVANCED.md` §5.2).
- [x] `SurfaceId::CommandCenter`, `FeatureId` (§10) — adopted in CA-1.
- [ ] KalVoice intent additions and the safety asymmetry (§8).
- [ ] Z7: `ThreadRuntimeKind`, `DisplayStatus` mapping, `InteractiveSupport`, pane layout schema,
      `profile.displayName` setting, rail and notification tables (§6.10, §9 v9–v12).
