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

RESULTS_PLACEHOLDER

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

HOTFILES_PLACEHOLDER

## 7. Smoke scripts awaiting the owner's approval (not run; they consume AI quota)

| Script | Checks |
| --- | --- |
| `tooling/smoke/codex-headless-smoke.ps1` | codex-cli accepts KalCode's exec flags; real JSONL shapes; stdin prompt; `exec resume` continues the thread |
| `tooling/smoke/codex-interactive-smoke.ps1` | `-c notify=[…]` and `tui.notifications=['approval-requested']`/`osc9` accepted; notify payload (`agent-turn-complete`, `thread-id`) through the real helper; OSC 9 under ConPTY; Plan never writes |
| `tooling/smoke/gemini-headless-smoke.ps1` | (after installing Gemini CLI) headless from piped stdin; `--approval-mode plan`; real stream-json shapes; `--resume <uuid>`; folder-trust behaviour |

## 8. Gates

GATES_PLACEHOLDER
