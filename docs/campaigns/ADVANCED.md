# Campaign plan — Advanced systems (ADV)

Status: **PROPOSED plan — for lead approval** · Branch `plan/advanced-systems` (from main `5188546`)
· Written 2026-09-24 · Companion: `docs/CONTRACTS_ADVANCED.md` (proposed contract additions).

This plan covers twenty native KalCode systems in two layers, three cross-cutting capabilities,
the foundations they need, and the next desktop campaign, **Z7 — Workspace, Dashboard, Thread
Panels & Returning-User UX** (§16). Z7 includes the architectural pivot to provider panes that
run the real provider CLI (`docs/PROVIDER_PANES.md`). This is a dependency and integration plan,
not a feature promise: nothing in it is built yet unless §1 says so.

Hard rules that bind every item below:

1. **Zero company AI cost.** Users' own providers only; local-first; no per-user cloud AI cost.
   Anything "semantic" or "model-assisted" either runs on-device (opt-in download, like KalVoice
   speech models) or on the user's own connected provider, with a preview.
2. **One authority.** Every consequential action from every origin goes through the permission
   model (Plan / Approve / Auto / Bypass / Custom, on every plan). The Trust Kernel (TK) is the
   formalisation and extension of the Z4 engine, not a second authority system.
3. **Extend, never duplicate.** Event Protocol, provider adapters, thread runtime, permissions,
   Dashboard, KalVoice and SQLite migrations are extended. One sampler, one diff view, one context
   builder, one redactor, one layout store, one event log.
4. **Failure isolation.** Every supporting system may fail without blocking threads, terminals
   or coding. A failing subsystem degrades to "unavailable" with an honest message.
5. **Honesty.** Heuristics always carry a confidence and never claim certainty; nothing invented
   (no quota data, no replay of model reasoning); the website claims nothing that is not built
   (§12.3).
6. **Native names only.** No other product is named, compared to or imitated, anywhere.

---

## 0. Summary for the lead

### System codes

| Layer 1 | Code | Layer 2 | Code | Cross-cutting | Code |
| --- | --- | --- | --- | --- | --- |
| Agent Organization Graph | ORG | Provider Hot-Swap with Intelligent Handoff | HS | Context Firewall | FW |
| Intelligent Parallelism Scheduler | SCH | Universal Session Locator | LOC | Blast Radius | BR |
| Command Center | CC | Environment Doctor | DOC | Failure Autopsy | FA |
| Execution Time Machine | TM | Provider Health + Capacity | PH | | |
| Distributed Workspaces | RW | Workspace Blueprints | BP | | |
| Provider Profiles | PP | Process Continuity Engine | PC | | |
| Evidence-Backed Memory | MEM | KalCode Trust Kernel | TK | | |
| Universal Context Drop | CTX | Provider-Agnostic Diff Intelligence | DI | | |
| Event-Driven Engineering | AUT | Workspace Resource Governor | RG | | |
| Developer Utility Dock | UD | Benchmark Lab | BL | | |

Desktop campaign: **Z7** Workspace, Dashboard, Thread Panels & Returning-User UX (§16).
Foundations: **Z6a** Git & workspace files core · **Z8** Agents · **Z9** Missions · **Z10**
Verification · **Z11s** Skills (not scheduled here) · **L** lead platform tasks.

### Concurrency budget

The owner caps concurrency at **8 subagents in total, including ongoing work**. This plan never
schedules more than **4 product writers at once**. The remaining slots go to ongoing threads
(wave-2 integration, Z4/TK, Z12 or the KalVoice track), one security reviewer and one QA/review
agent, which leaves at least one slot free in every phase. "Fewer when safer" applies to the
security-heavy phases (P3 remote, and any phase containing TK changes). Those run with 3 writers
if a review backlog builds.

### What can start now, and what the lead's guess gets right

The lead's guess — Environment Doctor, Provider Health, Session Locator, a Resource Governor
monitor, Process Continuity for terminals and threads — is **technically feasible on main + wave
2** for all five: none needs Missions or Agents. It is **not the best schedule**, for two reasons
the guess could not know about. The desktop campaign **Z7** (§16) rewrites the shell, sidebar,
Dashboard and thread code right after wave 2. And the owner's 8-subagent cap applies.

| System | Feasible without Missions/Agents? | Scheduled | Why |
| --- | --- | --- | --- |
| RG Resource Governor (monitor) | **Yes** | **P0 — now** | A pure crate (`crates/resources`) touching no shell code. Holding tasks needs the Scheduler (P4); until then it is advisory and never blocks threads. |
| PC Process Continuity (terminals, threads) | **Yes**: most recovery already exists (Z0 interrupted-session detection, Z1 tabs restored as *ended* + Restart, Z3 `interrupted` + provider resume) | **P1, inside Z7** | Z7's "restore on return" *is* Process Continuity. Building PC before Z7 would build the layout/pane restore twice. PC formalises the existing recovery into one labelled inventory; it does not reimplement Z1/Z3 recovery. Pending approvals are NOT RECOVERABLE by design (Z4 expires them on restart). |
| LOC Session Locator | **Yes** (threads, workspaces, terminals, providers, activity) | **P1, inside Z7** | Z7 search is wired to it, and the palette/rail it appears in is rewritten by Z7. The index crate is built in Z7-W2. *Recent commands* are limited to commands KalCode observed (provider `Command` actions, automation runs, hook events); terminal input is never recorded. |
| PH Provider Health | **Yes** (Z2 detection on main, Z3 runtime in wave 2) | **P2** | Z7-W4 rewires the provider runtime (interactive provider panes, hook ingestion) in `crates/providers` and `crates/threads`; PH in parallel would collide in the same crate. It needs a small Z3 observer hook and a structured `AgentEvent::Backoff`. Rate limits are shown only when a provider reports them. |
| DOC Environment Doctor | Details/Ignore **yes**; Fix needs TK-1 | **P2** | It consumes PH, RG and Git probes rather than re-probing, and its Fix path needs the Trust Kernel's non-thread origin. |

**Start now (P0, crate-only, no shell/sidebar/dashboard/thread files):** Z6a Git & files core
(`crates/git`), CTX/FW Context & Firewall library (`crates/context`), RG sampler
(`crates/resources`). None of them touches files that wave 2 or Z7 rewrite.

### What cannot start until a foundation exists

| System | Blocked on | What would be hollow without it |
| --- | --- | --- |
| Z7 Workspace UX (all of it) | **Wave 2 + Z4 merged** (owner directive) | It rewrites the same shell, sidebar, Dashboard and thread code. |
| ORG Agent Organization Graph | **Z8 Agents** (+ Z4 merged, TK-1) | There is no agent entity to relate, delegate between or draw. |
| SCH Scheduler | **Z9 Missions** (task graph), **Z6a** (worktrees), **Z8** (assignment), RG | Without tasks and dependencies it would only queue threads: an admission queue, not a scheduler. |
| CC Command Center | ORG, SCH for the agent and task graphs; Z7's Dashboard | CC extends Z7's Dashboard; built once, as an aggregator. |
| TM restore / branch | **Z6a checkpoints** | VIEW HISTORY needs only the event log (L-1 query API). |
| TM replay | TK-1 action log | Z3 stores tool summaries only, so there is no full action to replay. |
| MEM Memory | CTX/FW (memory reaches providers only through context packages) | "Verify" is richer with Z10, but not blocked by it. |
| AUT Automations: core | TK-1 (automation origin), CTX/FW | — |
| AUT Automations: mission and verification actions | **Z9, Z10** | — |
| HS Hot-Swap: manual thread handoff | PH, CTX/FW, Z6a (diff), Z7-W4 (interactive panes) | — |
| HS: mission/task capsule fields, tests/build status | Z9, Z10 | — |
| HS: automatic failover | PH (+ policy in PP) | — |
| BP Blueprints: phase 1 | Z7 layout store, PP | Covers layout, panes, profiles, permissions, terminal presets and sizing. |
| BP Blueprints: agent team, mission config, verification defaults, automation hooks | Z8, Z9, Z10, AUT | — |
| DI Diff Intelligence | **Z6a** (+ Z3 `thread_files`, hook-reported file changes from interactive panes) | Verification integration needs Z10. |
| BR Blast Radius | Z6a, DI | — |
| BL Benchmark Lab | **Z9, Z10** | Without task outcomes and verification results it has no honest metrics. |
| FA Failure Autopsy | **Z10**, TM, DI | "Create a skill" needs **Z11 Skills** (not scheduled): shown as unavailable. |
| RW Remote: remote provider sessions, remote worktrees | RW phase 1, Z6a, TK remote-path containment | — |
| Z7 account / browser sign-in UX | **Z13** sign-in and API deployment | — |

### Phases at a glance (≤ 4 writers; head-count ≤ 8 including ongoing work)

A phase is a default grouping, not a gate. The rule is a **ready queue**: a free writer slot may
take any item whose dependencies (§4) are on `main` and whose files no other writer owns (§5.3).

| Phase | Writers (≤ 4, disjoint ownership) | Ongoing / non-writers | Head-count |
| --- | --- | --- | --- |
| **P0 (now)** | Z6a Git & files core · CTX/FW library · RG sampler | wave-2 integration, Z4, Z12, 1 security/QA | 7 |
| **P1 Z7 Workspace UX** (after wave 2 + Z4 merge) | W1 pane system + layout store · W2 workspace rail, home, folder surface, recent work, search (LOC) · W3 live Dashboard, cards, notification center, widgets · W4 thread-pane / provider-runtime integration (interactive panes, hooks, PC inventory) | Z4 thread → **TK-1**; Z12 if still open; 1 security; 1 QA | 7–8 |
| **P2** | PP + PH (Providers → Health, Profiles) · UD Utility Dock (docks into Z7 panes) · TM view history, checkpoints, restore, branch · DOC Environment Doctor | KalVoice (K) track, security, QA | 7 |
| **P3 foundations** | Z8 Agents + ORG core · Z9 Missions · Z10 Verification · RW phase 1 (SSH) | security, QA, perf | 7 |
| **P4** | SCH Scheduler · DI + BR · AUT core · MEM | K track, security, QA | 7 |
| **P5** | CC + live graphs · HS Hot-Swap · BL + FA · BP Blueprints | security, QA, perf | 7 |
| **P6** | RW phase 2 · AUT phase 2 · Z7-W5 account/auth UX (with Z13) · hardening | security, QA | ≤ 6 |

---

## 1. Current-state inventory (inspected 2026-09-24)

### 1.1 On `main` (`5188546`)

| Area | What exists | Relevance |
| --- | --- | --- |
| `crates/contracts` | ids (UUIDv7), `EventPayload` (49 variants) + envelope + `Correlation {workspace, thread, mission, provider, request}`, `ThreadStatus` (18), `ThreadSummary`, `AgentProvider`/`AgentSession`/`AgentEvent`, `ProviderCapabilities` (streaming, interrupt, resume, host approvals, models, permission mappings), `SessionConfig`, permissions (`PermissionMode`, 19 `PermissionScope`s, `ActionKind`, `NormalizedAction` — **thread-bound**, `PolicyDecision`, `ApprovalRequest`, `PermissionGate`), KalVoice (`KalVoiceIntent`, 11 variants), `SurfaceId` (12 surfaces) | Every system extends these (CA-1..4). |
| `crates/native-core` | SQLite + checksummed, backed-up migrations (schema **v1**: `app_meta`, `settings`, `events`), event store (persist-before-publish, `events_recent {limit ≤ 500, beforeSeq}` only), bus, typed settings, surface-level feature flags, redacting JSON logs (`logging::redact`), `KalError` taxonomy, diagnostics, interrupted-session detection | Events are the time and audit backbone. No correlation/type query API yet; there is one database connection behind a lock. |
| `crates/providers` | Detection for Claude Code, Codex and Gemini CLI; supervised processes; Claude Code adapter (the only working adapter); permission mappings, all "approximate (stricter)" | PH and PP extend it; HS and BL need more than one working adapter to be useful. |
| `crates/secure-store`, `crates/entitlements` | OS keychain; signed entitlement verification | RW credentials; plan gating (owner decision, §14). |
| `apps/desktop` | Shell, Dashboard (Z5, fixtures until Z3/Z4), Providers, Settings, honest gated pages, command palette | CC extends the Dashboard data layer (`surfaces/dashboard/data`). |
| `packages/protocol`, `packages/ui`, `packages/testing` | Generated types, plans, design system, fixtures | |

### 1.2 In flight (read from branches, not checked out)

| Branch | State | Delivers | Notes for this plan |
| --- | --- | --- | --- |
| `z1/workspace-terminal` | done | `workspaces` (canonical `root_path` UNIQUE), `terminals` (metadata only; output never stored), `crates/pty`, Code surface, tabs restored as *ended* + Restart | RW needs a location abstraction on `workspaces` (§6). PC formalises its restart semantics. |
| `z3/threads` | done | `crates/threads` (`ThreadRuntime`, seams `ProviderRegistry` / `WorkspaceResolver` / `PermissionGate`), `threads`, `thread_messages`, `tool_calls` (**summary only**), `thread_files`, crash recovery → `interrupted`, provider resume, `Core::write_with_events` | `ThreadSummary.branch` exists but `threads` has no branch/worktree column; there is no thread origin (agent, task, delegation, automation, handoff). |
| `z4/permissions` | in progress | `crates/permissions`: deterministic, fail-closed classifier + policy (opaque ⇒ never auto-allowed; remote-consequential ⇒ never mode-allowed; Bypass refused to agents/KalVoice/automations and audited), grants, `approvals` / `permission_grants` / `permission_audit` with immutability triggers, `Actor {User, System, Agent, KalVoice, Automation}` (local to the crate) | **TK formalises this engine** (§3 D5). Blockers found: `approvals.thread_id NOT NULL`, closed `permission_audit.kind` CHECK list, `Actor` not in contracts (§6). |
| `z12/kalvoice` | in progress | `crates/kalvoice`: deterministic grammar → `KalVoiceIntent`, orchestrator, ledger, local speech; migration `0006_kalvoice`; **gap-tolerant migration runner** (reserved numbers may land out of order) | Every new system adds intents through this grammar (K track). |
| `integrate/wave2` | starting | Z1 + Z3 on main | |

### 1.3 Missing foundations

| Foundation | State | Needed by |
| --- | --- | --- |
| Event query API (correlation/type/range, cursors) and causation link | missing | TM, CC, LOC, MEM provenance, AUT loop detection, DI attribution, BL, FA |
| Read-only connection for background analytics | missing (single locked connection) | LOC, DI, BR, BL, FA, MEM contradiction scan, TM aggregation |
| Git integration (Z6): status, diff, worktrees, checkpoints, file handles | missing. `git.*` events are listed in `EVENT_PROTOCOL.md` but **absent from `EventPayload`** | TM, SCH, DI, BR, HS, FA, BP, CTX (diff items), UD (diff tool) |
| Agents (Z8) | missing | ORG, SCH, BP, PP (agent level), MEM (agent scope) |
| Missions (Z9) | missing. `mission_id` correlation exists but nothing emits it | SCH, CC task graph, AUT, HS, BP, BL, CTX (mission scope), PP (mission level) |
| Verification (Z10) | missing | AUT (verification step), BL, FA, MEM verify, HS (tests/build status), DI |
| Memory (Z11) | missing | **MEM is the memory foundation**, built evidence-first rather than as a naive store that is then replaced |
| Automations (Z11) | missing | **AUT is the automations foundation** |
| Notifications | missing (`notification.created` is documented, not defined) | Z7 notification center, AUT, DOC, PH, PC, HS: built once by Z7-W3 (`crates/notifications`), used by all |
| Skills / Plugins (Z11) | missing | FA "create skill" remediation, plugin scopes in TK: unavailable until Z11 |
| Non-thread action origins in permissions | missing | DOC fixes, UD process control, RW connect, AUT, ORG delegation, PC restarts, CTX share, BP apply |

### 1.4 Discrepancies found (lead to resolve)

1. `docs/CONTRACTS.md` reserves migrations as 0002 Z1 / 0003 Z2 / 0004 Z3 / 0005 Z4. The branches
   ship 0002 / 0004 / 0005 / 0006, and the lead's wave-2 plan is v2 Z1 / v3 Z3 / v4 Z4. This plan
   uses the lead's numbering and proposes **v5 = Z12 KalVoice** (its branch file is `0006`).
   Update `CONTRACTS.md` at wave-2 integration.
2. `EVENT_PROTOCOL.md` lists `git.*` as defined; the enum has no git variants. CA-1 adds them.
3. `ThreadSummary.branch` has no backing column.
4. `docs/SECURITY.md` says the WebView never supplies paths. CTX, UD, DI and TM need file
   references, so §3 D4 proposes opaque file handles that keep the rule intact.

---

## 2. Foundations and lead platform tasks

| Id | Item | Owner | When | Contents |
| --- | --- | --- | --- | --- |
| **L-1** | Event platform | lead (native-core) | P0 (now) | Optional correlation fields `agentId`, `taskId`, `automationId`, `causationId` (protocol v1-compatible, §6 of `EVENT_PROTOCOL.md`); migration **v6** adds columns + partial indexes; `events_query` (types/prefixes, correlation filter, seq range, cursor, asc/desc, ≤ 500); `Core::reader()` read-only WAL connection for background work; `kalcode_core::redact` extracted from `logging.rs` (one redactor for logs, FW, UD, LOC snippets, MEM); per-feature flags (`FeatureId`) alongside surface flags; `SurfaceId::CommandCenter`; native confirmation dialog helper (Rust-side, for WebView-unforgeable confirmations, §3 D8). |
| **CA-1..4** | Contract additions per wave | lead (`crates/contracts`) | start of each wave | See `CONTRACTS_ADVANCED.md`. Writers never edit contracts. |
| **TK-1** | Trust Kernel phase 1 | Z4 thread continuing (`crates/permissions`) | right after Z4 merges | Action origins beyond threads; new scopes and `ActionKind`s; formal invariants K1–K10; authority ceilings; `trust.action_blocked`; `permission_action_log`; `explain`. Migration **v12** (with L-2). |
| **L-2** | Thread origins | lead (`crates/threads`, post-merge) | P1 start (with TK-1) | `ThreadOrigin` on create (user, KalVoice, agent/delegation, task, automation run, handoff); runtime kind (`headless` / `interactive_pty`) + terminal id for provider panes; worktree binding; profile application link. Migration **v12**. |
| **Z6a** | Git and workspace files core | P0 writer | P0 (now) | `crates/git` (argv-invoked user `git`, sanitized env, no hooks for internal operations), status/diff/log, worktrees, **checkpoint store** (§3 D2), file index + **file handles** (§3 D4), shared `DiffView` component, `git.*` events. Migration **v7**. The Git/Files/Browser *panes* (Z6b) stay a later campaign. |
| **Z8** | Agents | P3 writer | P3 | Agent definitions (role, default provider, profile, default permission mode ≤ Auto, custom profile); ORG core builds on it. Migration **v17**. |
| **Z9** | Missions | P3 writer | P3 | Missions, tasks, dependency edges, predicted paths, risk, priority, mission scope. Migration **v18**. |
| **Z10** | Verification | P3 writer | P3 | Verification specs and runs (argv commands via TK, evidence capture, exit codes, bounded logs stored locally). Migration **v19**. |

---

## 3. Key decisions (ADR-style, each reversible behind a typed seam)

**D1 — Sequencing: foundations-first vs thin slices on mocks.**
*Option A:* build every system now against mocks of Missions/Agents/Verification. *Option B:*
build foundations first and start systems when their foundations merge. **Decision:** a hybrid.
Systems whose foundations exist start as soon as the concurrency budget allows (P0–P2). Systems that are hollow without a foundation
(ORG, SCH, BL, FA) wait for it. Mocks are allowed only behind typed seams and must be replaced
before release (§12.2). *Trade-off:* slower start for ORG/SCH, in exchange for no throwaway
scheduler or organization model.

**D2 — Checkpoint storage for the Time Machine.**
*Option A:* refs inside the user's repository (`refs/kalcode/*`). *Option B:* a shadow repository
in app-data using the user's objects through `alternates`. *Option C:* a **self-contained shadow
repository per workspace** in app-data (`--git-dir=<data>/checkpoints/<ws>.git
--work-tree=<root>`), snapshotted through a temporary index seeded from the user's index for speed.
**Decision: C.** It never writes to the user's repository, works for non-Git folders, respects
`.gitignore`, and cannot be corrupted by the user's `git gc` (B can be). *Cost:* disk. Mitigated
by a per-workspace quota (default 2 GiB), pruning of unpinned checkpoints, a large-file skip
(> 50 MiB), and visible usage. "Branch from checkpoint" fetches the checkpoint commit from the
shadow repository into the user's repository only on an explicit user action.

**D3 — SSH transport for Distributed Workspaces.**
*Option A:* the system `ssh` binary (honours the user's config and agent; host-key UX depends on
parsing text; password prompts need an askpass helper; no multiplexing on Windows). *Option B:* an
embedded Rust SSH library (explicit host-key callback, typed connection state machine,
PTY/exec/SFTP channels, keychain-held secrets; partial config support). **Decision: B behind a
`RemoteTransport` trait.** Phase 0 is a spike that validates the chosen library against its
current documentation and Windows agent support before any UI work. The user's `known_hosts`
entries are read-only hints, and a first connection is still shown with its fingerprint. A is
kept as a fallback implementation of the same trait.

**D4 — File references across IPC.**
*Option A:* workspace-relative paths validated natively (relaxes `SECURITY.md`'s rule). *Option
B:* **opaque file handles** issued by native listings (`files_list`, diff, search results), valid
for the session and bound to a workspace. **Decision: B.** The WebView can only point at files
that native code already listed; containment is checked when the handle is issued and again when
it is used (time-of-check/time-of-use). Owned by Z6a.

**D5 — Trust Kernel reconciliation with Z4.**
The Z4 engine already is a kernel: deterministic, fail-closed, with non-overridable steps (opaque
⇒ ask, remote-consequential ⇒ ask, Plan boundary, Bypass restricted to users). **Decision:** TK is
the formal name for Z4's outermost layer plus its invariants, extended to cover every action
origin. There is one evaluator (`crates/permissions`), one audit trail (`permission_audit`), one
approval queue (`approvals`). The chain USER → Trust Kernel → Permission Policy →
Provider/Agent/Tool → Action is implemented as `kernel::evaluate = invariants(pre) ∘
ceiling ∘ policy::evaluate ∘ invariants(post)`. Ceilings and invariants can only *restrict*.
Nothing but the user can relax, and only through KalCode UI. `PermissionGate` stays as the Z3
seam, implemented by the kernel. See `docs/TRUST_KERNEL.md`.

**D6 — Memory and Automations fold Z11's memory/automation items.**
MEM and AUT *are* those foundations, built to the stricter design (evidence, loop prevention)
from the start. Skills and plugins stay in Z11.

**D7 — One implementation per shared capability.**
One resource sampler (`crates/resources`, RG) feeds the UD process monitor, SCH and DOC. One
change-facts engine (`crates/diffintel`, DI) feeds BR, SCH conflicts, TM attribution and BL
regressions. One context builder (`crates/context`) produces context packages, handoff capsules,
memory injection and automation prompts. One layout store (Z7-W1) is used by PC and BP. One `DiffView`
component (Z6a) is used by TM, DI and UD. One notification store (`crates/notifications`, Z7-W3).

**D8 — WebView-unforgeable confirmations for a small set of actions.**
The WebView is treated as possibly compromised. A few confirmations are therefore shown by
**native** dialogs, where a compromised WebView cannot click through: trusting or replacing an
SSH host key, terminating a process KalCode did not start, restoring files over the working tree,
turning the automation kill switch *off*, revealing an environment value, and first requests to a
new host from the API inspector. These are *confirmations of a user-origin action*, decided inside
TK (`requires_native_confirmation`), not a parallel authority. Security review should consider
applying the same helper to Bypass enablement (today `confirmBypass: true` from the WebView).

**D9 — Search without cloud models.**
LOC uses SQLite FTS5 (trigram + porter) plus structured ranking. Semantic ranking is enabled only
if the user installs an on-device embedding model (consent, SHA-256-verified download). It is
labelled "semantic" only then. Nothing is sent to a provider for search.

---

## 4. Dependency graph (all 20 systems, cross-cutting, foundations, Z7)

```text
main (Z0, Z2 providers, Z5 dashboard) ─┬─ wave 2 (Z1 workspaces/terminals, Z3 threads) ─┐
                                        └─ Z4 permissions ──────────────────────────────┤
                                                                                         ▼
P0 (now, crate-only) ── Z6a git/files/checkpoints/DiffView ── CTX/FW library ── RG sampler
L-1 event platform (query, causation, reader, redact, feature flags, native confirm) ─────────────┐
                                                                                                 │
P1  Z7 Workspace UX ◀── wave 2 + Z4                                                               │
    W1 panes + layout store ─────────────┐                                                        │
    W2 rail/home/folder/recent + LOC index ├──▶ PC (restore on return) ◀── W4                      │
    W3 Dashboard/cards/notifications ─────┤                                                        │
    W4 provider panes (PTY + hooks) + PC inventory ◀── Z2, Z3, TK-1                               │
    TK-1 Trust Kernel (Z4 thread): origins, ceilings, invariants, action log ◀── Z4               │
                                                                                                 │
P2  PP + PH ◀── Z2, W4        UD ◀── W1 panes, RG, Z6a DiffView, TK-1                             │
    TM ◀── Z6a checkpoints, L-1, TK-1 action log     DOC ◀── PH, RG, Z6a probes, TK-1 fixes      │
                                                                                                 │
P3  Z8 Agents + ORG core ◀── TK-1 ceilings     Z9 Missions     Z10 Verification ◀── TK-1           │
    RW phase 1 (SSH, host keys, remote terminals/files) ◀── Z1 location change, secure store, TK-1  │
                                                                                                 │
P4  SCH ◀── Z9, Z8, Z6a worktrees, RG, DI       DI + BR ◀── Z6a, Z3 thread_files, W4 hook file events│
    AUT core ◀── TK-1, CTX/FW, L-1 causation, W3 notifications     MEM ◀── CTX, L-1 (Z10 for verify) │
                                                                                                 │
P5  CC + ORG live graph ◀── W3 Dashboard, ORG, SCH, PH, RG, PC, DOC, DI, BL, HS panels            │
    HS ◀── PH, PP failover policy, CTX capsule, Z6a diff, W4, (Z9, Z10, MEM), recorded in TM       │
    BL + FA ◀── Z9, Z10, DI, TM, MEM          BP ◀── W1 layout, PP, Z4, RG, Z8, Z9, Z10, AUT       │
                                                                                                 │
P6  RW phase 2 ◀── RW-1, Z6a, TK remote containment     AUT phase 2 ◀── AUT, Z9, Z10, DOC, PH       │
    Z7-W5 account + browser sign-in ◀── Z13                                                        │
K track (KalVoice intents) ◀── each system's API, batched per phase ◀───────────────────────────────┘
```

Critical path: **wave 2 + Z4 → TK-1 → Z7 → (Z8, Z9, Z10) → SCH → CC**. Anything that shortens
the Z4 merge or Z7 shortens the whole plan.

---

## 5. Phases, ownership, branches, worktrees, migrations

### 5.1 Writers per phase

Branches are cut from `main` after the phase's CA-n contracts merge and merge `main` into
themselves at least daily. Worktrees live in `.worktrees/<name>` (git-ignored). Each writer runs
with an isolated `KALCODE_DATA_DIR` and its own ports (`docs/DEVELOPMENT.md`). All Tauri command
files live in `apps/desktop/src-tauri/src/`. Registration in `build.rs`, `lib.rs` and
`capabilities/main.json` is additive and listed in the hand-off.

| Writer | Phase | Branch / worktree | Owns (only writer) | Touches additively (listed in hand-off) | Migration | UI / CDP ports |
| --- | --- | --- | --- | --- | --- | --- |
| Git & files core (Z6a) | P0 | `z6/git-core` / `z6-git` | `crates/git`, `packages/ui/src/components/DiffView*`, `git_commands.rs`, `files_commands.rs` | — | v7 | 1441 / 9441 |
| Context & Firewall | P0 → P2 UI | `adv/context` / `adv-context` | `crates/context` (packages, firewall, translation); later the composer tray in the Z7 thread pane | Z7 thread-pane slot | v8 | 1442 / 9442 |
| Resource sampler (RG) | P0 → P2 UI | `adv/resources` / `adv-resources` | `crates/resources`, later `surfaces/settings/resources/**` | — | — | 1443 / 9443 |
| **Z7-W1** pane system + layout store | P1 | `z7/panes` / `z7-panes` | `apps/desktop/src/shell/panes/**`, layout store in `crates/workspace-ui` (layout persistence), `layout_commands.rs` | shell frame | v9 | 1451 / 9451 |
| **Z7-W2** rail, home, folder surface, recent work, search | P1 | `z7/rail` / `z7-rail` | `apps/desktop/src/shell/rail/**`, `surfaces/home/**`, `surfaces/folder/**`, `crates/locator`, `rail_commands.rs`, `locator_commands.rs` | Z1 workspace API (calls; rename/remove already exist) | v10 | 1452 / 9452 |
| **Z7-W3** Dashboard, cards, notifications, widgets | P1 | `z7/dashboard` / `z7-dashboard` | `apps/desktop/src/surfaces/dashboard/**` (rewrite of Z5), `apps/desktop/src/shell/notifications/**`, `shell/widgets/**`, `crates/notifications`, `notification_commands.rs` | Z4 approval components (reused) | v11 | 1453 / 9453 |
| **Z7-W4** provider panes + continuity | P1 | `z7/provider-panes` / `z7-provider` | `crates/providers/src/interactive/**`, `crates/hook-bridge` (`kalcode-hook` helper), `crates/continuity`, `apps/desktop/src/surfaces/threads/pane/**` | `crates/threads` runtime-kind support (with lead), `crates/pty` launch API (with lead) | v12 (lead) | 1454 / 9454 |
| **TK-1** (Z4 thread) | P1 | `z4/trust-kernel` / `z4` | `crates/permissions/**` | contracts via lead | v12 (lead) | 1435 / 9435 |
| PP + PH | P2 | `adv/provider-platform` / `adv-provider` | `crates/providers/src/{health.rs,profiles/**}`, `crates/profiles`, `surfaces/providers/{health,profiles}/**` | adapter setting descriptors | v13 | 1461 / 9461 |
| UD | P2 | `adv/utility-dock` / `adv-dock` | `crates/utility`, dock widgets in `shell/widgets/utility/**` (registered with W3's widget framework) | — | v14 | 1462 / 9462 |
| TM | P2 | `adv/time-machine` / `adv-tm` | `crates/timeline`, `surfaces/history/**` | — | v15 | 1463 / 9463 |
| DOC | P2 | `adv/doctor` / `adv-doc` | `crates/doctor`, `surfaces/settings/doctor/**` | — | v16 | 1464 / 9464 |
| Z8 + ORG core | P3 | `z8/agents` / `z8` | `crates/agents`, `surfaces/agents/**` | TK ceiling calls | v17 | 1471 / 9471 |
| Z9 Missions | P3 | `z9/missions` / `z9` | `crates/missions`, `surfaces/missions/**` | — | v18 | 1472 / 9472 |
| Z10 Verification | P3 | `z10/verification` / `z10` | `crates/verification`, verification views | — | v19 | 1473 / 9473 |
| RW phase 1 | P3 | `adv/remote` / `adv-remote` | `crates/remote`, `surfaces/settings/remote-hosts/**`, remote badges in the rail (W2 slot) | Z1 location change (lead-approved) | v20 | 1474 / 9474 |
| SCH | P4 | `adv/scheduler` / `adv-sch` | `crates/scheduler`, scheduler views | — | v21 | 1481 / 9481 |
| DI + BR | P4 | `adv/diff-intel` / `adv-di` | `crates/diffintel` | DiffView annotation props | v22 | 1482 / 9482 |
| AUT core | P4 | `adv/automations` / `adv-aut` | `crates/automations`, `surfaces/automations/**` | creates notifications through `crates/notifications` | v23 | 1483 / 9483 |
| MEM | P4 | `adv/memory` / `adv-mem` | `crates/memory`, `surfaces/memory/**` | — | v24 | 1484 / 9484 |
| CC + live graphs | P5 | `adv/command-center` / `adv-cc` | `surfaces/command-center/**` (shell, panel registry, graph renderers) | panels imported from their owners | — (v28 reserved) | 1491 / 9491 |
| HS | P5 | `adv/handoff` / `adv-hs` | `crates/handoff`, handoff UI | capsule built by `crates/context` | v26 | 1492 / 9492 |
| BL + FA | P5 | `adv/outcomes` / `adv-outcomes` | `crates/outcomes` | — | v27 | 1493 / 9493 |
| BP | P5 | `adv/blueprints` / `adv-bp` | `crates/blueprints`, blueprint UI in the rail's workspace menu | — | v25 | 1494 / 9494 |
| RW phase 2 · AUT phase 2 · Z7-W5 account UX | P6 | `adv/remote-2`, `adv/automations-2`, `z7/account` | as above; `apps/website/src/pages/account/**` + desktop sign-in flow with Z13 | — | v29, v30, v31 | 1441–1443 / 9441–9443 |
| Security / QA / perf (non-writers of product code) | all | `qa/advanced` | `apps/desktop/tests/e2e/advanced/**`, `packages/testing` fixtures, perf budgets | — | — | 1449 / 9449, 1448 / 9448 |

### 5.2 Migration reservations (schema versions)

The Z12 runner applies every unseen migration in ascending order and permits gaps. A number
belongs to exactly one owner. A migration may reference (FK) only tables from lower-numbered
migrations that are guaranteed to merge before it. Tables owned by another system are read
through that system's Rust API, never with SQL.

| v | Owner | Tables (proposed; details in `CONTRACTS_ADVANCED.md` §9) |
| --- | --- | --- |
| 1 | Z0 (main) | `app_meta`, `settings`, `events` |
| 2 | Z1 (wave 2) | `workspaces`, `terminals` |
| 3 | Z3 (wave 2) | `threads`, `thread_messages`, `tool_calls`, `thread_files` |
| 4 | Z4 | `permission_profiles`, `permission_settings`, `approvals`, `permission_grants`, `permission_audit` |
| 5 | Z12 (branch file `0006` → renumber at integration) | `kalvoice_requests`, `kalvoice_preferences` |
| 6 | L-1 lead | `events` + correlation columns and indexes |
| 7 | Z6a (P0) | `git_worktrees`, `checkpoints` |
| 8 | CTX/FW (P0) | `context_packages`, `context_items`, `context_firewall_log`, `context_never_share` |
| 9 | Z7-W1 | `workspace_layouts`, `layout_presets` |
| 10 | Z7-W2 | `workspace_rail`, `workspace_groups`, `locator_entries`, `locator_fts` (FTS5) |
| 11 | Z7-W3 | `notifications` |
| 12 | lead (TK-1 + thread runtime) | `permission_action_log`; `threads` columns: origin, runtime kind, terminal, worktree, profile |
| 13 | PP + PH | `provider_profiles`, `provider_profile_versions`, `provider_profile_bindings`, `provider_health_rollups` |
| 14 | UD | `scratchpads`, `http_saved_requests` |
| 15 | TM | `restore_operations`, `replay_runs` |
| 16 | DOC | `doctor_ignores`, `doctor_fix_log` |
| 17 | Z8 + ORG | `agents`, `agent_relationships`, `delegation_contracts`, `delegations` |
| 18 | Z9 | `missions`, `mission_tasks`, `task_dependencies`, `task_attempts` |
| 19 | Z10 | `verification_specs`, `verification_runs`, `verification_evidence` |
| 20 | RW phase 1 | `remote_hosts`, `remote_host_keys`; lead-approved `ALTER TABLE workspaces ADD COLUMN location …, host_id …` |
| 21 | SCH | `scheduler_file_claims`, `scheduler_overrides` |
| 22 | DI + BR | `change_attributions`, `diff_analyses`, `impact_analyses` |
| 23 | AUT | `automations`, `automation_versions`, `automation_runs` |
| 24 | MEM | `memory_records`, `memory_evidence`, `memory_revisions`, `memory_conflicts`, `memory_fts` |
| 25 | BP | `blueprints` |
| 26 | HS | `handoff_capsules` |
| 27 | BL + FA | `task_outcomes`, `autopsies`, `autopsy_findings`, `remediation_proposals` |
| 28 | CC | reserved; expected unused (view state lives in `settings`) |
| 29 | RW phase 2 | reserved |
| 30 | AUT phase 2 | reserved |
| 31 | Z7-W5 / Z13 | reserved: local account cache (display name, plan snapshot) |
| 32–33 | Z11 skills, Z11 plugins | reserved |
| 34–40 | lead | spare |

Deliberately **no tables** for: provider health current state (in memory), resource samples
(streamed on channels), the continuity inventory (derived at startup from Z1/Z3/Z4/Z7 tables),
recent work and the home summary (derived from the event log and threads), Command Center views,
scheduler decisions (derived; transitions are events), hook ingestion state (in memory, per
session), and search queries (never stored).

### 5.3 Safe-throughput rules

1. **Contracts land first.** Each phase starts with a lead PR (CA-n) containing every contract
   type and event variant the phase needs, so writers never edit `crates/contracts` or
   `EventPayload`.
2. **Hot files are additive and batched.** `build.rs`, `lib.rs`, `capabilities/main.json`,
   `generated/index.ts`, `flags.rs`: each writer lists its lines in the hand-off, and the lead
   applies them at merge. During P1, Z7 owns `shell/*`; nobody else edits it.
3. **Two writers never own the same directory.** Where two systems need the same crate (PP and PH
   in `crates/providers`; LOC inside the rail; PC inside provider panes), one writer does both, in
   sequence.
4. **At most 4 writers.** A P0 writer still running when P1 begins counts against P1's four;
   P1 starts its writers as slots free, in the order W4, W1, W3, W2 (W4 carries the most unknowns).
5. **Ready queue.** A writer that finishes early takes the next item whose dependencies are on
   `main` and whose ownership is free: P2 items, then Z9, Z10, Z8, SCH, DI, AUT, MEM.
6. **Threat model before code** for RW, TK-1, Z7-W4 (hook bridge), UD native tools, AUT, DOC
   fixes, BP import, HS failover, ORG delegation and Z7-W5 sign-in.

### 5.4 Non-writer capacity: tests, security, review

| Role | Per phase | Owns |
| --- | --- | --- |
| Security reviewer | 1 | Threat models (§5.3 rule 6); review of every high-risk merge against §9; escape tests (paths, remote, SQL, command injection into automations, forged hook calls). |
| QA / integration | 1 | `packages/testing` fixtures for new types; cross-system E2E in `apps/desktop/tests/e2e/advanced/**` (branch `qa/advanced`); failure-isolation tests (§11); the Z7 test and visual-QA lists (§16.6–16.7). |
| Performance | shared with QA when free | Budgets in §10 in `apps/desktop/tests/perf/budgets.json`; 1M-event, 10k-record and 50-thread datasets. |
| Code review | per merge | Independent review; blocking findings fixed before merge. |

---

## 6. Requests to in-flight branches (cheap now, expensive after release)

| To | Request | Why |
| --- | --- | --- |
| **Z4** (before merge) | Make `approvals.thread_id` nullable and add `origin_kind` / `origin_id`; widen the `permission_audit.kind` CHECK (`trust.action_blocked`, `trust.ceiling_applied`, `trust.invariant_enforced`, `grant.ceiling_clamped`); add expire reason `answered_in_provider` | Non-thread origins; interactive panes where the user answers inside the provider's own prompt. SQLite cannot relax a CHECK without rebuilding the table. |
| **Z4** | Move `Actor` into `crates/contracts` as `ActionOrigin` | Every new origin. |
| **Z3** (at wave-2 integration, lead) | `ThreadRuntime` gains a runtime kind (`headless` / `interactive_pty`) with a terminal id, `ThreadOrigin`, worktree and applied profile (v12); plus an observer hook (first-output latency, failures, session counts) | Z7-W4 provider panes, PH, ORG, SCH, HS, AUT. |
| **Z1** (lead) | A PTY launch API for provider CLIs (argv + sanitized env + cwd, native-resolved), distinct from shell tabs; a workspace location abstraction (`Local` / `Remote`) for RW | Z7-W4, RW. |
| **Z2** (lead) | `AgentEvent::Backoff`; `ProviderCapabilities.settingDescriptors`, `.contextLimits`, `.interactive` (launch mapping + status channels) | PH, PP, CTX, provider panes (`docs/PROVIDER_PANES.md`). |
| **Z12** | Grammar extension points per intent family; one KalVoice Request per top-level request stays unchanged | K track. |
---

## 7. Acceptance matrices

Criteria are PASS only when executed, as in earlier campaigns. Every system also inherits the
**common criteria**:

| # | Common criterion (applies to every system) |
| --- | --- |
| X-01 | Feature flag `gated` → `preview` → `available`; gated features show an honest "not available in this build" state and never fake data. |
| X-02 | Every consequential action is evaluated by TK with the correct origin; a test proves Plan mode blocks its modifying actions and Bypass does not skip K-invariants. |
| X-03 | Events are defined in `EventPayload`, persisted before they are published, carry ids and short facts only (no content, prompts or secrets), and round-trip; unknown versions decode as `unrecognized`. |
| X-04 | Every list IPC is paginated (limit ≤ 500, cursor) and validates ids natively; the WebView supplies no paths (file handles only), executables or shell strings. |
| X-05 | Failure isolation: killing, panicking or corrupting the subsystem's state leaves threads, terminals and the Dashboard working (fault-injection test). |
| X-06 | Migration upgrade test from the previous version with representative data; backup written. |
| X-07 | axe (WCAG 2.2 AA) clean in both themes; keyboard paths; status never colour-only; reduced motion honoured. |
| X-08 | Performance budget in §10 met on the reference machine; the harness includes the new metric. |
| X-09 | KalVoice intents for the system resolve deterministically (no model) and respect X-02. |
| X-10 | Branding, zero-cost and capability checks pass; independent code and security review findings fixed. |

### 7.1 ORG — Agent Organization Graph (Z8 + ORG)

| # | Criterion |
| --- | --- |
| ORG-01 | Agents have a role, default provider/profile, and a default permission mode ≤ Auto (Bypass cannot be an agent default). |
| ORG-02 | Relationships (reports-to, delegates-to, reviews, peer) are created, edited and removed; cycles in *reports-to* are rejected. |
| ORG-03 | A delegation contract lists *may* rules and *may-not* rules (scopes, path globs, providers), a max depth, a re-delegation flag and an optional duration; contracts are versioned and revocable. |
| ORG-04 | Delegating creates a thread whose effective authority equals the delegator's authority ∩ the contract; a property test over random rule sets proves the delegate's decision is never more permissive than the delegator's for the same action. |
| ORG-05 | *May-not* rules act as `never` for the delegate; a delegate can never enable Bypass or change any policy (refused and audited). |
| ORG-06 | Depth limit: a chain longer than `min(contract.maxDepth, global cap 5)` is refused with `agent.delegation_refused {reason: depth}`. |
| ORG-07 | Loops: a chain that revisits an agent is refused (`reason: cycle`), including indirect cycles A → B → C → A. |
| ORG-08 | Standing grants never transfer across a delegation; the delegate's approvals appear in the same approval queue, tagged with the delegation. |
| ORG-09 | Revoking a contract stops new delegations and expires the delegate's pending approvals. |
| ORG-10 | The live graph (P5) shows agents, relationships, active delegations and live thread status; 200 nodes pan/zoom at 60 fps; beyond 500 nodes it clusters. |

### 7.2 SCH — Intelligent Parallelism Scheduler

| # | Criterion |
| --- | --- |
| SCH-01 | Every task is in exactly one of RUNNING / QUEUED / BLOCKED / WAITING / CONFLICTED, with one or more typed reasons (dependency, file claim, worktree, provider concurrency, provider backoff, CPU/RAM/disk pressure, approval, user, manual hold, manual mode, priority, risk gate, conflict, kill switch). |
| SCH-02 | "Why is X not running?" returns the same typed explanation in the UI and through KalVoice. |
| SCH-03 | Dependencies: a task starts only after its dependencies are done; a dependency cycle is rejected at planning time. |
| SCH-04 | File ownership: exclusive claims on overlapping globs never run concurrently in the same worktree; shared claims may. |
| SCH-05 | Tasks that write run in their own worktree (Z6a); worktrees are created, reused and cleaned up; the user's checked-out branch is never switched. |
| SCH-06 | Conflicts: overlapping *observed* changes between concurrent tasks mark both CONFLICTED with a confidence; nothing is auto-merged. |
| SCH-07 | Provider concurrency limits come from provider profiles (KalCode-enforced); backoff comes only from observed provider signals. |
| SCH-08 | Resource holds come from RG pressure under the selected mode; a held task shows the metric, the threshold and the mode. |
| SCH-09 | Auto and manual modes: in manual mode nothing starts without the user; in both modes every start passes TK under the task's mode. |
| SCH-10 | Overrides (force start, hold, priority, ignore resource limits) are audited and expire; no override bypasses permissions or silently ignores a conflict. |
| SCH-11 | A scheduling pass over 200 tasks takes ≤ 5 ms and runs off the UI thread and off the database lock. |

### 7.3 CC — Command Center

| # | Criterion |
| --- | --- |
| CC-01 | One new top-level surface (`command_center`); everything else nests (progressive disclosure: summary → panel → entity detail → timeline). |
| CC-02 | Panels: agent graph, task graph, providers (PH), workspaces (incl. remote state), approvals, resources (RG), recovery (PC), hot-swaps (HS), environment warnings (DOC), diff intelligence (DI), benchmark insights (BL). |
| CC-03 | Each panel is owned by its system and registered with CC; an unavailable system renders an honest unavailable state without affecting other panels. |
| CC-04 | The Dashboard stays the quick view; CC reuses the Dashboard data layer (`useResource`, `RefreshTracker`) and never duplicates its fetching. |
| CC-05 | 1,000-row lists are virtualized; the first CC paint is ≤ 300 ms with 200 threads and 1M events. |

### 7.4 TM — Execution Time Machine

| # | Criterion |
| --- | --- |
| TM-01 | The causal timeline is built from the event log (`events_query` + `causationId`) with checkpoints interleaved; pages of 200 nodes; 1M events stay responsive. |
| TM-02 | Every node shows the five actions, each labelled Valid, Degraded (with an explanation) or Invalid (with a reason): VIEW HISTORY, RESTORE FILE/GIT STATE, BRANCH FROM CHECKPOINT, REPLAY ACTIONS, RESUME SESSION. |
| TM-03 | VIEW HISTORY is always read-only. |
| TM-04 | RESTORE first previews every file change (overwrite, create, delete, keep untracked), takes a **safety checkpoint**, requires a native confirmation, is refused while live threads write to the workspace, never touches ignored files, and never moves HEAD unless "reset branch" is explicitly chosen (`git.commit` + `destructive` through TK). |
| TM-05 | BRANCH FROM CHECKPOINT creates a new branch (or worktree) at the checkpoint without touching the current working tree. |
| TM-06 | REPLAY ACTIONS lists only actions with a complete recorded `NormalizedAction` (TK action log); each step is re-evaluated by TK under the *current* mode; nothing reuses an old approval; the UI states that model reasoning is not replayed. |
| TM-07 | RESUME SESSION is Valid only if the provider supports resume and the thread has a provider session id; otherwise it offers "start a new thread with this checkpoint's context" (CTX preview). |
| TM-08 | Checkpoints are automatic (turn start when the workspace changed, task start, before restore, before automation runs) and manual; rate-limited; the store quota is enforced and visible. |
| TM-09 | Handoffs (HS) and recoveries (PC) appear on the timeline. |

### 7.5 RW — Distributed Workspaces (LOCAL + SSH REMOTE)

| # | Criterion |
| --- | --- |
| RW-01 | Connection states: OFFLINE, CONNECTING, AWAITING HOST-KEY CONFIRMATION, CONNECTED, RECONNECTING (attempt, next retry), AUTH FAILED (method), HOST KEY CHANGED (expected vs presented fingerprint). AWAITING HOST-KEY CONFIRMATION is an explicit extra state, needed for "no silent acceptance". |
| RW-02 | Unknown host: nothing proceeds until the user compares the SHA-256 fingerprint in a native dialog; a match in the user's `known_hosts` is shown as such but still confirmed on first KalCode use. |
| RW-03 | Changed host key: the connection is refused, no credentials are sent, and replacing the key needs a native confirmation that shows both fingerprints. |
| RW-04 | Passwords and key passphrases are stored only if the user opts in, only in the OS secure store (`secret_ref`); private keys are never copied; the SSH agent is supported; agent forwarding, X11 and port forwarding are off by default. |
| RW-05 | A remote workspace is a `workspaces` row with `location = ssh`; the same list, the same Code surface and the same terminal UX (remote PTY channel) apply. |
| RW-06 | Remote file handles are contained under the remote root (remote `realpath`, symlink escapes rejected). |
| RW-07 | Agent-initiated remote actions pass TK with `remote.connect` / `terminal.execute` / `filesystem.*` scopes and the remote containment check. |
| RW-08 | Reconnect uses exponential backoff (1 s → 30 s) and keeps the workspace usable offline (cached metadata, honest state). |
| RW-09 | Phase 2: provider sessions run on the remote host under the user's own remote sign-in, with an `env -i` allow-list wrapper; PC shows them as RECONNECTABLE only when the provider supports resume. |

### 7.6 PP — Provider Profiles

| # | Criterion |
| --- | --- |
| PP-01 | A profile is named, provider-specific and versioned; its settings come only from the adapter's setting descriptors. |
| PP-02 | Each setting shows how it applies: *provider-native* (with the flag), *KalCode-enforced* (concurrency, requests/minute, turn timeout), or *approximate* (with an explanation). Unsupported settings are never shown without that explanation. |
| PP-03 | Defaults bind at global / workspace / agent / mission / thread; resolution precedence is thread > mission > agent > workspace > global, and the UI shows where each value came from. |
| PP-04 | Profiles never carry permission authority (no mode, no rules); a test proves applying any profile cannot change a thread's permission decision. |
| PP-05 | `provider_profile.applied` records profile id + version per thread session, and any settings not applied (with reasons). |
| PP-06 | Editing a profile creates a new version; running threads keep the version they started with. |

### 7.7 MEM — Evidence-Backed Memory

| # | Criterion |
| --- | --- |
| MEM-01 | Every record has a scope (global / workspace / agent / mission), kind, subject, statement, origin and ≥ 1 evidence item (event, file + hash + range, commit, verification, thread message, or explicit user statement). |
| MEM-02 | Confidence is a bounded score with a visible basis (evidence kinds, age, verification); it is never presented as certainty. |
| MEM-03 | Staleness: changed or missing evidence marks the record stale, with the reason; checks run in the background. |
| MEM-04 | Contradictions: same scope + subject with incompatible statements are flagged on both records (deterministic); provider-assisted detection is opt-in and previewed. |
| MEM-05 | Inspect, correct (new revision), verify (re-check evidence), pin, ignore and delete all work; delete removes the statement and evidence content (only an id tombstone and `memory.deleted` remain). |
| MEM-06 | Memory reaches providers only through CTX packages (preview + firewall); automatic inclusion of pinned records is opt-in per workspace. |
| MEM-07 | Agents write memory only through TK (`memory.write`); agent-written records start at low confidence and are marked as agent-written. |
| MEM-08 | Retrieval ≤ 20 ms over 10k records (FTS5). |

### 7.8 CTX + FW — Universal Context Drop and Context Firewall

| # | Criterion |
| --- | --- |
| CTX-01 | Typed items: file, file range, selection, terminal excerpt, diff, event range, memory record, thread excerpt, text. Files are referenced by handle. |
| CTX-02 | A preview shows every item, its size, its firewall verdict and redactions; any item can be removed before sending. Nothing is sent without the preview being confirmed (UI or KalVoice-opened preview). |
| CTX-03 | Provider-safe translation to what the target provider accepts (`contextLimits`); oversize packages are refused or trimmed with an explanation. |
| CTX-04 | At send time the content hash must match the previewed hash; otherwise the preview is redone. |
| FW-01 | The firewall runs before **every** KalCode-originated provider send: context packages, handoff capsules, memory injection, automation prompts, delegation prompts, KalVoice reasoning. User-typed prompts get a warn-and-confirm on secret patterns (user authority). |
| FW-02 | Blocks secrets (shared redactor + detectors), ignored paths (`.gitignore`, workspace "never share" globs, built-in sensitive names such as `.env*`, keys and credential files), items outside the mission scope, items outside the workspace, binaries. Sensitivity *secret* is never overridable; *confidential* needs per-item confirmation. |
| FW-03 | Every block, redaction and override is logged (`context_firewall_log`, `context.blocked`). |
| FW-04 | Honest limit, stated in the UI: the firewall covers what KalCode sends. A provider reading files with its own tools is governed by TK/Z4 and the provider mapping; "never share" globs are also offered as TK deny rules for `filesystem.read`. |

### 7.9 AUT — Event-Driven Engineering

| # | Criterion |
| --- | --- |
| AUT-01 | An automation = trigger (event types/filters, schedule, manual) + conditions + actions + permission mode + optional verification + notification policy + limits. |
| AUT-02 | Every action runs with origin `automation` through TK under the automation's mode; Bypass needs an explicit user choice with confirmation and a persistent indicator, and remote-consequential scopes still ask (the run waits in the approval queue). |
| AUT-03 | Loop detection: a run triggered by an event whose causation chain already contains the same automation is `loop_prevented`; chain depth is capped (default 3, hard cap 5). |
| AUT-04 | Rate limits (runs/hour), cooldowns and max concurrent runs are enforced; skipped runs are recorded with the reason. |
| AUT-05 | Global kill switch: turning it on stops all runs immediately (including threads/commands they started); turning it off needs a native confirmation. KalVoice can turn it on, never off. |
| AUT-06 | Templates interpolate only typed ids and enumerations; provider-originated free text is passed as quoted, firewalled context labelled untrusted. |
| AUT-07 | Run history with the trigger event, chain, decisions and outcome; notifications (in-app) with severity. |
| AUT-08 | Trigger matching costs ≤ 1 ms per event for 100 automations (index by event type). |

### 7.10 UD — Developer Utility Dock

| # | Criterion |
| --- | --- |
| UD-01 | Docks into Code Mode (bottom/right), opens from the palette; tools: API inspector, JSON, regex, process monitor, port inspector, environment viewer, SQLite viewer, scratch terminal, scratchpad, diff, encoding/hash. |
| UD-02 | JSON (5 MB ≤ 300 ms), regex (worker with a timeout), diff (shared `DiffView`), encoding/hash run client-side in Web Workers; the UI never freezes on catastrophic regexes. |
| UD-03 | Process monitor and port inspector read from RG's sampler; KalCode-started trees are labelled (thread, terminal). Terminating: KalCode-started processes → confirm; other processes of the current user → native confirmation; system, other users' and KalCode's own processes → refused. |
| UD-04 | Environment viewer: names shown; values redacted by default; reveal is per value, with a native confirmation, and never logged; shows what terminals and providers actually receive after KalCode's sanitization. |
| UD-05 | SQLite viewer: a file chosen in the native picker, opened read-only (`SQLITE_OPEN_READ_ONLY`, `query_only`); an authorizer denies ATTACH, writes, PRAGMA writes and extension loading; 5 s interrupt; ≤ 500 rows per page. |
| UD-06 | API inspector: requests from native with timeouts and size caps; no automatic credentials or cookies; link-local and metadata addresses blocked unless the user confirms natively; the first request to each new host per session needs a native confirmation; only method + host are recorded in events. |
| UD-07 | Scratch terminal uses Z1's PTY (home folder or active workspace); scratchpads persist locally. |

### 7.11 HS — Provider Hot-Swap with Intelligent Handoff

| # | Criterion |
| --- | --- |
| HS-01 | The capsule contains only observable or reconstructable state: objective, originating request, mission/task, acceptance criteria, steps done/remaining (from structured events), decisions, workspace/repo/branch/worktree, files changed + diff, tests and results, build status, errors, pending permissions (listed, **not transferred**), relevant memory/artifacts/approved context, and a provider-independent summary. |
| HS-02 | The structured summary is generated deterministically; a model-written summary (from the user's own provider) is optional and labelled as such. |
| HS-03 | The capsule is a CTX package: it passes FW and a user preview before it reaches the new provider. |
| HS-04 | Modes: manual; assisted (recommendations from PH signals, never acted on); automatic failover only when the user's policy explicitly enables it for that provider. The default is off. |
| HS-05 | The new thread runs in the same workspace/worktree with a permission mode no broader than the old one; pending approvals are expired and re-asked. |
| HS-06 | Handoffs are recorded (`provider.handoff_*`, capsule stored) and shown on the TM timeline, with the old and new thread linked. |
| HS-07 | Failure isolation: if the capsule cannot be built, the old thread is untouched and the user gets the reason. |

### 7.12 LOC — Universal Session Locator (built in Z7-W2)

| # | Criterion |
| --- | --- |
| LOC-01 | Searches threads, workspaces (local and remote), terminals, providers and activity first; agents, missions, tasks, worktrees, automations and files as those systems land. |
| LOC-02 | Filters: type, status, provider, workspace, recency, relevance, current activity. |
| LOC-03 | The index is local (FTS5), incremental from the event bus, rebuildable, and lives off the UI thread; a corrupt index rebuilds without affecting anything else. |
| LOC-04 | No sensitive exposure: snippets pass the shared redactor; message content is indexed only if the user enables it per workspace; KalVoice reads out names and statuses, never content. |
| LOC-05 | Query text is never stored or put into events; `session.located` records only the opened entity. |
| LOC-06 | A query over 100k entries answers in ≤ 30 ms (p95). |

### 7.13 DOC — Environment Doctor

| # | Criterion |
| --- | --- |
| DOC-01 | Check groups: KalCode (database integrity `quick_check`, migrations, data-folder permissions, disk, logs, WebView runtime), providers (from PH, never re-probed), dev tools (`git`, `node`, `pnpm`, `python`, `cargo` and more via `--version` argv probes), system (OS, long-path support, PATH sanity, shells, memory, disk), current project (repository state, `.env` ignored, large files, lockfile presence). |
| DOC-02 | Every finding offers Details / Fix / Ignore; Ignore is remembered per finding and scope, and is reversible. |
| DOC-03 | Fixes are explained before running (what changes, the scopes involved, how to undo), go through TK with origin `doctor`, are reversible where practical (checkpoint or inverse operation recorded), and are logged. |
| DOC-04 | Nothing is ever changed automatically; installing software is `package.install` and defaults to "show the command". |
| DOC-05 | A Doctor run is cancelable, runs checks in parallel with per-check timeouts (15 s), and a failing check reports "could not check" rather than failing the run. |

### 7.14 PH — Provider Health + Capacity

| # | Criterion |
| --- | --- |
| PH-01 | Per provider: connection, process, authentication, account label, models, session count, observed latency (time to first output), recent failures, rate-limit/backoff (only when observed), version, trend, recoverability hint. |
| PH-02 | No invented quota data; unknown values are shown as unknown. |
| PH-03 | State transitions emit `provider.health_changed` / `provider.capacity_changed` (transitions only, not samples). |
| PH-04 | Feeds SCH (concurrency/backoff), HS (failover signals), missions and CC through one API. |
| PH-05 | Hourly rollups persist 30 days of trend. |
| PH-06 | Health tracking cannot block a thread; a health subsystem failure reads as "unknown". |

### 7.15 BP — Workspace Blueprints

| # | Criterion |
| --- | --- |
| BP-01 | A blueprint captures layout, provider panes, profile bindings, permission defaults (mode + Custom profile reference), terminal presets, browser/Git/utility panes (where built), mission config, agent team, verification defaults, automation hooks and RG sizing; parts whose system is not built are omitted and listed. |
| BP-02 | Create, read, update, delete, "save current", apply with a preview of every change. |
| BP-03 | Export writes JSON through a native save dialog; exports never contain secrets or `secret_ref` values — only credential aliases (labels); a test scans exports for the redactor's patterns. |
| BP-04 | Import validates the schema version; imported Bypass becomes Approve plus a "needs your confirmation" item; imported automations are disabled; imported rules are shown for review; nothing applies from a repository file automatically (K4). |
| BP-05 | Applying a blueprint is one reviewed transaction per system; a partial failure reports what applied and what did not. |

### 7.16 PC — Process Continuity Engine (built in Z7-W1/W4)

| # | Criterion |
| --- | --- |
| PC-01 | After a crash or restart, a recovery inventory labels each item RESTORABLE (layout, panes, thread history, mission state, browser URLs), RECONNECTABLE (provider sessions with resume capability and id; remote hosts), RESTARTABLE (terminal shells: fresh shell, same folder), or NOT RECOVERABLE (in-memory process state, scrollback, pending approvals, live remote channels). |
| PC-02 | It reuses Z1 restart and Z3 resume; no second recovery path. |
| PC-03 | It never re-runs a command: restart means a fresh shell; the previously running command is shown as text (when KalCode knows it) and never executed. |
| PC-04 | It persists layout, panes, terminal/process metadata, mission state, thread and provider session ids, pending approvals (as history), browser URLs, branch/worktree and timestamps. |
| PC-05 | Recovery actions (reconnect, restart, resume) are user-initiated or policy-allowed, and go through TK. |
| PC-06 | `continuity.recovery_summarized` is emitted once per startup; per-item recovery is already covered by `thread.*` / `shell.*` events (no duplicates). |
| PC-07 | The inventory is ready ≤ 200 ms after the core starts (200 threads, 50 terminals), without delaying the first paint. |

### 7.17 TK — KalCode Trust Kernel

| # | Criterion |
| --- | --- |
| TK-01 | One evaluator: every origin (thread, user UI, KalVoice, agent, delegation, automation, doctor, continuity, remote, utility) calls `TrustKernel::evaluate`; a static test fails if a crate performs a consequential operation without a kernel decision (review checklist + architecture test on the command layer). |
| TK-02 | Invariants K1–K10 (`TRUST_KERNEL.md`) hold in every mode including Bypass; property tests over random actions/modes/rules/ceilings. |
| TK-03 | Repository content cannot expand authority (no repo-provided rules, profiles, hooks or provider project settings; blueprints and automations from files are inert until reviewed). |
| TK-04 | Agents, KalVoice and automations cannot change any policy, including their own (refused + audited, extends Z4). |
| TK-05 | Ceilings compose (child ≤ parent) and only restrict. |
| TK-06 | Significant decisions audited in `permission_audit`; every Allow/Deny/Ask for non-read scopes is recorded in `permission_action_log` (bounded retention); blocks emit `trust.action_blocked`. |
| TK-07 | `explain(actionId)` gives the full decision path (invariant, ceiling, rule, baseline, grant) in words. |
| TK-08 | Native confirmation is required exactly for the D8 set; the WebView cannot complete those actions alone (tested with a forged IPC call). |
| TK-09 | Evaluation p50 ≤ 0.5 ms, p99 ≤ 5 ms for commands ≤ 16 KiB (Z4 classifier budget kept). |

### 7.18 DI + BR — Diff Intelligence and Blast Radius

| # | Criterion |
| --- | --- |
| DI-01 | Attribution per changed file (and hunk where observable): provider, agent, mission/task, human, or unknown, with confidence (exact when a recorded write matches the content hash; likely from time windows; unknown otherwise). |
| DI-02 | Overlap and conflict detection across threads, worktrees and tasks, with a confidence; feeds SCH. |
| DI-03 | Change classes: architecture, behaviour, API contract, dependency, database, security-sensitive, config, tests, docs, generated; each with a confidence and the rule that produced it. |
| DI-04 | Integrates with Verification (which tests touch changed files), TM (attribution on timeline nodes), CC. |
| BR-01 | Impact beyond the changed files from import references, test coverage links, co-change history, and config/migration/CI/public-API categories; each impacted item has reasons + LOW/MEDIUM/HIGH likelihood; the UI says "may affect" and never claims certainty. |
| BR-02 | Analysis is cancelable and runs in the background on the read-only connection: ≤ 2 s for a 50-file diff in a 10k-file repository. |

### 7.19 RG — Workspace Resource Governor

| # | Criterion |
| --- | --- |
| RG-01 | Samples CPU, RAM, GPU/VRAM (where the platform exposes it; otherwise "not available"), disk IO and free space per workspace volume, network throughput, process count, and provider/terminal process trees. |
| RG-02 | Adaptive sampling: 0.2 Hz idle, 1 Hz while tasks run or a resource view is open; ≤ 1 % of one core at 1 Hz. |
| RG-03 | Modes Conservative / Balanced / Performance / Custom set pressure thresholds and max concurrent provider sessions; the mode is a setting, not a permission. |
| RG-04 | Pressure transitions emit `resource.pressure_changed`; samples stream on channels and are never events. |
| RG-05 | Feeds SCH hold reasons (P4); before that it warns on thread creation and never blocks. |
| RG-06 | It never terminates or suspends user processes; suggestions go through UD process control (explain + ask + TK). |

### 7.20 BL — Benchmark Lab

| # | Criterion |
| --- | --- |
| BL-01 | Per provider × model × profile × task class: verification pass rate, first-pass tests, retries, time, tool failures, regressions, handoffs, and cost only when the provider reports it *and* the user enables its display. |
| BL-02 | Minimum sample size per cell (default n ≥ 10), with intervals (Wilson for rates); below the minimum the cell reads "not enough data". |
| BL-03 | Advisory only: it never changes providers, profiles or schedules; recommendations link to the evidence. |
| BL-04 | Local only: no code, prompts or results leave the device; a zero-cost/network test proves no outbound calls. |
| BL-05 | Outcomes are rebuildable from events + Z9/Z10 tables. |

### 7.21 FA — Failure Autopsy

| # | Criterion |
| --- | --- |
| FA-01 | Findings are labelled CONFIRMED (deterministically checked evidence linked), LIKELY (heuristic, with a confidence), or UNKNOWN. Provider-assisted findings (opt-in, previewed) can never be CONFIRMED on their own. |
| FA-02 | Inputs: failing verification, timeline window, tool failures, exit codes, diff since the last passing checkpoint, DI classes. |
| FA-03 | Remediation proposals (test, skill, rule, memory) are created only after the user accepts them; accepting runs through the normal path (a thread under its own mode writes the test, the Z4 UI creates the rule, the MEM API creates the memory). "Skill" shows as unavailable until Z11. |

### 7.22 KalVoice (K track)

| # | Criterion |
| --- | --- |
| KV-01 | Every intent in `CONTRACTS_ADVANCED.md` §8 is recognized by the deterministic grammar; ambiguous or compound requests go to Reasoning. |
| KV-02 | Safety asymmetry: KalVoice may make things safer directly (pause, stop, hold, kill switch on, disconnect). Anything that broadens authority or is destructive opens a preview or confirmation in the UI (restore, trust a host key, kill switch off, apply blueprint, send context, handoff, delete memory). |
| KV-03 | Spoken reports contain names, statuses and counts only — never file contents, memory statements or secrets. |
| KV-04 | Each top-level request counts as one KalVoice Request, as today. |

---

## 8. Cross-cutting behaviour

- **Context Firewall** sits inside `crates/context` and is called by CTX, HS, MEM, AUT, ORG
  (delegation prompts) and KalVoice reasoning. There is no second scanner.
- **Blast Radius** is a module of `crates/diffintel`: it consumes DI change facts and adds impact.
- **Failure Autopsy** is a module of `crates/outcomes`: it shares task outcomes with BL.
- **Notifications** are built once in `crates/notifications` (Z7-W3). AUT, DOC, PH, PC, HS and SCH
  create notifications through its API.

---

## 9. Security review items

Each item is a review gate: a threat model before implementation and a review before merge.

| Area | Threats | Required controls |
| --- | --- | --- |
| SSH / remote (RW) | MITM on first contact, silent host-key change, credential theft, agent-forwarding abuse, remote path escape, remote command injection | Explicit fingerprint confirmation (native dialog); HOST KEY CHANGED refuses and sends no credentials; secrets only in the OS store; agent forwarding/X11/port forwarding off by default; argv-only remote exec with `env -i` allow-list; remote `realpath` containment; keepalive + timeouts; transport behind a trait (spike first). |
| Remote exec (RW-2, AUT, HS) | Running provider CLIs remotely with unexpected authority | Same permission mapping as local; TK remote scopes; remote provider sign-in is the user's own; no KalCode credentials remotely. |
| Filesystem (CTX, TM, UD, DI, DOC) | WebView path injection, TOCTOU, symlink escapes, restore clobbering | File handles (D4) re-validated on use; restore preview + safety checkpoint + native confirmation; ignored files untouched; containment from Z4 `paths`. |
| Context sharing (CTX, HS, MEM, AUT) | Secret exfiltration to providers, prompt-injection propagation | FW on every KalCode send; hash-pinned previews; untrusted-text labelling; no provider free text interpolated into prompts; secret sensitivity never overridable. |
| Automation (AUT) | Runaway loops, authority laundering through automations, unattended destructive actions | Causation-chain loop detection, depth/rate/cooldown caps, kill switch (native confirmation to disable), origin `automation` in TK, Bypass only by explicit user choice, remote-consequential always asks. |
| Environment variables (UD, DOC, RW) | Secret display, exfiltration via the API inspector | Redacted by default, reveal needs native confirmation, never logged; API inspector new-host confirmation. |
| DB viewer (UD) | Writes, ATTACH to KalCode's database, extension loading, runaway queries | Read-only open + `query_only` + authorizer denying ATTACH/writes/PRAGMA writes/extensions + progress-handler timeout; the file comes from the native picker. |
| Process control (UD, RG) | Killing arbitrary or system processes from a compromised WebView | Ownership classification; system/other users/KalCode refused; non-KalCode processes need a native confirmation; RG never kills. |
| Restore (TM) | Data loss, restoring secrets into tracked files, moving HEAD | Safety checkpoint, preview, native confirmation, HEAD untouched by default, `destructive` scope for resets. |
| Delegation (ORG) | Privilege escalation, loops, grant transfer | Ceiling = parent ∩ contract (property-tested); cycle and depth refusal; grants never transfer; no Bypass for delegates. |
| Trust Kernel (TK) | A bypass path around the evaluator; policy tampering by agents; repository-sourced authority | Single evaluator, architecture test, invariants above modes, repo config inert, audited refusals. |
| Doctor fixes (DOC) | "Fix" as a vector for arbitrary commands | Fixes are a fixed catalog of typed operations (no free-form commands), each evaluated by TK and logged with its undo. |
| Continuity (PC) | Re-running dangerous commands after a crash; resurrecting stale approvals | Never re-executes; stale approvals stay expired (Z4 §5). |
| Blueprints import (BP) | Malicious blueprint that grants authority or ships automations | Schema validation; Bypass downgraded; automations disabled; rules shown for review; no auto-apply. |
| Hot-swap failover (HS) | Leaking context to a provider the user did not choose; mode escalation on failover | Failover targets listed explicitly in policy; FW + preview (policy may pre-approve structured fields only, never file contents); mode never broader. |
| Locator (LOC) | Index leaking secrets in snippets | Redacted snippets; content indexing opt-in; no query logging. |
| Benchmark (BL) | Leaking code or prompts | Local only; zero-cost/network test. |
| Provider panes / hook bridge (Z7-W4) | Forged hook calls from other local processes approving actions; a repository's provider settings or hooks running code; stale-session hooks; fail-open when KalCode is down | Hooks come only from KalCode's session-scoped `--settings` (project/local setting sources excluded, K4); the bridge talks over a per-user named pipe / Unix socket (OS ACL) with a per-session secret, never a TCP port; payloads schema-validated, bounded and filtered (only the first prompt is forwarded, for the title, and never stored); PreToolUse fails closed (exit 2) when KalCode is unreachable; the forbidden provider modes/flags are never used (`PROVIDER_PANES.md` §4). |
| Workspace rail actions (Z7-W2) | Path injection through "reveal", clone URL abuse | Native resolves paths from ids; add-repository clones through Z6a argv with TK evaluation (`network.other`, git scopes); URLs validated; no shell strings. |
| Browser sign-in (Z7-W5) | Token interception, login CSRF, credential entry in a compromised WebView | System browser only; PKCE + state; loopback redirect bound to 127.0.0.1 with a random port and single use (or a registered URI scheme); 10-minute timeout; entitlement documents verified with compiled-in keys (`crates/entitlements`). |

---

## 10. Performance budgets

| System | Budget |
| --- | --- |
| L-1 `events_query` | p50 ≤ 15 ms for 500 rows over 1M events with correlation filters (indexed). |
| TM timeline | First page ≤ 150 ms at 1M events; virtualized; aggregation on the reader connection. |
| TM checkpoint | ≤ 1 s for a 10k-file repository with no content changes (temporary index seeded from the user's index); ≤ 5 s for 1k changed files. |
| SCH | ≤ 5 ms per pass for 200 tasks; recompute debounced 100 ms on relevant events. |
| RG | ≤ 1 % of one core at 1 Hz; process list ≤ 50 ms for 1,000 processes. |
| CC / ORG graph | 60 fps pan/zoom at 200 nodes; clustering beyond 500; first paint ≤ 300 ms. |
| CTX / FW | ≤ 50 ms per MiB scanned; default package cap 2 MiB. |
| MEM | Retrieval ≤ 20 ms at 10k records; contradiction scan in the background, ≤ 1 s per 10k records. |
| AUT | Trigger match ≤ 1 ms per event per 100 automations. |
| LOC | ≤ 30 ms p95 at 100k entries; incremental indexing ≤ 2 ms per event on the reader/writer path off the UI thread. |
| PC | Inventory ≤ 200 ms after core start; does not delay first paint (existing startup budgets unchanged). |
| DI / BR | Attribution ≤ 5 ms per file change; BR ≤ 2 s for a 50-file diff at 10k files. |
| TK | p50 ≤ 0.5 ms, p99 ≤ 5 ms per evaluation. |
| UD | JSON 5 MB ≤ 300 ms (worker); SQLite page ≤ 50 ms; regex worker timeout 2 s. |
| RW | Connect timeout 15 s; keepalive 15 s; added echo latency ≤ 20 ms on LAN. |
| Global | Idle CPU of `kalcode.exe` stays ≤ 5 % of one core and idle working set within existing budgets (`docs/PERFORMANCE.md` §4). Background samplers pause when their views are hidden, except while tasks run. No system emits high-frequency data as events. |
| Z7 panes / Dashboard | 20+ panes: offscreen xterm views detached, unfocused panes ≤ 4 flushes/s; resize/split at 60 fps; Dashboard event batch ≤ 16 ms at 50 threads; rail and card lists virtualized; hook bridge ≤ 2 ms per hook event and never blocks the PTY. |

---

## 11. Failure isolation

- Supporting systems (PH, RG, LOC, PC, DI, BR, BL, FA, MEM, DOC, CC) run behind `Option<Arc<…>>`
  seams: if one fails to start, KalCode logs it, marks it unavailable and continues.
- Background work runs on its own threads on the read-only connection. It never holds the writer
  lock while calling providers, git or the network (the Z3 rule, extended).
- Rebuildable state (LOC index, DI caches, BL outcomes, PH rollups) is dropped and rebuilt on
  corruption.
- TK is the exception: if the kernel cannot evaluate, the action is **denied** (fail closed),
  while reads that Z4 already allows stay unaffected.
- QA owns fault-injection tests for X-05 per system.

---

## 12. Integration plan

### 12.1 Continuous small merges

1. Every system lands as a sequence of vertical slices (contract use → crate + tests → IPC → UI),
   each ≤ ~1,500 changed lines excluding generated files, merged `--no-ff` to `main` behind its
   feature flag (`gated`).
2. Merge gate (unchanged, plus): `pnpm check`, `cargo test`, branding, zero-cost and capability
   checks, relevant UI/E2E suites, the system's acceptance rows so far, a security review for §9
   items, and perf for §10 items.
3. The lead integrates registration-file edits and contract changes; writers merge `main` daily.
4. Flags move `gated` → `preview` (beta channel) only when the system's acceptance matrix is PASS
   except rows explicitly marked PENDING-INTEGRATION; → `available` when all rows PASS on the
   release binary.

### 12.2 Mock policy

- Allowed only behind typed seams (traits in contracts or crate seams, like `AskUnlessReadGate`),
  named `Fake*` / `Dev*`, compiled only under `cfg(test)` or a `dev-fakes` feature that release
  builds do not enable.
- Every mock is listed in the register below with its replacing item. **No release while any row
  is open.** QA adds a check that release binaries contain no `dev-fakes` symbols.

| Mock | Used by until | Replaced by |
| --- | --- | --- |
| Fake task graph (`FakeMissionSource`) | nobody (SCH waits for Z9, D1) | — |
| `FakeVerificationResults` | BL/FA unit tests only | Z10 |
| `FakeRemoteTransport` | RW UI tests | RW phase 1 SSH transport |
| `FakeAgentDirectory` | PP agent-level binding tests | Z8 |
| `FakeCheckpointStore` | TM UI tests before Z6a merges | Z6a |
| In-memory IPC fixtures (existing pattern) | UI tests | real commands (UI-test build only, never shipped) |

### 12.3 What the website may claim, and when

| When | May claim |
| --- | --- |
| System `gated` | Nothing. |
| System `preview` (beta channel) | "In preview" on a roadmap/changelog page, describing only what passes. |
| System `available` on stable, acceptance PASS | Feature copy limited to the accepted rows. |

Never, for any system: "undo anything" (TM restores files; it does not undo remote effects or
model reasoning), certainty for BR/DI/FA/BL, quota or rate-limit knowledge PH does not have,
remote provider support before RW-2, "semantic search" without the on-device model, or any
comparison with other products. Pricing and plan placement come only from
`packages/protocol/src/plans.ts`.

---

## 13. KalVoice (K track)

The KalVoice owner (Z12 thread and its successor) adds each wave's intents after that wave's APIs
merge, from the list in `CONTRACTS_ADVANCED.md` §8. Grammar tests cover positive, negative,
negated and compound phrasings for every intent, and the safety asymmetry (KV-02).

---

## 14. Open decisions for the owner and lead

1. **Plan placement** of the new systems (Free / Pro / MAX). Constraint: safety features (TK,
   FW, host-key verification, kill switch, restore safety, Doctor) are never paywalled, like
   permission modes. `PRODUCT.md` §6 already places agents/automations in Pro and advanced
   missions / event automations / highest concurrency in MAX.
2. **Automations and Bypass:** allow with explicit confirmation (recommended; consistent with
   "every mode on every plan") or forbid Bypass for unattended runs.
3. **Profile precedence** of mission over agent (recommended: thread > mission > agent >
   workspace > global).
4. **Event retention:** TM and BL rely on the event log; propose "never auto-delete events
   younger than 180 days" and a later compaction design.
5. **Navigation:** one new top-level surface (Command Center). "History", "Intelligence" and
   "Workspaces" are sections (Command Center / Code workspace menu), not new nav items, unless the
   owner wants a History surface.
6. **Message-content indexing** in LOC: off by default (recommended), opt-in per workspace.
7. **Native confirmations for Bypass** (D8), for consistency with the other high-risk
   confirmations.
8. **Z7 status mapping:** `interrupted` and `waiting_for_dependency` shown as IDLE with a
   qualifier; FAILED counted under "Waiting for you"; the approval accent must move off amber
   (reserved for PAUSED).
9. **Provider panes by default:** user-created threads run interactively in PTY panes; headless
   threads remain for missions, automations, delegations and handoffs (`PROVIDER_PANES.md`).
   Confirm before Z7-W4 starts.
10. **Provider marks:** neutral glyph + name until written permission is recorded (§17).

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| Z4 merge slips, delaying TK-1 and everything after it | Z4 pre-merge amendments (§6) are small; P0–P2 items need TK only for their *consequential* actions and can ship read paths first. |
| Only one working provider adapter (Claude Code) | HS, BL and PH comparisons are weak with one provider; Codex/Gemini adapters should be scheduled (outside this plan) before HS/BL leave preview. |
| Checkpoint disk growth | Quota, pruning, visible usage (D2). |
| SSH library gaps on Windows (agent, key types) | Phase-0 spike; `RemoteTransport` trait with the system `ssh` fallback. |
| Hot-file merge contention | CA-n contracts first, batched registration edits, single-owner directories. |
| Scope creep in the Command Center | CC owns only the shell and registry; panels belong to their systems. |
| Provider hook APIs change between CLI versions | Adapters pin a minimum version per provider (as Z2 does), validate hook payload schemas, and degrade to process/PTY-only status with an honest "limited status" badge. |
| Codex hook trust and Gemini CLI settings injection are unverified | `PROVIDER_PANES.md` §7 lists them as verification items; those panes ship with process/PTY status and in-provider approvals until verified. KalCode never uses trust-bypass flags. |

---

## 16. Campaign Z7 — Workspace, Dashboard, Thread Panels & Returning-User UX

> **Owner requirement (2026-09-24) — full-window workspace.** KalCode fills 100% of the window
> right of the sidebar; no surface sits in a narrow centred container. Code Mode's right side is
> one flexible pane canvas (Claude / Codex / browser / dashboard / files / Git / …) with horizontal
> and vertical splits, free resizing, drag-rearrange, maximize, collapse/reopen, and per-workspace
> persistence. Wide and ultrawide windows gain more panes, larger terminals, browser preview,
> Command Center, mission graphs, provider health and resource usage — composition, not
> stretching; prose keeps a readable measure. Required visual verification in the real app at
> 1366×768, 1440×900, 1920×1080, 2560×1440 and ultrawide (3440×1440). The surface-level
> max-width removal ships in wave 2; the pane canvas is Z7-W1.

Status: **PROPOSED**. Starts **after wave 2 (Z1 + Z3) and Z4 merge**: it rewrites the same shell,
sidebar, Dashboard and thread code, so no Z7 work starts before then. The owner's layout reference
is used for interaction model and density only. KalCode's own design system (`docs/DESIGN_SYSTEM.md`)
and brand govern every visual, and the reference's source is not named.

### 16.1 The architectural pivot: provider panes run the real CLI

Decided in `docs/PROVIDER_PANES.md`. In summary:

- **New Thread → Claude Code starts the real, unmodified `claude` process in a Z1 PTY pane.** The
  pane shows the provider's own TUI. KalCode does not imitate a terminal or re-render the
  conversation.
- **Status comes from structured, officially supported channels only**: the provider's hook
  system, configured by KalCode at launch through a session-scoped settings argument (Claude
  Code `--settings` hooks; Codex `notify`, hooks once their trust flow is verified, and OSC 9
  approval notifications; Gemini CLI hooks once verified). Process and PTY state (spawned,
  exited, exit code) complete the picture. Model prose is never parsed for state.
- **Permissions:** KalCode sets the provider's permission mode at launch from the thread's
  KalCode mode (never the broadest provider modes). It registers a KalCode `PreToolUse`
  (Claude Code) / `PermissionRequest` hook that asks the Trust Kernel. Where hooks are active,
  KalCode is the approver: its prompt appears as a pane overlay and in the approval queue. If it
  is unanswered at the hook timeout, the provider's own prompt takes over. Providers without
  trusted hooks keep approvals in their own prompt, and KalCode mirrors PERMISSION REQUIRED.
- **Headless threads remain** (the Z3 stream-json runtime) for missions, automations,
  delegations, KalVoice background work and handoffs. Both kinds are rows in `threads`, with a
  runtime kind, one normalized status model and one Dashboard.

### 16.2 Ownership (non-overlapping; ≤ 4 writers at once)

| Writer | Area | Owns |
| --- | --- | --- |
| **Z7-W1** | Pane system + layout store | Split tree (horizontal/vertical), resize, drag, reorder, maximize, collapse, close, reopen, dock; presets 2/3/4/6/custom per workspace; keyboard operation; tabs within a pane; layout persistence (`workspace_layouts`, `layout_presets`); offscreen render suspension. `apps/desktop/src/shell/panes/**`. |
| **Z7-W2** | Workspace rail + persistence, returning-user home, folder surface, recent work, search | Rail groups (pinned, recent, folders), thread tree with provider rows and counts, badges, all rail actions; home greeting and summary; folder/project surface; recent work; LOC index crate and search wiring. `shell/rail/**`, `surfaces/home/**`, `surfaces/folder/**`, `crates/locator`. |
| **Z7-W3** | Live Dashboard, cards, notification center, widgets | Dashboard rewrite (counts, chips, grouping, cards, inline approvals, card → pane focus) at 1–50+ threads; notification center (`crates/notifications`, used later by AUT, DOC, PH, PC, HS); the dockable widget framework with defaults. `surfaces/dashboard/**`, `shell/notifications/**`, `shell/widgets/**`. |
| **Z7-W4** | Thread-pane / provider-runtime integration | Interactive provider launch in PTY panes, `kalcode-hook` bridge, status mapping, thread-pane header, auto titles, the KalCode approval path for interactive sessions, Process Continuity inventory and restore-on-return labels. `crates/providers/src/interactive/**`, `crates/hook-bridge`, `crates/continuity`, `surfaces/threads/pane/**`. |
| **Z7-W5** (P6, with Z13) | Account and auth UX | Website "Welcome back" account page; desktop browser sign-in flow. |

### 16.3 Normalized display statuses

Display statuses are a pure function of Z3's `ThreadStatus` (18 values), which is itself driven
only by structured events (headless) or hook, process and PTY signals (interactive). The mapping
lives once, in `packages/protocol` (generated from Rust), and is used by the Dashboard, rail,
panes, notifications and KalVoice.

| Display | `ThreadStatus` values | Tone (always paired with text + glyph) | Dashboard chip |
| --- | --- | --- | --- |
| STARTING | `starting` | muted, progress glyph | Working |
| WORKING | `active`, `thinking`, `running_tool`, `running_command`, `editing` | working green | Working |
| TESTING | `testing` | working green, test glyph | Working |
| REVIEWING | `reviewing` | working green, review glyph | Working |
| PERMISSION REQUIRED | `waiting_for_permission` | neutral, emphasized, shield glyph | Waiting for you |
| WAITING FOR YOU | `waiting_for_user` | waiting neutral | Waiting for you |
| IDLE | `idle`; `waiting_for_dependency` (qualifier "waiting on …"); `interrupted` (qualifier "stopped · resumable") | idle muted | Idle |
| PAUSED | `paused` | paused amber | Idle |
| DONE | `completed` | high-contrast neutral | Done |
| FAILED | `failed` | failed red | Waiting for you (needs attention) |
| RECOVERING | `recovering` | recovering blue | Working |
| OFFLINE | `offline` | muted, offline glyph | Idle |

Decisions flagged for the owner: `interrupted` and `waiting_for_dependency` map to IDLE with a
qualifier, because the list has no STOPPED or BLOCKED. FAILED counts under "Waiting for you",
because Z3 treats it as needs-attention. The Z5 amber hairline on approvals must change, because
the owner reserves amber for PAUSED.

### 16.4 Design requirements by area

- **Returning-user home.** A rotating greeting from a fixed pool, time-of-day aware. It never
  repeats one of the last 5 shown (history in `settings`). **Name source (owner decision):** a
  display name the user sets in KalCode Settings. It is a local, typed setting (`profile.displayName`,
  1–60 characters, no control characters) stored in the Z0 `settings` table, and it emits
  `settings.changed` like every other setting. The OS account name is **not** used. After Z13, the
  account's display name may pre-fill the field once, but the user's Settings value stays
  authoritative. With no name set, the greeting drops the name ("Welcome back."). The summary
  answers — from real state only —
  *what was I working on* (threads/workspaces active in the last session, from the event log),
  *what's running* (live statuses), *what needs me* (permission required, waiting, failed),
  *what finished* (completed since the last visit, watermark `home.lastSeenSeq`), and *what can
  I resume* (the PC inventory). An empty state says so plainly; nothing is fabricated.
- **Workspace rail.** Pinned, recent and folder groups. Each workspace expands to a thread tree
  grouped by provider, with provider rows and counts, and badges (working / needs you). Actions:
  create, open folder (native picker), add repository (clone through Z6a; a user action evaluated
  by TK with `network.other` + git scopes), pin, rename, archive, remove without deleting files
  (Z1 semantics), reveal in the OS file manager (native resolves the path), search (LOC), and
  collapse. Everything persists (`workspace_rail`, `workspace_groups`; Z1 keeps `workspaces`).
- **Folder/project surface.** Files (Z6a handles), recent files (thread/hook file events + Git
  log), Git status, and the workspace as the whole context: threads, terminals, branches and
  worktrees now; agents and missions render "arrives with Agents / Missions" until Z8/Z9.
- **Pane system.** A split tree with ratios; leaves are thread panes, terminals, Dashboard,
  widgets, and later browser (Z6b) and Git panes (unavailable states until built). Resize (mouse
  and keyboard), drag to reorder or split, maximize/restore, collapse, close (the pane only — the
  process keeps running), reopen (closed-pane stack), and dock into the side dock. Undocking to a
  separate OS window is phase 2 (a second Tauri window needs a capability review). Presets
  2/3/4/6/custom are saved per workspace. Every action has a shortcut and a palette entry.
- **Thread pane header.** Provider glyph (§17) + provider name, auto-generated title (Z3
  deterministic naming from the first prompt, renamable inline), provider/model, display status,
  permission state (mode badge; the persistent Bypass indicator), overflow menu, maximize, split,
  close.
- **Live Dashboard.** Counts and filter chips (All / Waiting for you / Working / Done / Idle);
  grouping by status, project, provider, agent (after Z8) or mission (after Z9). Cards show
  provider, name, workspace, activity, status, mode, last activity and branch; clicking a card
  focuses its pane, opening it if needed. PERMISSION REQUIRED cards carry the inline approval in
  the app's order — **Deny / Approve once / Allow for thread** — through Z4 `approval_decide`.
  DONE cards carry inline follow-ups (review changes, continue, archive). Virtualized; works at
  1, 5, 10, 20 and 50+ threads.
- **Notification Center.** Actionable notifications for completed, failed, permission required,
  mission done (after Z9), provider disconnected, recovery available and automation finished
  (after AUT). Each one navigates to its entity and focuses the pane. Deduplicated and
  rate-limited. Optional OS notifications while KalCode is unfocused.
- **Recent Work, tabs, widgets.** Recent Work groups the threads, files and workspaces touched by
  day, from the event log; it answers "yesterday". Pane tabs stack several items in one pane.
  The widget framework registers small dockable widgets (Dashboard summary, approvals, recent
  work, resources after RG) with sensible defaults and a cap on how many are shown.
- **Restore on return (PC).** Layout, sizes, threads, cwd, browser URL (once Z6b exists),
  terminal metadata, Git reference, mission state and profiles are restored. Interactive
  provider sessions are RECONNECTABLE only through the provider's resume
  (`claude --resume <id>`, `codex resume <id>`); otherwise they are RESTARTABLE or shown as
  historical. Nothing re-runs a command.
- **Search.** The palette and rail search call LOC.
- **KalVoice intents.** Open a thread by meaning (LOC; lexical unless the on-device model is
  installed), filter the Dashboard by status, open a workspace (exists), resize/split/maximize
  panes, show completed, "what was I working on yesterday" (Recent Work). See
  `CONTRACTS_ADVANCED.md` §8.
- **Performance.** Virtualized rail tree, Dashboard and notification lists. Inactive panes are
  throttled (xterm writes batched, ≤ 4 flushes/s when unfocused). Offscreen panes detach their
  xterm views (Z1 attach/detach with 512 KB scrollback replay) while the PTY keeps running.
  Bounded buffers: Z1 scrollback plus bounded hook queues. Process state lives in native code,
  separate from render state. Offscreen processes are never killed.
- **Account (Z7-W5, with Z13).** The website "Welcome back" page shows plan, downloads, billing
  and the latest version. Providers appear as setup guides only: the website cannot know the
  user's local providers and must not pretend to. The desktop sign-in opens the system browser;
  the result returns via a loopback redirect with PKCE (or a registered URI scheme, decided with
  Z13). States: waiting ("Finish signing in in your browser"), open again, cancel, timeout
  (10 min), failure (typed reason). Credentials are never entered in the WebView. The signed
  entitlement document is verified by `crates/entitlements`.

### 16.5 Acceptance matrix (Z7)

| # | Criterion |
| --- | --- |
| Z7-01 | New Thread → Claude Code starts the real `claude` binary (unmodified, the user's own sign-in) in a PTY pane; the pane shows its TUI; no imitation terminal exists in the product. |
| Z7-02 | Interactive status comes only from hook/notify events, process and PTY state; a test feeds prose that looks like status and proves it is ignored. |
| Z7-03 | Launch arguments map the KalCode mode to the provider mode per `PROVIDER_PANES.md` §4 and never use the forbidden modes/flags (unit tests, as in Z2). |
| Z7-04 | A tool call in an interactive session is evaluated by TK through the hook bridge; Deny blocks it; Ask shows KalCode's approval as a pane overlay and in the queue and returns the user's decision to the provider; if unanswered at the hook timeout, the provider's own prompt takes over and the KalCode request expires (`answered_in_provider`). |
| Z7-05 | If KalCode or the bridge is unreachable, the PreToolUse hook fails closed (exit 2); the pane says so. |
| Z7-06 | Headless threads (missions, automations, delegations) keep working; both kinds appear in one Dashboard with one status model. |
| Z7-07 | Display status mapping per §16.3, generated once and shared; status is never colour-only. |
| Z7-08 | Home greeting rotates without repeating the last 5; the name comes only from the Settings display name (`profile.displayName`, persisted in `settings`, `settings.changed` emitted); the OS account name is never read; with no name set the greeting is "Welcome back."; after Z13 the account name only pre-fills an empty field. |
| Z7-09 | The home summary answers the five questions from real state; an empty install shows honest empty states. |
| Z7-10 | Rail groups, thread tree, provider rows, counts and badges update live from events. |
| Z7-11 | Rail actions (create, open folder, add repository, pin, rename, archive, remove without deleting files, reveal, search, collapse) work and persist across restarts. |
| Z7-12 | Folder surface shows files, recent files, Git status and the workspace context; unbuilt parts show honest states. |
| Z7-13 | Panes: resize, drag, split H/V, reorder, maximize, collapse, close, reopen, dock; presets 2/3/4/6/custom; all keyboard-operable; layouts saved per workspace. |
| Z7-14 | Closing or hiding a pane never stops its process; stop is an explicit action. |
| Z7-15 | Thread pane header shows provider glyph + name, title (auto, renamable), provider/model, status, permission state, overflow, maximize, split, close. |
| Z7-16 | Dashboard counts, chips, grouping and cards; card click focuses the pane; inline approval in the order Deny / Approve once / Allow for thread; correct at 1, 5, 10, 20, 50+ threads. |
| Z7-17 | Notification center: every listed kind is created from its event, navigates to its entity, and is deduplicated. |
| Z7-18 | Recent Work and "what was I working on yesterday" come from the event log. |
| Z7-19 | Restore on return restores layout, sizes, threads, cwd, terminal metadata, Git reference, profiles (and browser URL and mission state once they exist); non-restorable items are labelled historical/restartable; nothing re-runs. |
| Z7-20 | Search is served by LOC, with filters. |
| Z7-21 | KalVoice intents for Z7 work deterministically (KV-01..04). |
| Z7-22 | Performance: 20+ panes with offscreen suspension; the Dashboard processes an event batch in ≤ 16 ms at 50 threads; idle CPU/memory within `docs/PERFORMANCE.md` §4 plus a documented per-pane allowance. |
| Z7-23 | Provider marks follow §17 (neutral glyph + name unless permission is recorded). |
| Z7-24 | Account page and browser sign-in states (Z7-W5, with Z13). |
| Z7-25 | axe clean in both themes at every scenario in §16.7; keyboard paths for panes, rail and Dashboard. |

### 16.6 Owner's test list

| Test | Layer | Covers |
| --- | --- | --- |
| Greeting rotation, no repeats, display name set / cleared / absent ("Welcome back.") | Rust (settings validation) + Vitest + UI | Z7-08 |
| Workspace persistence across restart | Real-app E2E (release `e2e` binary) | Z7-11, Z7-19 |
| Pinning, groups, collapse | UI + E2E | Z7-11 |
| Recent work (today / yesterday) | Rust (event queries) + UI | Z7-18 |
| State updates (status transitions from hook/process events) | Rust (bridge with a fake provider that emits hook payloads) + UI | Z7-02, Z7-10 |
| Counts | Vitest (pure reducers) + UI | Z7-16 |
| Filters and grouping | UI | Z7-16 |
| Provider identity (glyph, name, model per pane/card) | UI | Z7-15, Z7-23 |
| Permission needed (hook → approval UI → decision → provider) | Rust integration + E2E with the fake provider | Z7-04, Z7-05 |
| Done | UI + E2E | Z7-16 |
| Resize (mouse, keyboard) | UI | Z7-13 |
| Split H/V, reorder, maximize, close/reopen | UI | Z7-13, Z7-14 |
| Layout persistence per workspace | E2E | Z7-13, Z7-19 |
| Restart restore (graceful and forced) | Real-app E2E | Z7-19 |
| Search | Rust (LOC) + UI | Z7-20 |
| Large agent counts (50+ threads, 20+ panes) | Perf harness + UI | Z7-16, Z7-22 |
| Notification navigation | UI + E2E | Z7-17 |
| Browser auth (waiting, reopen, cancel, timeout, failure) | E2E against local `apps/api` (with Z13) | Z7-24 |

The fake provider (`kalcode-fake-provider`, Z2) gains an interactive mode that renders a minimal
TUI and invokes the configured hook commands with documented payload shapes. **No test consumes
AI quota**, and real-provider interactive smoke tests stay `#[ignore]` behind owner approval, as
in Z2.

### 16.7 Visual QA list

Screenshots at 1440 / 1280 / 1024, dark and light, reviewed like earlier campaigns:
1, 6 and 20 agents · mixed providers · waiting for you · permission required · done · error/failed
· many historical threads · resized, tiny and maximized panes · empty first run · returning user
with a summary · notification center full · 50+ thread Dashboard.

---

## 17. Provider marks (logos)

Checked against each provider's published guidance on 2026-09-24:

| Provider | What the guidance allows | KalCode decision |
| --- | --- | --- |
| Claude Code (Anthropic) | "You can accurately say, in plain text, that your product … runs Claude Code." Logos and names may not be used in a way that suggests Anthropic built, endorses or partners with the product; any other use of names or logos requires written permission under the Trademark Guidelines. Sources: https://code.claude.com/docs/en/legal-and-compliance, https://www.anthropic.com/legal/trademark-guidelines | **Neutral glyph + "Claude Code" in plain text.** Logo only with recorded written permission. |
| Codex (OpenAI) | Brand guidelines at https://openai.com/brand/ (returned HTTP 403 to automated fetching, so not verified first-hand). The App Developer Terms (https://openai.com/policies/developer-apps-terms/) forbid design choices implying OpenAI created, endorses or partners with the app, and limit use of marks to the brand guidelines. | **Neutral glyph + "Codex"** until the owner verifies the brand page and records permission. |
| Gemini CLI (Google) | Plain-text references are allowed; logos need permission, and must not imply affiliation. Source: https://about.google/brand-resource-center/guidance/ | **Neutral glyph + "Gemini CLI".** |

The neutral glyphs are KalCode-designed, distinct per provider (shape + initial), and never
imitate a provider's mark. Related, from the same Anthropic page: products that run Claude Code
must run the **unmodified** binary with each user's **own** authentication, and must not
intermediate Claude usage. Interactive panes (and today's headless adapter) comply: the user
signs in through the provider's own flow, and KalCode never collects provider credentials.

## 14a. Decisions recorded (2026-09-24)

Owner decisions:

1. **Plan placement — tiered by power.** Safety systems (Trust Kernel, Context Firewall, host-key
   verification, Environment Doctor, safe restore, kill switches, permission modes) are on every
   plan. Free: Environment Doctor, Provider Health, Session Locator, Process Continuity, Utility
   Dock basics. Pro: Agent teams, Provider Profiles, Workspace Blueprints, Time Machine,
   Hot-Swap, Distributed Workspaces (SSH), scheduled automations. MAX: Command Center graphs,
   Intelligent Scheduler at high concurrency, event-driven automations, Benchmark Lab, Diff
   Intelligence. OWNER: everything, current and future. Implemented as entitlement features
   (`packages/protocol` plans + `crates/entitlements`), never as frontend-only checks.
2. **Automations and Bypass — allowed with explicit confirmation** (native confirmation when
   enabling Bypass on an automation); Trust Kernel invariants still apply.
9. **Provider panes by default** — confirmed by the owner's Z7 directive: user-created threads run
   the real provider CLI interactively; headless threads remain for missions, automations,
   delegations and handoffs.
- Returning-user greeting name: a display name set in Settings (`profile.displayName`).

Lead decisions (recommended defaults adopted): 3 profile precedence thread > mission > agent >
workspace > global; 4 never auto-delete events younger than 180 days; 5 one new top-level surface
(Command Center), others as sections; 6 message-content indexing off by default, opt-in per
workspace; 7 native confirmations for Bypass; 8 status mapping as proposed, approval/waiting
accent is neutral grey (owner's colour spec), amber reserved for PAUSED; 10 neutral glyph + name
for providers until written permission is recorded.

## 14b. Security review gates (2026-09-24 review of 1bce77f)

Release blockers are being fixed in `sec/fixes-0.1.1` (see `docs/campaigns/SEC-0.1.1.md` once
merged). These latent findings **block wiring** until fixed and re-reviewed:

- **Permission classifier dialect handling** (`crates/permissions/src/command.rs`, High, latent) and
  the further classifier gaps (git read commands with execution options, PowerShell Unicode
  dashes/smart quotes, abbreviated flags, env-var secret printing, glob arguments): must be fixed
  before any host-approval or hook bridge (Z7-W4) routes provider decisions through the engine.
- **Context Firewall** (`crates/context`): file-range scanning leaking PEM bodies, secret-format
  coverage (~25 of 37 common formats undetected), partial redaction, dropped files skipping
  never-share names, hard links, combined diffs, quadratic entropy pass: must be fixed before the
  Context Firewall is wired to any provider path (Context Drop, handoff, missions).
- **Git checkpoint store** "inside workspace" guard skipped on first use: fix before Z6a IPC wiring.
- **API (D1)** REPLACE bypass of append-only/immutability triggers: fixed in 0.1.1 work; must be in
  place before any Z13 billing or grant write path ships.
- **Early-access list**: anyone can add or remove any address (no confirmation). Needs a
  confirmation flow before the list is used for anything beyond launch notices.
