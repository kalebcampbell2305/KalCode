# Provider panes — design note

Status: **PROPOSED — planned, not built.** Campaign Z7, writer W4 (`docs/campaigns/ADVANCED.md`
§16). Researched 2026-09-24 from official provider documentation and the installed `--help`
output of Claude Code 2.1.282 and codex-cli 0.155.1 (Gemini CLI is not installed on the
verification machine). No provider session was started and no AI quota was used.

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
  configured as `type: "command"` entries that run it with the session id.
- It reads the hook's JSON from stdin, validates it against the documented schema for that event,
  **drops fields KalCode does not need** (for example tool output bodies), and forwards a bounded
  record to KalCode. The first prompt's text is forwarded only so the deterministic Z3 namer can
  title the thread. It is never stored or put in an event.
- Transport: a per-user named pipe (Windows) or Unix socket (macOS/Linux) with OS ACLs, plus a
  per-session secret written into the session's settings file in KalCode's data folder. There is
  no TCP listener. (Claude Code also supports `type: "http"` hooks; a loopback HTTP endpoint is
  the fallback if pipes prove unreliable, protected by the same secret.)
- For `PreToolUse` / `PermissionRequest` the helper waits for KalCode's decision and prints the
  documented decision JSON. If KalCode is unreachable, `PreToolUse` exits **2** (block), so the
  bridge fails closed.
- The bridge converts hook events into existing `AgentEvent`s and hands them to the Z3
  `ThreadRuntime`. There is **no second status machine**.

### Hook → `AgentEvent` → `ThreadStatus` (Claude Code)

| Hook event [1][2] | `AgentEvent` | Resulting status |
| --- | --- | --- |
| `SessionStart` (`source`: startup / resume) | `SessionStarted { providerSessionId = session_id }` | `idle` until the first prompt |
| `UserPromptSubmit` | `Status(active)` | `active` |
| `PreToolUse` (+ Trust Kernel decision) | `ToolRequested` + `Status(running_command \| editing \| running_tool)` | by tool |
| `PermissionRequest` | `ApprovalRequired { NormalizedAction }` | `waiting_for_permission` |
| `Notification` (permission prompt / idle prompt) | `Status(waiting_for_permission \| waiting_for_user)` | as named |
| `PostToolUse` / `PostToolUseFailure` | `ToolCompleted { ok }`; `FileChanged` for edit/write tools | `active` |
| `Stop` | `TurnCompleted { ok: true }` | `idle` |
| `StopFailure` | `Error { recoverable }` (`Backoff` when the payload is structured) | unchanged / `recovering` |
| `SubagentStart` / `SubagentStop` | activity detail only | — |
| `SessionEnd`, then process exit | `Exited { exitCode }` | `completed` (clean) / `failed` |
| No hook events after spawn (hooks disabled or broken) | — | status from process state only, with a "limited status" badge |

## 3. Launch, per provider

Every launch uses Z2's process rules: argv only (never a shell string); `env_clear()` plus the OS
allow-list and that provider's own variables; the native-resolved workspace folder as cwd;
process-tree kill on stop. The launch goes through the new Z1 PTY launch API.

### Claude Code

```text
claude --settings <data>/sessions/<thread>/claude-settings.json   # KalCode hooks (+ deny rules for `never`)
       --setting-sources user --strict-mcp-config                  # no project/local settings or repo MCP servers (K4)
       --permission-mode <mapped>  [--restricted in Plan]
       --session-id <uuid> | --resume <provider session id>
       [--model <alias>] [-n <title>]
```

`--setting-sources user` means a repository's `.claude/settings.json` hooks and allow rules are not
loaded, just as in Z2's headless mode. Interactive mode shows the provider's own workspace-trust
dialog [3]. KalCode never passes `--dangerously-skip-permissions` or
`--allow-dangerously-skip-permissions`, so Bypass is not reachable through the TUI's mode cycle.

### Codex

```text
codex -C <workspace> -s <sandbox> -a on-request [-m <model>]
      -c notify=["<kalcode-hook>","codex-notify","<session>"]            # agent-turn-complete [5]
      -c tui.notifications=["agent-turn-complete","approval-requested"]   # OSC 9 in the PTY stream [5]
      -c tui.notification_method="osc9" -c tui.notification_condition="always"
codex resume <session id>                                               # continuity
```

Codex hooks (`PreToolUse`, `PermissionRequest`, …) [4] require *persisted hook trust*.
`codex --help` offers `--dangerously-bypass-hook-trust`, which KalCode **never** uses. Until the
supported way to trust KalCode-provided hooks is verified (§7), Codex panes use `notify`, OSC 9
notifications and process state. Approvals are answered in Codex's own prompt; KalCode shows
PERMISSION REQUIRED from the `approval-requested` signal but cannot answer it. OSC 9 is a
terminal escape sequence, so detecting it is structural parsing of the PTY stream, not prose.

### Gemini CLI

Hooks are configured in `settings.json` (`BeforeTool`, `AfterTool`, `SessionStart`,
`SessionEnd`, …; exit code 2 blocks) [7][8]. A per-session way to inject KalCode's hooks
without writing to the user's or the project's settings is **unverified** (not installed here).
Until it is verified: process/PTY status only, approvals in the provider's own prompt, and a
"limited status" badge.

## 4. Permissions for interactive panes

The Trust Kernel stays the only authority (`docs/TRUST_KERNEL.md`). The provider's permission
mode is a **floor** set at launch; the KalCode hook is the **enforcement point** on every tool call
it can see.

| KalCode mode | Claude Code launch | KalCode `PreToolUse` hook returns | Codex launch (until hooks are trusted) |
| --- | --- | --- | --- |
| Plan | `--permission-mode plan --restricted` | TK decision (deny modifying actions) | `-s read-only -a on-request` |
| Approve | `--permission-mode manual`* | TK: allow reads; **ask** for writes/commands (KalCode approval) | `-s read-only -a on-request` (writes need escalation → Codex prompt) |
| Auto | `--permission-mode manual`* | TK Auto policy: allow what it covers, ask otherwise | `-s read-only -a on-request` (runs like Approve: without hooks KalCode cannot stop destructive commands inside a writable sandbox) |
| Bypass | `--permission-mode acceptEdits` | TK Bypass: allow local actions; ask for remote-consequential, opaque, outside-workspace and credentials | `-s workspace-write -a on-request` (network off) |
| Custom | `--permission-mode manual`* + `permissions.deny` for `never` rules | TK profile decision | as Approve |

\* `claude --help` 2.1.282 lists `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`.
Z2's headless argv uses `default`. Reconcile against the installed version before Z7-W4 lands;
the mapping tests must fail if an unknown mode is emitted.

Never used, in any mode: Claude Code `bypassPermissions`, `auto` (the provider's classifier is not
KalCode policy) and the dangerous-skip flags; Codex `danger-full-access`,
`--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust` and
`--approve-for-me` (automatic review by the provider).

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
| Claude Code `--permission-mode` value for "ask normally" (`manual` vs `default`) | Installed help lists `manual`; Z2 uses `default`. Reconcile. |
| Claude Code hook payload shapes per event, and `PermissionRequest` behaviour while a hook is pending | Documented [1][2]; confirm with a fake-provider contract test, then one owner-approved smoke run. |
| Codex: supported way to trust KalCode-provided hooks without the bypass flag; whether `-c` can register hooks | Unverified. `notify` and OSC 9 only until confirmed. |
| Gemini CLI: per-session hook injection without writing user or project settings | Unverified (not installed). Process-only until confirmed. |
| OSC 9 sequences in Codex output under ConPTY | Verify with the fake provider and one owner-approved run. |

## 8. Sources

1. Claude Code hooks reference — https://code.claude.com/docs/en/hooks
2. Claude Code hooks guide (limits, timeouts, PermissionRequest behaviour) — https://code.claude.com/docs/en/hooks-guide · permissions and hooks — https://code.claude.com/docs/en/permissions
3. Claude Code CLI reference — https://code.claude.com/docs/en/cli-reference · settings — https://code.claude.com/docs/en/settings · installed `claude --help` (2.1.282)
4. Codex hooks — https://learn.chatgpt.com/docs/hooks
5. Codex advanced configuration (`notify`, `tui.notifications`) — https://learn.chatgpt.com/docs/config-file/config-advanced · installed `codex --help` (0.155.1)
6. Codex approvals and security — https://learn.chatgpt.com/codex/agent-approvals-security
7. Gemini CLI hooks — https://geminicli.com/docs/hooks
8. Gemini CLI hooks reference — https://geminicli.com/docs/hooks/reference
9. Running Claude Code inside another product (unmodified binary, user's own authentication, name and logo use) — https://code.claude.com/docs/en/legal-and-compliance
