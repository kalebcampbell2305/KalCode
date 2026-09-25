# Campaign PROVIDERS-2 — Codex and Gemini CLI providers, and live Provider Health

Branch `providers/codex-gemini-health`, worktree `.worktrees/providers2`, from main `61770b4`.
Parallel writers: Z7-W1 (pane system, migrations v7–v9) and Z7-W2 (rail/home/locator, v10); this
campaign adds **no migration** and touches their areas only through the minimal edits listed in
§6.

No provider session was started and no AI quota was used. Codex (0.155.1) and Claude Code are
installed and signed in on the verification machine; Gemini CLI is not installed. The only real
provider commands run were `--help`, `--version` and `codex login status` (`real_codex_detection`:
installed 0.155.1, authenticated, through its npm shim). Every session test runs the fake
provider (`kalcode-fake-provider`, now also `codex` and `gemini` modes) replaying
official-format fixtures. Real-CLI smoke scripts are written and await the owner's approval (§7).

Criteria are PASS only when executed. **PENDING** means not built or needing a lead/owner step.

## 1. Design

| Piece | Where | Summary |
| --- | --- | --- |
| Turn engine | `crates/providers/src/turns.rs` | Neither CLI accepts a second message on a running headless process, so a session is a sequence of supervised turn processes sharing the provider's session id (first turn starts it, later turns resume it) — how the official Codex SDK drives `codex exec`. Prompt on stdin only. Interrupt kills the turn's tree; the session stays. A turn that exits non-zero without its own end → recoverable `process_exited`. |
| Codex adapter | `crates/providers/src/codex/` | `codex exec --json … [resume <thread id>] -`; JSONL per the SDK's `events.ts`/`items.ts`; mapping in PROVIDERS.md §5; `normalize_item` → `NormalizedAction`. |
| Gemini CLI adapter | `crates/providers/src/gemini/` | `gemini --output-format stream-json --approval-mode <mode> [--resume <uuid>]`; stream events per `types.ts`; quota errors only from `result.error.type`. |
| Codex / Gemini panes | `crates/providers/src/interactive/cli_pane.rs` | Codex: read-only first, `notify` through the authenticated bridge + OSC 9 (only `approval-requested` configured), approvals in Codex. Gemini CLI: process state only. `RuntimeRouter::for_provider`. |
| Provider Health | `crates/providers/src/health/`, `crates/contracts/src/health.rs`, `apps/desktop/src-tauri/src/provider_health_commands.rs` | `HealthMonitor` (detection + observed sessions), `ObservedProvider` wraps every adapter, one driver thread for transitions and gentle re-checks, IPC list/get/trend. `docs/PROVIDER_HEALTH.md`. |
| UI | `apps/desktop/src/surfaces/providers/**`, `shell/widgets/widgets/ProviderHealthWidget.tsx`, `surfaces/threads/**`, `surfaces/code/panes/**` | Providers → Health tab, Dashboard widget feed, New Thread offers Codex/Gemini CLI, Codex/Gemini CLI pane entry points. |

`codex app-server` was evaluated as the better long-term Codex surface (host approvals,
`turn/interrupt`, `model/list`). It is not implemented because the installed CLI labels it
`[experimental]`; the plan is PROVIDERS.md §8.8.

## 2. What each provider supports in KalCode now

| | Claude Code | Codex | Gemini CLI |
| --- | --- | --- | --- |
| Headless threads | Yes (Z2) | **Yes** (exec --json, turn per process) | **Yes** (stream-json, turn per process) |
| Streaming | Deltas | Whole messages per item (exec emits no text deltas) | Deltas |
| Interrupt | Control request, else stop | Kill the turn; session continues | Kill the turn; session continues |
| Resume | `--resume <uuid>` | `exec resume <thread id>` | `--resume <session uuid>` |
| Tool calls / file changes | Yes | Yes (`command_execution`, `file_change`, `mcp_tool_call`, `web_search`) | Yes (`tool_use`/`tool_result`, writes → file changes) |
| Usage | Tokens + cost | Tokens (no cost reported) | Tokens (no cost reported) |
| Host approvals | No (headless) | No (planned via app-server) | No |
| Deny floor | KalCode deny rules | **None per turn** (sandbox + network off only) | **None per session** |
| Sign-in check | `claude auth status` exit code | `codex login status` first line | **Unknown** (no documented command) |
| Rate limits in Health | Structured (`api_rate_limit`, pane `StopFailure`) | **Never** (no structured shape) | Structured (`RetryableQuotaError`, `TerminalQuotaError`) |
| Pane | Hooks, KalCode approves | notify + OSC 9, approvals in Codex | Process state only, approvals in Gemini CLI |
| Models | Documented aliases | Not discoverable ("Provider default") | Documented aliases |
| Minimum version | 2.1.259 | 0.155.0 | None declared |

## 3. Acceptance matrix

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| P2-01 | Codex headless adapter implementing `AgentProvider`/`AgentSession` over `codex exec --json`, event shapes per official definitions | PASS (fake, official-format fixtures) · real CLI PENDING owner smoke | `codex::stream` unit tests (text, tools, file changes, failures, unknown types, bad shapes, prose); `tests/turns_pipeline.rs` `codex_*` (8 tests) |
| P2-02 | Resume by provider session id | PASS | `codex_text_turn_streams_to_done_and_the_next_turn_resumes_the_thread`, `codex_resume_starts_with_the_known_thread` (non-UUID ids refused), `turns_runtime` resume after stop |
| P2-03 | Codex sandbox never broader than the mode (read-only default, workspace-write only in Bypass, never danger-full-access); approvals never waited on | PASS | `codex::argv::tests::{no_mode_is_ever_broader_than_its_kalcode_mode, modes_rank_in_order_and_custom_runs_as_approve, mappings_are_stricter_and_generated_from_the_argv}`; `codex_argv_is_never_broader_than_the_mode` (argv recorded by the fake per mode); `catalog` never-broad test |
| P2-04 | Hardened env + absolute launch for Codex/Gemini npm shims; planted programs never run | PASS | `tests/turns_launch_hardening.rs` (planted `node.exe`, `node.cmd`, `node.bat`, `codex.cmd`, `gemini.cmd`, `cmd.exe` in the workspace; relative `PATH` entry; node runs the shim's script); env scoping asserted in `turns_pipeline` (`OPENAI_*` only for Codex, `GEMINI_*` only for Gemini CLI; no `KALCODE_*`, `GITHUB_TOKEN`) |
| P2-05 | Deny floor equivalent where supported; gaps documented | PARTIAL (documented) | Codex: network off, repository execpolicy ignored, provider keys out of model-run commands; no deny-rule flag exists → §4 and PROVIDERS.md §5 |
| P2-06 | Interrupt / stop / resume; usage; tool calls → `NormalizedAction`; file changes | PASS | `codex_interrupt_kills_the_turn_tree_and_keeps_the_session` (grandchild killed, next turn works); `codex::tests::codex_items_become_normalized_actions`; usage and `FileChanged` asserted in pipeline tests |
| P2-07 | Failures recoverable, stderr never in events, malformed output not echoed | PASS | `codex_failures_are_recoverable_and_never_leak_stderr`, `codex_malformed_output_is_reported_without_echo`, `gemini_quota_errors_are_rate_limits_and_crashes_are_recoverable` |
| P2-08 | `codex app-server` evaluated | DONE (plan) | Experimental in the installed CLI's help → not implemented; plan PROVIDERS.md §8.8 |
| P2-09 | Codex interactive panes, read-only first, status via notify + OSC 9, approvals in Codex, behind the provider-panes flag | PASS (fake in a real PTY and the real app) · real CLI PENDING owner smoke | `tests/interactive_cli.rs` (argv, notify through the real bridge, OSC 9 → WAITING, keystroke → active, prose ignored, Bypass workspace-write, starts without a view); real-app E2E `providers2.spec.ts` "a Codex pane …" (real `kalcode-hook` notify, OSC 9, no approve button); UI `provider-panes.spec.ts` |
| P2-10 | Gemini CLI headless adapter (`stream-json`, `--approval-mode` mapping, never yolo, sign-in unknown) | PASS (fake, official-format fixtures) · real CLI PENDING (not installed) | `gemini::*` unit tests; `gemini_turns_stream_to_done_and_resume_by_session_id`, `gemini_modes_never_use_yolo`, `gemini_detection_reports_sign_in_as_unknown` (only `--version` runs) |
| P2-11 | Gemini CLI pane: process state only | PASS | `a_gemini_pane_runs_with_process_state_only` (limited channel, no status from prose), UI pane tests |
| PH-01 | Per provider: connection/process, auth as reported, account label, models, sessions, observed latency, failures, rate limit only when reported, version vs minimum, trend, recoverability | PASS (account label always unknown: never read) | `health::tests` (8), `health_follows_detection_and_real_sessions`, `turns_runtime` health assertions, Providers → Health view (UI + real-app E2E) |
| PH-02 | No invented quota; unknown shown as unknown | PASS | Rate limits only from structured codes (`rate_limits_only_from_structured_codes_and_clear_on_success`, Gemini prose/generic-error test); `backoff_until` always null; Codex never reports one; E2E asserts no `backing_off` |
| PH-03 | Transitions emit `provider.health_changed` / `provider.capacity_changed` (transitions only) | PASS | `transitions_are_emitted_once_per_change` (no events for samples); E2E finds `provider.health_changed` in the event log |
| PH-04 | One API for consumers | PASS (API) · consumers PENDING (SCH/HS don't exist) | `provider_health_list` / `_get` / `_trend` |
| PH-05 | Hourly rollups persist 30 days | PARTIAL | Hourly rollups kept in memory for 30 days (`trend_needs_two_hours_of_data`, `provider_health_trend`); persistence needs the v13 table (lead) |
| PH-06 | Health can't block a thread; failure reads "unknown" | PASS | Events forwarded before observing (`observe.rs`); monitor optional (`ObservedProvider::wrap(None)`); `HealthMonitor::unavailable()`; threads run in `turns_runtime` with and without observation |
| PH-perf | Low overhead, adaptive checks, no polling | PASS (by design + tests) | No provider process started by health; re-check only after failed starts / auth errors, backoff 1 → 30 min (`start_failures_request_a_gentle_recheck`); driver sleeps until an observation ages out |
| P2-12 | New Thread offers Codex and Gemini CLI when usable, neutral glyph + name; honest unavailability copy | PASS | Real-app E2E creates Codex and Gemini CLI threads from New Thread; `wave2.spec.ts` compares options with detection for all three; UI `threads.spec.ts` (offered, signed-out copy) |
| P2-13 | Thread create → stream → done in the real app with fake Codex/Gemini in a temp workspace | PASS | `providers2.spec.ts` "Codex and Gemini CLI threads stream to done and Provider Health reports them" (safety gate: detection must point at the fakes before anything is sent) |
| P2-14 | Providers → Health view and Dashboard widget feed on the W0 design system; axe in both themes | PASS | UI `providers.spec.ts` (Health tab states, backoff scenario, refresh, error state, axe light + dark), `dashboard.spec.ts` widget tests; screenshot `apps/desktop/qa/screenshots/providers2-health-view.png` |

## 4. Gaps (honest)

- **No Codex or Gemini CLI deny floor.** Neither CLI has a per-invocation deny-rule flag. KalCode
  can't block reads of credential files their read sandboxes allow; remote actions are stopped by
  Codex's network-off sandbox, not by KalCode rules. Codex permission profiles (`deny` read
  rules) don't compose with `--sandbox` and a `sandbox_mode` in user config silently wins, so they
  are not used until that precedence is verified (with app-server).
- `--ignore-rules` drops the user's own Codex `forbidden` execpolicy rules along with a
  repository's.
- Gemini CLI settings of a folder the user trusted (tools, MCP servers, hooks) still apply;
  KalCode never passes `--skip-trust`.
- Codex exec reports whole messages, not deltas; Codex rate limits are never shown (unknown).
- KalCode's permission engine judges Codex/Gemini tool calls only after the fact (display and
  audit), never before — `hostApprovals: false`, as for Claude Code headless threads.
- Codex panes: KalCode can't answer Codex's approval prompt; "waiting" ends when the person types
  (not an escape sequence) or the turn completes.
- Gemini CLI panes: no resume (no session id without hooks), no tool-level status.
- Health rollups are in memory (30 days, lost on restart) until the v13 table exists (PH-05).
- Everything Gemini CLI is verified against published type definitions only (not installed).

## 5. Contract additions (lead-owned crate; additive)

- `crates/contracts/src/health.rs` (new): `HealthState`, `CapacityState`, `Recoverability`,
  `HealthTrend`, `HealthFailure`, `ProviderHealth`, `HealthRollup`.
- `EventPayload::ProviderHealthChanged` (`provider.health_changed`) and
  `EventPayload::ProviderCapacityChanged` (`provider.capacity_changed`); sample count 69 → 71.
- No change to `AgentProvider` / `AgentSession` / `AgentEvent` (no `AgentEvent::Backoff`:
  rate limits travel as structured error codes).

## 6. Hot files touched (minimal, additive)

Lead-owned (contracts, additive): `crates/contracts/src/lib.rs` (line 20, `pub mod health;`),
`crates/contracts/src/events.rs` (import line 11; two variants after `provider.error` ~237–255;
`type_name` ~578–579; two samples ~758–770; sample count 69 → 71 ~1027);
`packages/testing/src/scenarios.ts` (two sample events ~83–90).

Desktop shell (Z2/Z3/W4 files; line ranges against main 363d5a0):

| File | Change |
| --- | --- |
| `apps/desktop/src-tauri/src/lib.rs` | `mod provider_health_commands;` (14); health start + bind before the thread runtime (246–251); `app.manage(health)` (288); 3 commands in `generate_handler!` (333–335); shutdown (411–415) |
| `apps/desktop/src-tauri/src/thread_commands.rs` | imports (17, 19); `adapter()` registers Codex and Gemini CLI and wraps every adapter in `ObservedProvider` (96–117) |
| `apps/desktop/src-tauri/src/provider_pane_commands.rs` | import (29); `route_cli` + Codex/Gemini statics (69–90); Codex/Gemini interactive providers built with the same bridge and config (212–232); `provider_pane_create` accepts `codex` / `gemini-cli` (354–363) |
| `apps/desktop/src-tauri/src/kalvoice_commands.rs` | Codex/Gemini adapters for usable providers (~221–227) |
| `apps/desktop/src-tauri/build.rs`, `capabilities/main.json` | 3 commands / grants (33–36; 37–39) |
| `crates/providers/src/interactive/{provider,session,codex}.rs` (W4) | `PaneRegistry::insert` pub(crate), view counting in `attach`/`detach` (102–128), `user_input` after writes (139–144), `RuntimeRouter` holds `Arc<dyn AgentProvider>` + `for_provider` (422, 439–451); `PaneProfile` (52–70), profile/prompt/views fields (130–134, 168–170), Codex helpers (174–217), `CodexNotify` → `SessionStarted`/`TurnCompleted` (559–581); Codex `hook_prefix_args` and `tui.notifications=['approval-requested']` |
| `apps/desktop/src/surfaces/code/CodeCanvas.tsx` (W1) | imports (46–47); `newProviderPane(providerId?)` (92–93, 249–261); add-menu items "Codex pane" / "Gemini CLI pane" (429–443, deps 493) |
| `apps/desktop/src/surfaces/code/CodePage.tsx` (W1) | import (49); toolbar buttons per offered provider (351–371) |
| `apps/desktop/src/surfaces/code/panes/useProviderPanes.ts` (W1/W4) | all three providers' pane threads, `offered`, `create(providerId)`, Codex info poll while waiting |
| `apps/desktop/src/ipc/{client,transport,memoryTransport}.ts` | health client methods, command names, in-memory health handlers + test hooks |
| `apps/desktop/tests/e2e/wave2.spec.ts` | offered providers compared with detection for all three adapters |

## 7. Smoke scripts awaiting the owner's approval (not run; they consume AI quota)

| Script | Checks |
| --- | --- |
| `tooling/smoke/codex-headless-smoke.ps1` | codex-cli accepts KalCode's exec flags; real JSONL shapes; stdin prompt; `exec resume` continues the thread |
| `tooling/smoke/codex-interactive-smoke.ps1` | `-c notify=[…]` and `tui.notifications=['approval-requested']`/`osc9` accepted; notify payload (`agent-turn-complete`, `thread-id`) through the real helper; OSC 9 under ConPTY; Plan never writes |
| `tooling/smoke/gemini-headless-smoke.ps1` | (after installing Gemini CLI) headless from piped stdin; `--approval-mode plan`; real stream-json shapes; `--resume <uuid>`; folder-trust behaviour |

## 8. Gates

All run on 2026-09-25 in this worktree after merging main 363d5a0 (UI port 1454, CDP 9454,
`KALCODE_API_TEST_PORT=18454`, Playwright `--workers=2` for UI, 1 for the real app):

| Gate | Result |
| --- | --- |
| `pnpm check` | format, lint (clippy `-D warnings`, biome), typecheck, JS tests (protocol 56, testing 24, ui 26, api 119, desktop 318), branding (1287 files), capabilities (81 commands), zero-cost (474 files), releases: PASS. One run hit a 5 s timeout in `apps/website` `store-d1` "daily budget under concurrency" (untouched by this branch; passes on rerun, 235/235) |
| `cargo test --workspace` | 1176 passed, 0 failed, 10 ignored (real-provider and quota tests) |
| `cargo deny check` | advisories, bans, licenses, sources ok |
| Desktop UI suite | 261 passed (one earlier run had a W1 drag-and-drop test fail under load; it passed on the rerun and is not touched here) |
| `build:e2e` + real-app E2E | 18 passed, including `providers2.spec.ts` (Codex + Gemini CLI threads, health view, Codex pane) and the existing suites |
| Real provider commands | only `--help`, `--version`, `codex login status`; no session, no quota |

Found and fixed by the real-app E2E: a Codex pane's OSC 9 watcher is a PTY listener, so the PTY
stopped answering ConPTY's startup cursor-position request and the CLI didn't start until a
view attached. The watcher now answers while no view is attached (regression test
`a_codex_pane_starts_without_a_view_attached`, failing on the unfixed code). Also: a Codex pane's
info is polled while it waits for the first notify (idle → idle has no thread event).
