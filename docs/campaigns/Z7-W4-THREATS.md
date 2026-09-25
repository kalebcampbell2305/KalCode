# Z7-W4 threat model: provider panes and the hook bridge

Status: **written before implementation** (ADVANCED.md §5.3 rule 6). Scope: interactive provider
panes (`crates/providers/src/interactive`), the `kalcode-hook` helper and bridge server
(`crates/hook-bridge`), the PTY launch API (`crates/pty`), and the pane IPC commands. Reviewed
against ADVANCED.md §9 ("Provider panes / hook bridge") and §14b.

Facts below were checked on 2026-09-24 against the Claude Code hooks reference
(https://code.claude.com/docs/en/hooks), the permissions page
(https://code.claude.com/docs/en/permissions), the settings page
(https://code.claude.com/docs/en/settings) and the installed `claude --help` (2.1.282). No provider
session was started.

## 1. What the bridge is

A Claude Code session running in a pane is started with a KalCode-owned `--settings <file>`
whose hooks run `kalcode-hook` in **exec form** (`"command": <absolute helper path>, "args": [...]`:
the documented form that spawns the program directly, with no shell). For each hook event the
helper reads the hook JSON from stdin, connects to KalCode over a local endpoint, sends a
bounded, filtered record, and prints the decision (PreToolUse) or nothing (status events).

```text
claude (PTY)  --spawns-->  kalcode-hook  --local pipe/socket-->  KalCode bridge server
                                                                   │
                                        session registry (id → key, handler)
                                                                   │
                                     InteractiveSession → AgentEvent → Z3 runtime → Z4 engine
```

Assets: the user's machine and repositories (what a tool call may do); the integrity of
KalCode's approvals (a decision must come from KalCode policy or the person); the integrity of
thread status shown to the person; the per-session key.

## 2. Trust boundaries and actors

| Actor | Trusted for | Not trusted for |
| --- | --- | --- |
| The person at the keyboard | Everything they do in KalCode's UI and in the provider's TUI (typing is user authority, like a terminal tab) | — |
| KalCode native process | Policy, approvals, key generation | — |
| The provider CLI process (`claude`) | Running hooks as configured; reporting structured hook payloads | Its model output (prompt-injectable); any claim of approval |
| Processes the provider starts (tool commands) | Nothing | They inherit the provider's environment, so they can read the session key (§4.6) |
| Other processes of the same OS user | Nothing, but they are **out of scope** as an attacker: they can already read KalCode's data folder, the settings file and every process's environment (SECURITY.md §1 assumption 1) | — |
| Other OS users on the machine, remote hosts | Nothing | — |
| Repository content | Nothing (TK K4) | — |

## 3. Design decisions that follow from the threats

1. **Per-user endpoint, random name, never TCP.** Windows: a named pipe
   `\\.\pipe\kalcode-hook-<128-bit random>` created with `FILE_FLAG_FIRST_PIPE_INSTANCE` and
   `PIPE_REJECT_REMOTE_CLIENTS` (safe tokio API, no new `unsafe`). Unix: a socket in a fresh
   `0700` directory under `$XDG_RUNTIME_DIR` (else the temp folder) with a random name. No TCP or
   HTTP listener exists.
2. **Mutual challenge–response with a per-session key; the key never crosses the wire.** Each
   session gets a 256-bit key from the OS CSPRNG. Per connection the server sends a fresh 256-bit
   nonce; the helper answers with its own nonce and `HMAC-SHA256(key, "kalcode-hook/1 req" ‖
   server_nonce ‖ client_nonce ‖ session ‖ body)`; the server replies with `HMAC-SHA256(key,
   "kalcode-hook/1 resp" ‖ server_nonce ‖ client_nonce ‖ body)`. MACs are compared in constant
   time. A request without a valid MAC is dropped with no reply content; a reply without a valid
   MAC is treated by the helper as "KalCode unreachable" (fail closed for PreToolUse).
3. **Fail closed for PreToolUse, fail open for status.** Per the hooks reference, only exit 2
   blocks; a timed-out hook, a non-2 non-zero exit and invalid JSON are *non-blocking* and the
   call continues through the normal permission flow. So the helper for PreToolUse:
   - has its own deadline, shorter than the configured hook timeout, and exits **2** when it
     passes;
   - exits **2** on every error path (connect failure, bad MAC, malformed reply, oversized
     stdin, unknown event), and installs a panic hook that exits 2 (release builds abort on
     panic, and an abort's exit code would be non-blocking);
   - prints JSON only on exit 0.
   For status events the helper always exits 0 with no output.
4. **Decisions only flow from KalCode to the helper as answers to the helper's own request.**
   There is no message by which a client can answer, cancel or modify another request. Only the
   person answers approvals, through Z4 `approval_decide` (`Actor::User`).
5. **Repository cannot configure the session.** `--setting-sources user` (Plan: `--restricted`,
   which ignores user/project/local settings but still applies `--settings` and managed
   settings) and `--strict-mcp-config`, exactly as Z2 headless. The KalCode settings file lives in
   KalCode's data folder, is regenerated on every launch and is never read back.
6. **The Z2 deny floor still applies** through `--disallowedTools` (credential files, remote
   programs and publish/push commands in Bash and PowerShell; plus the edit and web tools in
   Plan). The permissions page states a matching deny rule blocks a call "regardless of what a
   PreToolUse hook returns", so a KalCode "allow" can never widen past the floor, and the user's
   own Claude Code deny/ask rules only add strictness. KalCode's "allow" does skip Claude Code's
   own prompt for that call; that is the intended effect (KalCode is the approver).
7. **Behind a flag until the classifier is fixed.** §14b: the permission classifier has latent
   bypasses being fixed on `sec/latent-hardening`. Until that merges and is re-reviewed, the
   bridge runs with `DecisionRouting::ProviderPrompt`: PreToolUse still requires a successful,
   authenticated round-trip (so an unreachable KalCode still blocks), records the tool call for
   status, and returns **no decision**, leaving the call to Claude Code's own permission flow
   and its prompt in the pane (answered by the person) under the deny floor. Only
   `DecisionRouting::Engine` turns hook calls into `ApprovalRequired` events for the Z3 runtime
   and Z4 engine.

   **Update (2026-09-25):** the classifier hardening merged to main (65fe095,
   `docs/campaigns/SEC-LATENT.md`), so `Engine` is now the default. The whole feature stays behind
   the `provider_panes` flag until the Z7-W4 acceptance matrix passes. The classifier's still-open
   gaps (SEC-LATENT §5) are handled at the bridge by sending those calls as opaque (always an
   explicit, one-time approval): recursive searches (the Grep tool over a folder, `grep -r`, `rg`,
   `findstr /s`, `Select-String`/`Get-ChildItem -Recurse`), pipelines, and multi-level wildcards
   (`session::known_gap`). `ProviderPrompt` remains as a switch (and, in debug/e2e builds,
   `KALCODE_E2E_HOOK_DECISIONS=provider_prompt`).

## 4. Threats

Each row: threat → control → residual risk → test.

### 4.1 Forged hook calls from other local processes

*Threat.* A process that is not the session's helper connects to the endpoint and sends
PreToolUse/PermissionRequest records to raise fake approvals, or Stop/SessionEnd records to fake
status.

*Control.* Endpoint name is random; other OS users can't read the name (it's in the provider's
environment and KalCode's data folder) and can't open a pipe instance for writing under the
default pipe DACL (Everyone gets read only). Every request must carry a valid HMAC under the
session key over a fresh server nonce. Unknown session ids and bad MACs are rejected and counted;
the server closes the connection without processing.

*Residual.* A same-user process can read the key from the provider's environment: out of scope
(§2). See §4.6 for the provider's own child processes.

*Tests.* `forged_request_without_key_is_rejected`, `wrong_key_is_rejected`,
`unknown_session_is_rejected`, `tampered_body_is_rejected` (hook-bridge server tests).

### 4.2 Replay

*Threat.* A captured request is replayed to obtain another decision or duplicate status.

*Control.* The MAC covers the server's per-connection nonce, which is random and used once, so a
recorded request never verifies on a new connection. The reply MAC covers both nonces, so a
recorded reply can't be fed to a later helper. Session keys are revoked when the session ends
(stale-session hooks are rejected).

*Tests.* `replayed_request_is_rejected`, `replayed_reply_is_rejected_by_helper`,
`revoked_session_is_rejected`.

### 4.3 Pipe squatting and server impersonation

*Threat.* A process creates the pipe name first (squatting) or adds an instance to KalCode's pipe,
so the helper talks to it: it could learn request contents or answer "allow".

*Control.* (a) The name is random per KalCode run and unknown to other users. (b) KalCode creates
the first instance with `FILE_FLAG_FIRST_PIPE_INSTANCE`; if the name exists, startup of the bridge
fails and panes refuse to start ("hook channel unavailable") rather than continue without it.
(c) Other users can't add instances (the default DACL doesn't grant them
`FILE_CREATE_PIPE_INSTANCE`). (d) Even a successful impostor can't produce a reply MAC, so the
helper fails closed (PreToolUse exits 2). (e) The helper opens the pipe with
`SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION` (safe `OpenOptionsExt::security_qos_flags`), so
a server can identify but not impersonate the helper's token. (f) `PIPE_REJECT_REMOTE_CLIENTS`.
Unix: the socket's directory is created fresh with mode 0700 and refused if it already exists.

*Not done, and why.* An explicit owner-only DACL on the pipe and verifying the client process id
(`GetNamedPipeClientProcessId`) both need Win32 FFI (`unsafe`). With (a)–(f) the DACL is defence
in depth (other users only have read access), and a PID check adds little: the helper is a
short-lived grandchild of the provider (spawned by `claude`, possibly through a shell for other
hooks), so ancestry checks are racy, and the MAC already proves key possession. Recorded as a
follow-up for security review (§6) rather than adding `unsafe` in this change.

*Tests.* `first_instance_fails_when_name_is_taken` (Windows), `helper_rejects_impostor_server`,
`socket_directory_must_be_new` (Unix).

### 4.4 KalCode unreachable, slow, or crashed

*Threat.* The bridge is down (KalCode exited, crashed, restarted) or stalls, and a tool call runs
without KalCode's check.

*Control.* §3.3: the helper's own deadline for PreToolUse (connect retries ≤ 3 s; total ≤ the
configured timeout minus a margin), exit 2 on expiry. KalCode sets explicit hook timeouts in the
settings file (PreToolUse 600 s, status events 10 s) so the provider's own timeout never fires
first. The server bounds concurrent connections and reads (request read timeout 5 s, 256 KiB
frame cap) so a stuck client can't wedge it. When KalCode exits, panes' processes are ended with
the app (`ThreadRuntime::shutdown`), and any helper still running exits 2.

*Residual.* If the person keeps using a provider whose KalCode has died, every tool call is
blocked with a message saying KalCode is unavailable. That is the intended fail-closed behaviour.

*Tests.* `unreachable_endpoint_blocks_pre_tool_use`, `unreachable_endpoint_is_silent_for_status`,
`stalled_server_blocks_before_hook_timeout`, `oversized_stdin_blocks`, `bad_reply_mac_blocks`.

### 4.5 Timeouts and unanswered approvals

*Threat.* KalCode asks the person, nobody answers, the provider's hook times out and the call
proceeds (a timed-out PreToolUse hook is non-blocking).

*Control.* The server answers every held request before the helper's deadline: after the ask
window (default 540 s; helper deadline 590 s; hook timeout 600 s) it returns
`permissionDecision: "ask"`, which forces Claude Code's **own prompt** in the pane (the person
decides there), and expires the KalCode request with reason `answered_in_provider` (v4 CHECK
value). It never returns "allow" on a timeout. At most 8 approvals may be held per session;
further PreToolUse calls get "ask" immediately (no approval flood through KalCode's queue).

*Tests.* `unanswered_ask_hands_over_to_provider_prompt`, `ask_window_is_shorter_than_helper_deadline`,
`held_approvals_are_bounded`.

### 4.6 The provider's own tool commands (prompt injection)

*Threat.* A prompt-injected tool command inherits the provider's environment (including the
session key) and forges bridge calls, or tries to change KalCode policy.

*Control / what it can do.* It can send authenticated records for **its own session only**. It
cannot answer approvals (§3.4), cannot change modes or rules (no such message exists), and a
forged PreToolUse only produces a decision returned to the forger itself, which authorizes
nothing in the provider. It can raise real-looking approval requests in KalCode's queue; each
shows the exact classified action, and approving one grants only that action (or, for "Allow for
thread", the Z4 grant fingerprint the person saw). It can spoof its own session's status
(e.g. report Stop while working). Status spoofing is bounded to the session that ran the
command, and process/PTY state (exit, exit code) still comes from the OS, not the bridge.

*Residual (accepted, documented in the pane info panel).* Status of an interactive session is
as trustworthy as the provider process and what it runs. There is no way to give hooks a
credential that the provider's tool commands can't also read: both are children of the same
process with the same environment.

*Tests.* `records_are_bound_to_their_session`, `no_client_message_can_answer_an_approval`,
`held_approvals_are_bounded`.

### 4.7 Repository influence

| Can the repository… | Answer |
| --- | --- |
| add hooks, allow rules, MCP servers or `env` through `.claude/settings*.json` / `.mcp.json`? | No: project/local sources are not loaded (`--setting-sources user`; Plan `--restricted`), `--strict-mcp-config`. |
| replace `kalcode-hook` or the provider? | No: the helper path is absolute (next to the KalCode executable), the provider is resolved by Z2 detection from absolute folders with shim hardening, and the environment has `NoDefaultCurrentDirectoryInExePath=1` and absolute `PATH` entries. Exec form means no shell resolves the hook command. |
| disable KalCode's hooks? | Not through project settings (not loaded). The **user's** settings or managed policy can (`disableAllHooks`, `allowManagedHooksOnly`, `--bare`-like modes are never passed by KalCode). KalCode detects "no SessionStart within 20 s" and marks the pane "limited status — approvals in the provider"; the deny floor still applies. |
| influence classification? | Only through the tool input the model produces (prompt injection), which is exactly what the classifier judges. Compound and unparseable commands are opaque ⇒ ask (Z4). |
| show the workspace-trust dialog? | Interactive Claude Code shows its own trust dialog for new folders (cli-reference); that is the provider's UI and the person answers it. |

### 4.8 Hook payload handling

*Threat.* Oversized or malicious hook JSON (huge tool inputs, control characters, deep nesting)
exhausts memory or injects text into KalCode's UI or logs.

*Control.* stdin is read with a 1 MiB cap (PreToolUse over the cap: exit 2). The helper parses
and **re-serializes only the fields KalCode uses** (event, session id, tool name, tool use id,
a bounded tool input for classification, notification type, source, error type) — tool output,
transcripts and assistant messages are dropped before sending. The first prompt is forwarded
only for the deterministic namer (clipped to 2 KiB) and never stored or put in an event; only
the derived title is stored. Every string reaching the runtime passes Z3's `validate::provider_text`
bounds. The bridge never logs payload bodies.

*Tests.* `drops_fields_kalcode_does_not_need`, `oversized_stdin_blocks`,
`first_prompt_is_used_only_for_the_title`.

### 4.9 Prose that looks like status

*Threat.* Model output printed in the TUI (e.g. "Status: DONE", "PERMISSION REQUIRED") changes
KalCode's status.

*Control.* PTY bytes are never parsed for status. The only PTY-level signal used is the process
exit (and, for Codex, the OSC 9 escape sequence, a structural terminal control sequence, not
prose). Z7-02 test feeds such prose through the fake provider and asserts no status change.

### 4.10 Launch arguments

*Threat.* A mode maps to broader provider authority, or a forbidden flag appears.

*Control.* Interactive mapping per PROVIDER_PANES §4, reconciled with the installed help:
`--permission-mode` values are checked against the verified list for 2.1.282
(`acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`) and only `plan`, `manual`,
`acceptEdits` are ever emitted; never `bypassPermissions`, `auto`,
`--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--bare`,
`--safe-mode` or `--add-dir`. Model and session id are validated as in Z2; the title passed with
`-n` is validated (length, no control characters, not starting with `-`). Codex: never
`danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`,
`--dangerously-bypass-hook-trust`.

*Tests.* `interactive_modes_are_verified_and_never_broader`, `forbidden_flags_never_appear`,
`codex_interactive_never_uses_forbidden_flags`.

### 4.11 IPC surface (WebView possibly compromised)

*Threat.* The WebView starts panes with chosen executables or paths, writes to other panes, or
flips the decision flag.

*Control.* Pane commands take ids and enums only; the executable, helper path, cwd and settings
path are native-resolved. Writes and resizes are bounded like Z1 terminals (64 KiB per write,
2..1000 cells). The decision-routing flag is native (not an IPC input). Attach streams are
per-webview with the Z1 flow-control bound (4 MiB unacked).

### 4.12 How deny rules, the hook and KalCode approvals combine (flag on)

Order for one Claude Code tool call (from the hooks and permissions references):

1. PreToolUse hooks run first. `kalcode-hook` exit 2 → blocked (nothing else is evaluated).
2. KalCode's reply: `deny` → blocked; `ask` → Claude Code prompts in the pane; `allow` → skip
   the prompt, **but** deny rules (KalCode's `--disallowedTools` floor, the user's and managed
   deny rules) still block and ask rules still prompt.
3. Other PreToolUse hooks (the user's own) may be stricter; the most restrictive wins
   (deny > defer > ask > allow).

So the effective decision is never broader than KalCode's policy, and never broader than the
deny floor.

## 5. Security-relevant assumptions to confirm in the owner-approved smoke run

1. `--settings <file>` hooks load together with `--setting-sources user` (the settings page says
   `--settings` applies above user/project/local; the permissions page shows
   `--settings '{"disableAllHooks": true}'` taking effect, so hook keys in `--settings` are honoured).
2. Exec-form `args` works for the installed version (documented in the hooks reference).
3. Hooks inherit the provider's environment (the key variable reaches the helper).
4. The payload field for UserPromptSubmit is `prompt` (older docs) or `user_prompt` (current
   reference excerpt); the parser accepts either.

The smoke script (`tooling/smoke/claude-interactive-smoke.ps1`) is written but **not run**; it
needs the owner's approval because it starts a real session.

## 6. Follow-ups for security review

- Owner-only DACL on the Windows pipe and client PID logging (needs isolated Win32 FFI).
- Flip `DecisionRouting::Engine` on only after `sec/latent-hardening` merges and is re-reviewed.
- Provider-reported `waiting_for_permission` for mirrored provider prompts needs a Z3 runtime
  change (today the runtime ignores that status from providers; mirrored prompts show as
  WAITING FOR YOU with the detail "Answer in Claude Code").
