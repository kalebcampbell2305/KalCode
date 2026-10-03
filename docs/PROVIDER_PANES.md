# Provider panes — design note

## Fresh-agent launch incident (2026-10-03)

Windows build `0.1.9+1125` omitted `kalcode-hook.exe`. The installed application had the updater and
guardian helpers, but the interactive Claude/Codex startup path requires the hook helper beside
`kalcode.exe`. New launches received fresh thread/session identities and then failed before PTY
creation. The durable interactive marker made the missing-PTY fallback appear historical, hiding
the actual startup error behind an "earlier run" explanation.

Windows releases now build, sign, bundle and verify the hook helper, including its exact hash,
timestamped publisher signature, clean installation and upgrade. Publication requires that evidence.
macOS already packages and verifies this helper. Pane startup also checks helper availability;
failed creation returns the recorded native error, while resource-held creation remains queued.
Missing terminal output uses native status/error, and restored metadata retains the actual provider.

New agent creation continues to use fresh identities; only explicit Resume supplies a historical
provider-session identity. Account/workspace routing and plan admission remain canonical. Launch
admission stays serialized because the existing count-based plan check is not an atomic concurrent
reservation; successfully started agents run independently. No database or marker migration is needed.

Regression coverage: `interactive_runtime.rs` and `interactive_cli.rs` exercise real PTYs with fixture
providers; `provider_pane_commands.rs` checks native startup guards; `PaneTerminal.voice.test.tsx`
checks missing-PTY truth; `provider-panes.spec.ts` checks 1/4/6 Claude and multi-Codex UI layouts;
`hook-packaging.test.mjs`, signing and updater tests enforce shipment integrity. Fixture tests do not
claim live provider authentication. Signed candidate and production-update results are recorded by
the release lane. Roll back a regression by reverting this fix through a PR and publishing a newer
internal build; never downgrade the production feed or overwrite owner session data.

## Original design record

Status: **BUILT for Claude Code on `z7/provider-panes`, and for Codex (provider-native modes) and Gemini
CLI (process state only) in PROVIDERS-2 (`docs/campaigns/PROVIDERS-2.md`), behind the
`provider_panes` feature flag.**
The current Claude Code hook path can route decisions through the engine
(`DecisionRouting::Engine`, §9); Codex and Gemini keep execution permissions in the provider.
Campaign Z7,
writer W4 (`docs/campaigns/ADVANCED.md` §16; evidence in `docs/campaigns/Z7-W4.md`, threat model
in `docs/campaigns/Z7-W4-THREATS.md`). Researched through 2026-09-25 from official provider documentation
and the installed `--help` output of Claude Code 2.1.282 and codex-cli 0.157.0 (Gemini CLI is not
installed on the verification machine). No provider session was started and no AI quota was
used; the owner-approved smoke run is written but not run (§7).

Until this ships, Claude Code threads are headless and KalCode enforces for them through launch
flags only: a mapped permission mode, `--permission-prompts none`, and KalCode deny rules
(`--disallowedTools`) for remote actions, credential files and, outside Bypass, the edit and web
tools. The user's own Claude Code user settings still decide other commands. See
`docs/PROVIDERS.md` §5 ("What KalCode enforces for Claude Code threads today"). The same deny
rules should be passed to interactive panes as the floor under the hook.

## 1. Decision

**New Thread → Claude Code starts the real, unmodified `claude` process in a Z1 PTY pane.** The
pane shows the provider's own TUI. KalCode does not render an imitation terminal or its own copy
of the conversation for these threads.

KalCode's knowledge of what the session is doing comes from:

1. **Structured channels the CLI officially supports** — hooks and notification commands that
   KalCode configures for that session at launch.
2. **Process and PTY state** — spawned, running, exited, exit code, and whether output is flowing.

Model prose is **never** parsed for state.

The Z3 headless runtime (stream-json) stays. Both runtimes are rows in `threads` with a runtime
kind, feed the **same** `AgentEvent` → `ThreadStatus` machine, and appear in one Dashboard.

| | Interactive pane (`interactive_pty`) | Headless (`headless`, Z3 today) |
| --- | --- | --- |
| Used for | Threads the user creates and drives | Missions, automations, delegations, KalVoice background work, handoff continuations |
| What the user sees | The provider's real TUI | KalCode's thread view (messages, tools) |
| Input | The user types in the pane (KalVoice dictation writes to the PTY like any terminal input) | `thread_send` |
| Status source | Hook bridge + process/PTY state → `AgentEvent` | stream-json → `AgentEvent` |
| Approvals | Hook bridge → Trust Kernel; the provider's own prompt as fallback | Host approvals / deny-by-default (Z2, Z4) |
| Resume | Provider resume flag (`claude --resume`, `codex resume`) | `SessionConfig.resume_session_id` |

Automations never type into an interactive TUI; they use headless threads. A user can continue
an interactive thread headlessly (or the reverse) through a Hot-Swap handoff (HS).

## 2. The hook bridge

- `kalcode-hook` is a small helper binary shipped with KalCode (`crates/hook-bridge`). Hooks are
  configured as `type: "command"` entries in **exec form** (`"command": <absolute helper path>,
  "args": ["claude", <event>, <endpoint>, <session>]`: spawned directly, no shell), with explicit
  timeouts (PreToolUse 600 s, status events 10 s).
- It reads the hook's JSON from stdin, validates it against the documented schema for that event,
  **drops fields KalCode does not need** (for example tool output bodies), and forwards a bounded
  record to KalCode. The first prompt's text is forwarded only so the deterministic Z3 namer can
  title the thread. It is never stored or put in an event.
- Transport: a per-run, randomly named pipe (Windows; created with
  `FILE_FLAG_FIRST_PIPE_INSTANCE` and remote clients rejected) or a Unix socket in a fresh `0700`
  directory. There is no TCP listener. Each session has a 256-bit key passed only in the
  provider's environment (`KALCODE_HOOK_KEY`, inherited by its hooks); the settings file holds no
  secret. Both sides prove the key with an HMAC-SHA256 challenge over a fresh server nonce, so the
  key never crosses the wire and a recorded call can't be replayed. Ended sessions are revoked.
- For `PreToolUse` the helper waits for KalCode's decision and prints the documented decision
  JSON (allow / ask) or exits 2 (deny). If KalCode is unreachable, doesn't answer before the
  helper's own deadline (590 s, inside the 600 s hook timeout, because a timed-out hook does not
  block), sends a reply that doesn't verify, or the helper panics, `PreToolUse` exits **2**
  (block): the bridge fails closed. `PermissionRequest` and every other event are status only and
  fail open.
- The bridge converts hook events into existing `AgentEvent`s and hands them to the Z3
  `ThreadRuntime`. There is **no second status machine**.

### Hook → `AgentEvent` → `ThreadStatus` (Claude Code)

| Hook event [1][2] | `AgentEvent` | Resulting status |
| --- | --- | --- |
| `SessionStart` (`source`: startup / resume) | `SessionStarted { providerSessionId = session_id }` | `idle` until the first prompt |
| `UserPromptSubmit` | `Status(active)` | `active` |
| `PreToolUse` (+ Trust Kernel decision) | `ToolRequested` + `Status(running_command \| editing \| running_tool)` | by tool |
| `PermissionRequest` (the provider's own prompt is showing) | `Status(waiting_for_user, "Answer in Claude Code")` | `waiting_for_user`* |
| `Notification` (permission prompt / idle prompt / elicitation / agent needs input) | `Status(waiting_for_user)` with a detail | `waiting_for_user`* |
| `PostToolUse` / `PostToolUseFailure` | `ToolCompleted { ok }`; `FileChanged` for edit/write tools | `active` |
| `Stop` | `TurnCompleted { ok: true }` | `idle` |
| `StopFailure` | `Error { recoverable }` (`Backoff` when the payload is structured) | unchanged / `recovering` |
| `SubagentStart` / `SubagentStop` | activity detail only | — |
| `SessionEnd`, then process exit | `Exited { exitCode }` | `completed` (clean) / `failed` |
| No hook events after spawn (hooks disabled or broken) | `Error { code: hooks_inactive, recoverable }` after 20 s | status from process only, with a "limited status" badge |

\* As built: `PreToolUse` with engine routing emits `ToolRequested` then `ApprovalRequired` (the
Z3 runtime evaluates it with the Z4 engine and sets `waiting_for_permission` only when KalCode
asks). A prompt shown by the provider itself is reported as `waiting_for_user` (WAITING FOR YOU,
detail "Answer in Claude Code"), because the Z3 runtime ignores `waiting_for_permission` from
providers (it owns approval state). Showing PERMISSION REQUIRED for provider-side prompts needs a
runtime change (lead decision). `SessionStart` with `source` compact/fork records the session id
only (no status change). `Stop` also closes tool calls that never completed as "Not run".

## 3. Launch, per provider

Every launch uses Z2's process rules: argv only (never a shell string); `env_clear()` plus the OS
allow-list and that provider's own variables; the native-resolved workspace folder as cwd;
process-tree kill on stop. The launch goes through the new Z1 PTY launch API.

### Claude Code

```text
claude [--restricted] --permission-mode <plan|manual|acceptEdits>   # Plan: --restricted instead of
       [--setting-sources user] --strict-mcp-config                 #   --setting-sources user (K4)
       --settings <data>/sessions/<thread>/claude-settings.json     # KalCode hooks only
       --disallowedTools <KalCode deny floor…>                      # Z2 rules, as headless
       [--model <alias>] --session-id <uuid> | --resume <provider session id>
```

`--setting-sources user` means a repository's `.claude/settings.json` hooks and allow rules are not
loaded, just as in Z2's headless mode. Interactive mode shows the provider's own workspace-trust
dialog [3]. KalCode never passes `--dangerously-skip-permissions` or
`--allow-dangerously-skip-permissions`, so Bypass is not reachable through the TUI's mode cycle.

### Codex

```text
codex -C <workspace> -s <read-only|workspace-write|danger-full-access>
      -a <on-request|never> [-m <model>]
      -c notify=["<kalcode-hook>","codex-notify","<session>"]            # agent-turn-complete [5]
      -c tui.notifications=["agent-turn-complete","approval-requested"]   # OSC 9 in the PTY stream [5]
      -c tui.notification_method="osc9" -c tui.notification_condition="always"
codex resume <the same options> <session id>                            # continuity
```

Codex hooks (`PreToolUse`, `PermissionRequest`, …) [4] require *persisted hook trust*.
`codex --help` offers `--dangerously-bypass-hook-trust`, which KalCode **never** uses. Until the
supported way to trust KalCode-provided hooks is verified (§7), Codex panes use authenticated
`notify` records and process state. Approvals are answered in Codex's own prompt; KalCode cannot
answer or reliably detect them. OSC 9 is untrusted terminal output: a tool can print the same
sequence, so it must never change canonical status.

As built (PROVIDERS-2, `crates/providers/src/interactive/cli_pane.rs`):
`tui.notifications=['approval-requested']` remains terminal output only. Status:
`notify` `agent-turn-complete` → `TurnCompleted` (and the `thread-id` → `SessionStarted`, used
by `codex resume <id>`); process exit → `Exited`. Neither terminal notifications nor subsequent
keystrokes imply an approval state. The `notify` helper reaches KalCode through the same authenticated bridge (HMAC,
per-session key in the provider environment, fail-open because it is status only). No hooks
watchdog: `notify` fires only at the end of a turn. Pane info: hook channel `waiting` until the
first notify, then `active`; `kalcodeAnswersApprovals` is always false.

### Gemini CLI

Hooks are configured in `settings.json` (`BeforeTool`, `AfterTool`, `SessionStart`,
`SessionEnd`, …; exit code 2 blocks) [7][8]. A per-session way to inject KalCode's hooks
without writing to the user's or the project's settings is **unverified** (not installed here).
Until it is verified: process/PTY status only, approvals in the provider's own prompt, and a
"limited status" badge. As built (PROVIDERS-2): `gemini --approval-mode <plan|default|auto_edit>
[--model] [--resume <uuid>]` (never `yolo`, never `--skip-trust`), hook channel `limited` from
the start, `Exited` on process exit; nothing else is inferred.

## 4. Permissions for interactive panes

The selected KalCode mode maps to the provider's supported native execution policy. Normal
KalCode UI operations do not require approval. For Codex, the real CLI owns command decisions and
native prompts; KalCode neither synthesizes nor answers those prompts. The Claude Code hook column
records its existing adapter path and is owned by the separate provider-policy reconciliation.

| KalCode mode | Claude Code launch | KalCode `PreToolUse` hook returns | Codex launch (until hooks are trusted) |
| --- | --- | --- | --- |
| Plan | `--permission-mode plan --restricted` | TK decision (deny modifying actions) | `-s read-only -a never` |
| Approve | `--permission-mode manual` | TK: allow reads; **ask** for writes/commands (KalCode approval) | `-s workspace-write -a on-request` |
| Auto | `--permission-mode manual` | TK Auto policy: allow what it covers, ask otherwise | `-s workspace-write -a never` |
| Bypass | `--permission-mode acceptEdits` | TK Bypass: allow local actions; ask for remote-consequential, opaque, outside-workspace and credentials | `-s danger-full-access -a never` |
| Custom | `--permission-mode manual` (Custom `never` rules in the deny floor: not yet) | TK profile decision | as Approve (`-s workspace-write -a on-request`) |

Reconciled: `claude --help` 2.1.282 lists `acceptEdits, auto, bypassPermissions, manual, dontAsk,
plan`; panes pass `manual` (the hooks reference reports that mode as `default` in payloads, and
Z2's headless argv still passes `default`). `interactive_modes_are_verified_and_never_broader`
fails if a mode outside the list is emitted.

Never used, in any mode: Claude Code `bypassPermissions`, `auto` (the provider's classifier is not
KalCode policy) and the dangerous-skip flags; Codex
`--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust` and
`--approve-for-me` (automatic review by the provider). Codex `danger-full-access` is used only as
the explicit native sandbox for Bypass; it is not the combined dangerous-bypass switch.

**Why hooks are sufficient for Claude Code.** Per [2], `PreToolUse` runs before the permission
prompt for every tool (except ending the conversation). A hook can deny, force a prompt, or allow;
exit code 2 blocks before any allow rule is evaluated. Hook decisions never override the
provider's own deny/ask rules. So KalCode's decision is at least as strict as KalCode policy, and
the user's own provider deny rules only add strictness.

**How approvals surface.** For Claude Code, KalCode is the approver. When TK says *ask*, the
helper holds the `PreToolUse` / `PermissionRequest` hook. KalCode shows its `PermissionPrompt` as
an overlay on the pane and in the approval queue and Dashboard, with Deny / Approve once / Allow
for thread. The helper then returns the decision. If nobody answers before the hook timeout
(documented default 10 minutes; KalCode sets it explicitly [1]), the helper returns *no decision*.
The provider's own prompt then takes over in the pane, and the KalCode request expires as
`answered_in_provider`. For providers without trusted hooks, approvals are answered in the
provider's prompt only, and KalCode shows PERMISSION REQUIRED without an answer button.

**What KalCode cannot intercept** (stated in the pane's info panel):

- Commands the **user** types into the TUI (for example shell escapes). These carry user
  authority, exactly like a terminal tab.
- What a script run by an allowed command does internally (same limit as Z4).
- The provider's own network traffic to its model API.
- Changes the user makes inside the TUI (slash commands, mode cycling). They change the
  provider's prompting only; every tool call still passes the KalCode hook.
- Anything, on providers whose hooks are not active. Their panes are marked "limited status —
  approvals in the provider".

## 5. Status model, titles, continuity

- One `ThreadStatus` machine (Z3). Display statuses and colours: `ADVANCED.md` §16.3.
- Titles: Z3's deterministic namer on the first prompt; renamable; passed to Claude Code with
  `-n` on (re)launch.
- Continuity (PC): an interactive session is **RECONNECTABLE** when the thread has a provider
  session id and the provider documents resume (`claude --resume`, `codex resume`). Otherwise it
  is **RESTARTABLE** (a fresh session in the same folder), or historical. KalCode never replays a
  command or a prompt on restore.
- PH health uses the same bridge signals (first-output latency, failures, `StopFailure`).

## 6. Contract changes (see `CONTRACTS_ADVANCED.md`)

- `threads.runtime_kind` (`headless` | `interactive_pty`) and `threads.terminal_id` (v12, lead).
- `ProviderCapabilities.interactive: Option<InteractiveSupport>` — launch mapping per mode,
  status channels (`hooks` | `notify` | `osc9` | `process_only`), whether KalCode can answer
  approvals, and the resume method.
- Z4: expire reason `answered_in_provider`; `NormalizedAction` built from hook `tool_name` /
  `tool_input` by the same adapter classification as headless (Z2 `actions.rs`).

## 7. Verification items (before Z7-W4 ships each provider)

| Item | Status |
| --- | --- |
| Claude Code `--permission-mode` value for "ask normally" (`manual` vs `default`) | Done: panes pass `manual` (listed by the installed help); tested. |
| Claude Code hook payload shapes per event, and `PermissionRequest` behaviour while a hook is pending | Documented [1][2]; covered by the fake provider's interactive mode. Real run pending owner approval (`tooling/smoke/claude-interactive-smoke.ps1`). |
| `--settings` hooks load with `--setting-sources user`; exec-form `args`; hooks inherit the provider environment; `prompt` vs `user_prompt` in UserPromptSubmit | Documented [1][3]; the parser accepts either prompt field. Confirmed only by the owner-approved smoke run (written, not run). |
| Codex: supported way to trust KalCode-provided hooks without the bypass flag; whether `-c` can register hooks | Unverified. Authenticated `notify` only until confirmed (built that way in PROVIDERS-2). |
| Gemini CLI: per-session hook injection without writing user or project settings | Unverified (not installed). Process-only until confirmed. |
| OSC 9 sequences in Codex output under ConPTY | Verified with the fake provider through a real ConPTY (`tests/interactive_cli.rs`). Real Codex: `tooling/smoke/codex-interactive-smoke.ps1`, written, not run. |

## 8. Sources

1. Claude Code hooks reference — https://code.claude.com/docs/en/hooks
2. Claude Code hooks guide (limits, timeouts, PermissionRequest behaviour) — https://code.claude.com/docs/en/hooks-guide · permissions and hooks — https://code.claude.com/docs/en/permissions
3. Claude Code CLI reference — https://code.claude.com/docs/en/cli-reference · settings — https://code.claude.com/docs/en/settings · installed `claude --help` (2.1.282)
4. Codex hooks — https://learn.chatgpt.com/docs/hooks
5. Codex advanced configuration (`notify`, `tui.notifications`) — https://learn.chatgpt.com/docs/config-file/config-advanced · installed `codex --help` (0.157.0; minimum 0.155.1)
6. Codex approvals and security — https://learn.chatgpt.com/codex/agent-approvals-security
7. Gemini CLI hooks — https://geminicli.com/docs/hooks
8. Gemini CLI hooks reference — https://geminicli.com/docs/hooks/reference
9. Running Claude Code inside another product (unmodified binary, user's own authentication, name and logo use) — https://code.claude.com/docs/en/legal-and-compliance

## 9. Implementation (Z7-W4)

| Piece | Where |
| --- | --- |
| Hook helper + bridge server (endpoint, HMAC challenge, filtered records, fail-closed policy) | `crates/hook-bridge` (`kalcode-hook` binary) |
| PTY launch for provider CLIs (argv, cleared environment) | `crates/pty` `PtySession::spawn_program` |
| Claude Code interactive argv, deny floor, settings file | `crates/providers/src/interactive/claude.rs` |
| Hook → `AgentEvent` mapping, held approvals, `AgentSession` over the PTY | `crates/providers/src/interactive/session.rs` |
| Interactive provider, per-thread runtime router, pane registry | `crates/providers/src/interactive/provider.rs` |
| Codex provider-native mode argv; terminal notification parser has no status authority | `crates/providers/src/interactive/codex.rs` |
| Codex (authenticated notify) and Gemini CLI (process state) panes, and their runtime routers | `crates/providers/src/interactive/cli_pane.rs`; `RuntimeRouter::for_provider` |
| `answered_in_provider` expiry | `PermissionService::expire_answered_in_provider` |
| IPC (`provider_pane_*`) and glue (expiry, first-prompt title) | `apps/desktop/src-tauri/src/provider_pane_commands.rs` |
| Pane UI (header, status chip, approval overlay, info panel, entry point) | `apps/desktop/src/surfaces/code/panes/**` |

Provider pane headers show the managed account resolved from the thread's exact
`providerAccountId`. An active account uses the current account-registry display name; an archived,
missing or temporarily unreadable account keeps the thread's durable snapshot and labels that state
explicitly. The account id remains the routing authority. Pane titles include the same owner-visible
identity so KalVoice's focused-pane announcement distinguishes Personal, Work and other accounts.

**Decision routing.** `DecisionRouting::Engine` (default since the classifier hardening merged to
main, 65fe095): every call becomes `ApprovalRequired` for the Z3 runtime and Z4 engine. Calls whose
shape the classifier still can't judge (SEC-LATENT §5: recursive searches, pipelines, multi-level
wildcards) are sent as opaque, so they always need an explicit one-time approval
(`session::known_gap`). `DecisionRouting::ProviderPrompt` (the switch back): every `PreToolUse`
still needs an authenticated round trip (so an unreachable KalCode blocks) and is recorded for
status, but KalCode returns no decision and Claude Code's own permission flow decides under the
deny floor. Debug and `e2e` builds can choose with `KALCODE_E2E_HOOK_DECISIONS=engine|provider_prompt`.

**Runtime kind until v12.** `threads.runtime_kind` doesn't exist yet (lead, L-2), so the Claude
Code provider registered with the Z3 runtime is a router: threads created through
`provider_pane_create` are marked interactive (a marker in `<data>/sessions/<thread>/`) and start
(and resume) in a pane; every other thread stays headless. `ThreadSummary.runtimeKind` /
`terminalId` stay `null`; views attach by thread id (`provider_pane_attach`).

**Not built yet.** Process Continuity restore labels
(`crates/continuity`); pane `-n <title>` on relaunch (the title isn't in `SessionConfig`);
Custom `never` rules in the deny floor; provider-reported PERMISSION REQUIRED for the provider's
own prompts (needs a Z3 runtime change).


## Security hardening release gate (2026-09-25)

Provider changes are not approved for installation or publication. Panes now use the same exact
provider-native Codex mapping as headless turns (Plan `read-only/never`, Approve and Custom
`workspace-write/on-request`, Auto `workspace-write/never`, Bypass
`danger-full-access/never`) while connected tools and web search remain disabled. These scalar
flags alone do not isolate inherited MCP maps or managed configuration. The dedicated KalCode
profile candidate uses separate supported sign-in and preserves the existing CLI setup;
certification remains pending. See `campaigns/CODEX-TAKEOVER.md` for the current gate.

Terminal OSC notifications are never canonical permission or thread-state evidence.
Authenticated hook registrations bind one provider channel; records are schema-validated,
identity-latched, rate-limited and concurrency-limited. Session exit, admission and approval
finalization share one lifecycle boundary. A child inheriting a session key can forge its
own session's permitted messages, so authentication is not proof of a particular child
process. It cannot answer KalCode's approval API or cross session/provider bindings.
