# Remaining systems census — 2026-09-25

This is a read-only implementation census against `sec/providers-harden` at
`35c99cb43699813c8aba58e1fead6a5cd536076b`, the current dirty integration tree,
`ADVANCED.md`, `CODEX-TAKEOVER.md`, and the preserved Utility Dock and Environment Doctor
worktrees. It records product truth; contracts and planning documents alone are not completion.

A focused foundation run passed **321 tests with 0 failures and 3 ignored performance tests**:

```text
cargo test -p kalcode-context -p kalcode-resources -p kalcode-locator \
  -p kalcode-notifications -p kalcode-git -p kalcode-workspace-ui
```

| Priority | Requirement | Actual implementation | Remaining production gap |
| --- | --- | --- | --- |
| P0 | Universal Context Drop and Context Firewall | `crates/context` implements packages, folder budgets, secret detection and redaction, provider translation, hash-pinned preview/send checks, and the append-only v8 store. Its 85 focused tests pass. | The crate explicitly remains library-only. Desktop has no dependency, IPC, UI, or provider-send integration, and both feature flags remain gated. Every provider/context egress must use it before context sharing is exposed. |
| P0 | Resource Governor | `crates/resources` implements a real sampler, hysteresis, bounded history, capacity advice, and a real-machine probe. Its 69 focused tests pass. | Desktop has no dependency, managed state, IPC, UI, scheduler, or provider-admission integration. Only resource event formatting exists. The feature remains gated. |
| P0 | Developer Utility Dock | The clean `p2/utility-dock` worktree preserves commit `a957a3e`, with a substantial `crates/utilities`, native IPC, permission changes, KalVoice intents, and crate tests. | The commit is not an ancestor of the current tree and is based on the older `943b001`. The canonical tree has no utilities crate, commands, or UI; the preserved commit also has no frontend Dock. Port selected changes manually, reconcile current contracts and security, then add real pane/UI and E2E. Do not merge the old branch wholesale. |
| P0 | Environment Doctor | The dirty `p2/env-doctor` worktree preserves modified contracts and permissions plus an untracked `crates/doctor` with checks, bounded cancellation, persisted ignores/fix log, and a typed permission-gated fix catalog. | The work is outside the canonical tree and uncommitted. There is no desktop state, IPC, capabilities, generated protocol, UI, or integration with current Provider Health, Resource Governor, and Locator. Harvest it before worktree cleanup. |
| P0 | Recovery and Process Continuity | Thread crash recovery/provider resume, selected-account persistence, workspace layouts, browser state, terminal restart, notifications, and the updater journal are real pieces with subsystem tests. | There is no derived continuity inventory, recovery-summary event, unified recovery UI/action path, or complete restart E2E across providers, terminals, panes, browser, approvals, and future missions. `PROCESS_CONTINUITY.md` still truthfully marks the system planned. |
| P1 | Universal Locator | `crates/locator`, native IPC, rail/search/home UI, UI tests, real-app E2E, and the privacy repairs at `b197561` are present. Tests cover synchronous opt-out purge, stale indexing races, workspace removal, authority checks, and restart; 58 focused tests pass. | `SessionLocator`, `WorkspaceHome`, and `WorkspaceRail` remain gated, so Stable hides them. Final desktop/performance certification and correct feature-state promotion remain. |
| P1 | Attention Center | `crates/notifications` is the canonical v10 persisted, deduplicated, rate-limited inbox. Native list/mark commands, an accessible side sheet, UI tests, and real desktop E2E exist; 13 Rust tests pass. | The product is still named Notifications and its feature is gated. Snooze, resolved/history views, and broad Doctor/automation/continuity sources are absent. Dismissed items are hidden rather than forming resolved history. |
| P1 | Execution Time Machine | `crates/git` implements hardened shadow-repository checkpoints, list/create/pin/diff, exact-plan safe-restore internals, additive branch export, and extensive tests. The Git suite passes 83 tests. | Checkpoint/worktree/diff native functions exist but only status/log/branches are registered. Restore is intentionally not exposed. There is no timeline UI, causal view, replay, confirmed restore orchestration, or branch-from-checkpoint flow. The feature remains gated and its document says planned. |
| P1 | Worktree mode | `crates/git::worktree` and native list/create/safe-remove functions exist, with passing lifecycle and hostile-input tests. | The commands are not registered. Folder UI states that worktree commands are not in the build, and threads do not own branch/worktree identity. It is backend-only partial work. |
| P1 | Workspace Presets and Blueprints | Pane presets for 2, 3, 4, and 6 panes plus named, shape-only presets are implemented with v9 persistence, keyboard/UI behavior, and tests. `kalcode-workspace-ui` passes 13 tests. | These presets store layout geometry only. There is no Blueprint owner, profile/permission/terminal/team/mission binding, import/export, preview/apply flow, migration, or Blueprint UI. `Blueprints` remains gated. |
| P2 | Review Center | Hardened Git status/log foundations and the shared `DiffView` component exist. | No Review surface, native workflow, evidence aggregation, or tests exist. The Git pane still says it is not in this build. |
| P2 | Compare Run | No implementation beyond unrelated ordinary uses of the word “compare” was found. | Build objective/context fan-out, optional isolated worktrees, real diff/test/time/evidence collection, side-by-side UI, persistence, and tests. |
| P2 | Diff Intelligence and Blast Radius | The hardened raw Git diff/status/checkpoint engine and shared `DiffView` are real and tested. | There is no `crates/diffintel`, dependency/test/ownership impact model, change attribution, overlap analysis, blast analysis, or product wiring. `git_diff` itself is not registered and Diff Intelligence is gated. |
| P2 | Evidence-Backed Memory | Context Firewall and Trust Kernel action contracts provide prerequisites. | No memory crate, store, lifecycle, native commands, UI, or tests exist. The Memory surface is an honest gated page. Evidence provenance, stale/contradiction handling, user correction/deletion, and governed provider injection remain unimplemented. |
| P2 | Skills, Plugins, and Automations | Surface IDs, navigation metadata, entitlements, some contracts/action kinds, and KalVoice navigation grammar exist. | Stable hides all three; development shows an honest gated page stating that nothing runs. There are no canonical backends, stores, execution paths, plugin capability scopes, automation scheduler/kill-switch runtime, native commands, or product tests. |
| P3 | Benchmark Lab and Failure Autopsy | Feature identifiers, entitlement placement, proposed contracts, and plans exist. KalVoice's local-model benchmark is unrelated to the product system. | There is no outcome store, normalization, evidence linkage, comparison UI, autopsy classification, accepted-remediation flow, native commands, or tests. Both features remain gated. |

The current desktop surfaces are Browser, Code, Dashboard, Folder, gated status, Home,
Permissions, Providers, Settings, Startup, and Threads. Native modules contain no Doctor,
Utility, Context, Resources, Review, Compare, Blueprint, Memory, Diff Intelligence, Benchmark,
Autopsy, Skills, Plugins, or Automations command owner. `flags.rs` marks every advanced feature
except Pane System as gated, including the implemented Locator, Notifications, and Git
foundations.

The dependency-safe implementation order is Context and Resource Governor product integration;
harvest Utility Dock and Environment Doctor; Continuity, Time Machine, and worktrees; Locator and
Attention production promotion; Blueprints, Review, Diff Intelligence, and Blast Radius; Memory
and Automations; then Compare Run, Benchmark Lab, Failure Autopsy, Skills, and Plugins.
