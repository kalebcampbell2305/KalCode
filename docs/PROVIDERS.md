# KalCode Provider Architecture

Status: contract defined in Z0 · Implemented in Z2 (detection for Claude Code, Codex and Gemini
CLI; Claude Code adapter) · Codex and Gemini CLI adapters, their panes and Provider Health in
PROVIDERS-2 (`docs/campaigns/PROVIDERS-2.md`) · Code: `crates/providers` · Contract:
`crates/contracts/src/agent.rs`, `health.rs` · Facts verified 2026-09-24/25 against official docs,
the providers' published SDK/source type definitions and the installed CLIs (Claude Code 2.1.282,
codex-cli 0.157.0; Gemini CLI not installed) · Launch and permission hardening: SEC-0.1.1
(`docs/campaigns/SEC-0.1.1.md`)

## 1. Principles

- KalCode depends on **no single provider**. Provider-specific logic lives behind the
  `AgentProvider` contract and is translated at the adapter boundary into KalCode concepts
  (normalized events, statuses, approvals, capabilities).
- Only **legitimate, documented** integration methods are used: authenticated local CLI
  sessions, documented OAuth, API keys, enterprise credentials, workload identity. KalCode never
  scrapes browser credentials, copies hidden tokens, or reverse-engineers private auth.
- Connecting a provider is available on **every plan**.
- One provider failing never degrades other providers, terminals, workspaces or the Dashboard.
  Each adapter runs its sessions in supervised child processes with isolated failure handling.

## 2. Contract (summary)

```ts
interface AgentProvider {
  id: ProviderId; displayName: string;
  detect(): Promise<ProviderDetection>;              // read-only, never modifies the machine
  getCapabilities(): Promise<ProviderCapabilities>;
  getAccounts(): Promise<ProviderAccount[]>;
  createSession(config: SessionConfig): Promise<AgentSession>;
  send(sessionId, input: AgentInput): Promise<void>;
  interrupt(sessionId): Promise<void>;
  resume(sessionId): Promise<void>;
  terminate(sessionId): Promise<void>;
  approve(requestId, scope: ApprovalScope): Promise<void>;
  deny(requestId): Promise<void>;
  events(sessionId): AsyncIterable<AgentEvent>;     // normalized, typed
}
```

The runtime contract is Rust (`crates/contracts/src/agent.rs`, exported to TypeScript with
ts-rs; see `docs/CONTRACTS.md`). There, `AgentProvider` has `detect`, `capabilities` and
`start_session(config, sink)`; the returned `AgentSession` has `send`, `interrupt`, `terminate`,
`respond_to_approval` and `provider_session_id`. Resume is `SessionConfig.resumeSessionId`,
events flow to an `AgentEventSink`, and accounts arrive in a later campaign.
`packages/protocol/src/providers.ts` keeps the Z0 TypeScript sketch.

## 3. Business rule: bring your own provider

Owner decision. KalCode is **zero-cost to run for providers**: it never pays for user inference.

- Providers run only through the **user's own** documented CLI sign-in, subscription or API key.
  Usage counts against the user's own plan or is billed to the user's own account.
- No company-owned Anthropic, OpenAI or Google credentials exist anywhere: not in the app, the
  repository, builds, CI, or any KalCode server. There is **no fallback** to a KalCode-paid API
  or proxy.
- KalCode never performs the sign-in. If a provider is missing or signed out, KalCode says so and
  shows the provider's own command (`claude auth login`, `codex login`, `gemini`); it never
  substitutes another route.
- API-key accounts stored in KalCode (`SessionConfig.secretRef`) are a later campaign; Z2 refuses
  them (`ProviderError::Unsupported`). When added, keys stay the user's own, in the OS keychain.
- **Credential scoping.** Each provider child gets only its own variables plus an OS, locale,
  temp-folder and proxy/CA allow-list (`crates/providers/src/env.rs`):

  | Provider | Provider variables passed |
  | --- | --- |
  | Claude Code | `ANTHROPIC_*`, `CLAUDE_*` |
  | Codex | `OPENAI_*`, `CODEX_*` |
  | Gemini CLI | `GEMINI_*`, `GOOGLE_*` |

  `KALCODE_*`, `WEBVIEW2_*` and `WEBKIT_INSPECTOR*` never pass, even if a prefix would match.
  A Claude Code process never sees an OpenAI key, and unrelated secrets (`GITHUB_TOKEN`, cloud
  keys) never pass at all.
- **No lookups in the working directory** (`env::harden`, applied when the environment is built
  and again at spawn). Every provider environment has `NoDefaultCurrentDirectoryInExePath=1`, so
  `cmd.exe` never looks for a bare program name (`node`) in the workspace, and its `PATH` keeps
  only absolute entries (empty and relative entries such as `.` are dropped).
- **Choosing a provider.** `ProviderRegistry::usable()` lists providers that have an implemented
  adapter, are installed at a supported version, and are not known to be signed out. Threads and
  KalVoice (the in-app assistant) let the user pick from this list.

## 4. Capability matrix

What each provider documents, and what KalCode uses. A capability flag in `ProviderCapabilities`
is `true` only when KalCode's adapter implements it.

| Capability | Claude Code | Codex | Gemini CLI |
| --- | --- | --- | --- |
| Non-interactive mode | `claude -p` [1] | `codex exec` [5] · **used** | non-TTY input / `-p` [9] · **used** (stdin) |
| Streaming output | `--output-format stream-json`, `--include-partial-messages` [1] · **used** | `codex exec --json` (JSONL: `thread.started`, `turn.started`, `item.*`, `turn.completed`, `turn.failed`, `error`) [5][13] · **used** | `--output-format stream-json` (`init`, `message`, `tool_use`, `tool_result`, `error`, `result`) [9][15] · **used** |
| Stream input | `--input-format stream-json` (SDKUserMessage lines) [1][3] · **used** | One process per turn, prompt on stdin (`-`), as the official SDK does [14] · **used**; app-server JSON-RPC (`turn/start`) [8] planned | One process per turn, prompt on stdin [9] · **used** |
| Interrupt | `interrupt` control request, advertised by `interrupt_receipt_v1` [3] · **used** (§8.4) | Kill the turn's process tree (the SDK's documented cancellation) [14] · **used**; app-server `turn/interrupt` [8] planned | Kill the turn's process tree · **used** |
| Resume | `--resume <id>`, `--session-id <uuid>` [2] · **used** | `codex exec … resume <thread id> -` [5] · **used** | `--resume <session uuid>` [10][16] · **used** (never `latest` or an index) |
| Host approvals | `--permission-prompt-tool` (MCP) [2] · not used until Z4 | app-server approval requests (accept/decline) [8] · planned (§8.8) | None documented for headless |
| Auth status check | `claude auth status`: exit 0 signed in, 1 not [2] · exit code only | `codex login status` [11]; exit codes and wording undocumented | None side-effect-free → unknown |
| Model listing | Documented aliases [4]; KalCode lists `default`, `opus`, `sonnet`, `haiku`, `fable` | app-server `model/list` only → not discoverable; "Provider default" | Documented `--model` aliases (`auto`, `pro`, `flash`, `flash-lite`) [10] · listed |
| Rate limits | `assistant.error = rate_limit`, `StopFailure rate_limit` (structured) · used by Provider Health | No structured shape in the exec stream → never reported | `result.error.type` `RetryableQuotaError` / `TerminalQuotaError` [17] · used by Provider Health |
| KalCode adapter | **Implemented** (Z2), minimum version 2.1.259 | **Implemented** (PROVIDERS-2), minimum version 0.155.1 | **Implemented** (PROVIDERS-2), no minimum declared (not installed on the verification machine) |

## 5. Permission mapping

Every mapping is **approximate (stricter)** because each adapter adds a common capability floor
and Custom does not yet translate provider-specific rules. The mode itself follows the owner's
provider-native execution contract. The flags shown are the ones the code uses, and each
displayed string is generated from the argv, so it cannot drift: Claude Code's from
`crates/providers/src/claude/argv.rs`, Codex's from `crates/providers/src/codex/argv.rs`, Gemini
CLI's from `crates/providers/src/gemini/mod.rs`.

Provider execution permissions remain provider-native. KalCode workspace and pane UI operations
do not need a second KalCode approval. A provider prompt is answered in that provider's real TUI;
KalCode does not synthesize or auto-answer it. Headless adapters select the same documented native
policy, but cannot render an interactive provider prompt in KalCode.

Why the mappings remain approximate and bounded:

- Claude Code's `auto` mode is never used (its classifier's decisions are not KalCode policy),
  and `bypassPermissions` / `--dangerously-skip-permissions` are never used (they would also
  allow remote-consequential actions such as `git push`).
- Codex uses `danger-full-access` only for the explicitly selected Bypass mode. The combined
  `--dangerously-bypass-approvals-and-sandbox` switch is never used. Gemini CLI `yolo` is never
  used.
- **Custom** profiles run on the Approve baseline. Their rules are not applied to provider
  sessions yet (see below).

Unit tests fail the build if a mapping uses a forbidden mode or flag, emits a competing native
permission pair, or if a Claude Code mode ranks above its cap.

### Claude Code

Every session also passes `--permission-prompts none` (v2.1.259+: deny what would prompt),
`--strict-mcp-config` [2][6], and KalCode's own deny rules with `--disallowedTools`
(`deny_rules` in `argv.rs`, one argv element per rule) [2][12].

| KalCode | Claude Code flags | KalCode deny rules | Fidelity | Notes |
| --- | --- | --- | --- | --- |
| Plan | `--restricted --permission-mode plan` | edit and web tools + credential files + remote actions | Stricter | `--restricted` (v2.1.248+) removes command/code-running tools and WebFetch, confines file tools to the working directory, ignores user, project and local settings (managed settings and KalCode's flags still apply), refuses `bypassPermissions`. Plan blocks edits. Even read-only commands are unavailable. |
| Approve | `--setting-sources user --permission-mode default` | edit and web tools + credential files + remote actions | Stricter | Reads and Claude Code's built-in read-only commands run. `Edit`, `Write`, `NotebookEdit`, `WebFetch` and `WebSearch` are removed. Anything else that would ask is refused, unless the user's own Claude Code allow rules cover it (below). |
| Auto | `--setting-sources user --permission-mode default` | edit and web tools + credential files + remote actions | Stricter | Runs like Approve. |
| Bypass | `--setting-sources user --permission-mode acceptEdits` | credential files + remote actions | Stricter | File edits and `mkdir`/`touch`/`rm`/`rmdir`/`mv`/`cp`/`sed` in the working directory. Other commands and network are refused unless the user's own Claude Code allow rules cover them. |
| Custom | as Approve | as Approve | Stricter | Approve baseline; Custom rules are not applied yet. |

**Remote-action deny rules (every mode, including Plan and Bypass).** For both the `Bash` and
`PowerShell` tools: every use of `gh`, `vercel`, `netlify`, `wrangler`, `firebase`, `fly`/`flyctl`,
`heroku`, `railway`, `surge`, `aws`, `gcloud`, `az`/`azd`, `doctl`, `kubectl`, `helm`,
`terraform`/`tofu`, `pulumi`, `cdk`, `sam`, `serverless`/`sls`, `eb`, `stripe`, `ssh`, `scp`,
`sftp`; and `git push` (also `git <options> push`), `git send-pack`, `git http-push`,
`git svn dcommit`, `git p4 submit`, `git subtree push`, `npm publish` (also
`npm <options> publish`), `pnpm`/`yarn`/`bun publish`, `yarn npm publish`, `cargo publish`,
`twine upload`, `poetry`/`uv`/`flit`/`hatch publish`, `gem push`, `dotnet nuget push`,
`nuget push`, `mvn deploy`, `docker push`, `podman push`. These are KalCode's
remote-consequential scopes (`git.push`, `deploy.production`, `cloud.modify`,
`messaging.send`), which no KalCode mode allows without an approval KalCode can't give yet.

**Credential-file deny rules (every mode).** `Read` deny rules for `.env`, `.env.*`, `.npmrc`,
`.pypirc`, `.netrc`/`_netrc`, `.git-credentials`, `id_rsa*`/`id_ecdsa*`/`id_ed25519*`,
`secrets.json` and `credentials.json` on any drive, and `~/.ssh`, `~/.aws`, `~/.azure`,
`~/.config/gcloud`, `~/.kube` and `~/.docker/config.json` (KalCode's `credentials.access`, which
asks in every mode). A `Read` deny rule also blocks editing the path. Claude Code applies it to
its file tools and to the file commands it recognizes in Bash (`cat`, `head`, `sed`,
redirections), not to a script that opens files itself [12].

#### What KalCode enforces for Claude Code threads today (0.1.1)

KalCode's permission engine (`docs/PERMISSIONS.md`) judges actions only when a provider hands
them to KalCode. Claude Code headless threads don't (`hostApprovals: false`), so the engine,
Custom profile rules, standing grants and the "remote-consequential always asks" rule are **not**
evaluated per tool call for Claude Code today. What does hold:

| Enforced by | Guarantee |
| --- | --- |
| KalCode (launch flags) | The mode's Claude Code permission mode (never `auto` or `bypassPermissions`); prompts denied (`--permission-prompts none`); repository settings, hooks and `.mcp.json` servers not loaded; the deny rules above. Deny rules win over allow rules from every settings source and over a `PreToolUse` hook that returns "allow" [12], so the user's own Claude Code settings can't re-enable them. |
| Claude Code | Everything else: which commands run without a prompt (its built-in read-only set, `acceptEdits` in Bypass) and **the user's own user-level Claude Code settings**, which are loaded in every mode except Plan. A command allowed there (for example `Bash(npm test)`) runs in a KalCode thread without a KalCode approval, and the user's own hooks run. |

Limits of the deny rules: a Bash or PowerShell rule matches the command as Claude writes it, after
Claude Code splits compound commands (`&&`, `;`, `|`, subshells, `$(…)`) and strips simple wrappers
(`timeout`, `nice`, `env` assignments…). The same program started another way — by full path
(`/usr/bin/git push`), through `sh -c`, or quoted (`git 'push'`) — is not matched [12]. Claude
Code then decides it by its mode: nobody can approve, so it is refused unless the user's own
Claude Code allow rules cover that form (for example a broad `Bash(git *)` allow rule).

Per-action KalCode decisions for Claude Code — every tool call through the Trust Kernel, KalCode
approval prompts, Custom rules — arrive with provider panes and the hook bridge (Z7,
`docs/PROVIDER_PANES.md` §2 and §4), where a KalCode `PreToolUse` hook is the enforcement point.
The bridge is built (see "Claude Code in a provider pane" below); decisions through the engine
stay behind a flag until the classifier fixes merge. Headless threads are unchanged.

`--setting-sources user` and `--strict-mcp-config` exist because `-p` skips the workspace trust
dialog and would otherwise run a repository's project hooks, allow rules and `.mcp.json` servers
without approval [1]. Managed settings always apply.

### Claude Code in a provider pane (Z7-W4, behind the `provider_panes` flag)

A thread created with `provider_pane_create` runs the real, unmodified `claude` TUI in a PTY
(`crates/providers/src/interactive`, `docs/PROVIDER_PANES.md`). Launch flags
(`interactive::claude::interactive_args`, verified against `claude --help` 2.1.282):

| KalCode | Claude Code flags | KalCode deny rules (`--disallowedTools`) |
| --- | --- | --- |
| Plan | `--restricted --permission-mode plan` | edit and web tools + credential files + remote actions |
| Approve | `--setting-sources user --permission-mode manual` | credential files + remote actions |
| Auto | `--setting-sources user --permission-mode manual` | credential files + remote actions |
| Bypass | `--setting-sources user --permission-mode acceptEdits` | credential files + remote actions |
| Custom | as Approve | as Approve |

Every pane also passes `--strict-mcp-config`, `--settings <data>/sessions/<thread>/claude-settings.json`
(KalCode's hooks, exec form, explicit timeouts; nothing that relaxes permissions and no secret)
and `--session-id <uuid>` or `--resume <id>`. Never: `bypassPermissions`, `auto`, `dontAsk`,
`--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--allowedTools`,
`--add-dir`, `--bare`, `--safe-mode`, `-p`. A test fails if a mode outside the installed help's
list is emitted. `manual` is the listed name of Claude Code's ask-normally mode (hook payloads
report it as `default`; the headless Z2 argv still passes `default`).

Unlike headless threads, the edit and web tools are not removed outside Plan: a person answers
for them, in KalCode (engine routing) or in Claude Code's own prompt in the pane.

**Who decides a tool call.** Every call reaches KalCode's `PreToolUse` hook first. If KalCode is
unreachable, the helper exits 2 and the call is blocked. With `DecisionRouting::Engine` (the
default since the classifier hardening merged) the call becomes `ApprovalRequired` for the Z3
runtime and the Z4 engine: allow, deny, or a KalCode approval; unanswered for 540 s it goes to
Claude Code's prompt and the KalCode request expires as `answered_in_provider`. Recursive
searches, pipelines and multi-level wildcards are sent as opaque (always ask) until the
classifier judges them (SEC-LATENT §5). With `DecisionRouting::ProviderPrompt` (the switch back)
KalCode records the call and returns no decision: Claude Code's own permission flow and prompt
decide, under the deny floor. KalCode's "allow" never
passes a deny rule (the permissions page: deny rules apply regardless of a hook's answer).

What this still does not cover is listed in `docs/PROVIDER_PANES.md` §4 ("What KalCode cannot
intercept").

### Codex (headless threads, PROVIDERS-2)

Every turn passes `exec --json --ignore-rules --ignore-user-config`, disables connected tools and
web search, clears inherited MCP registrations, bounds the child environment, and adds the exact
native permission pair below:

| KalCode | Codex flags | Fidelity | Notes |
| --- | --- | --- | --- |
| Plan | `--sandbox read-only -c approval_policy='never' --skip-git-repo-check` | Stricter | Reads and read-only commands in Codex's native read-only sandbox; edits and approval requests are refused. |
| Approve | `--sandbox workspace-write -c approval_policy='on-request'` | Stricter | Workspace writes use Codex's native approval policy. In a pane, the person answers Codex's prompt; a headless turn cannot surface that prompt through KalCode. |
| Auto | `--sandbox workspace-write -c approval_policy='never'` | Stricter | Workspace writes run without provider approval prompts; the native workspace sandbox remains active. |
| Bypass | `--sandbox danger-full-access -c approval_policy='never'` | Stricter | Codex's explicit native full-access sandbox with provider approval prompts disabled. Connected tools and Codex web search remain disabled by the common floor. |
| Custom | as Approve | Stricter | Custom provider rules are not translated yet, so Custom uses the native Approve pair. |

Why each flag (sources [5][7][13][14][18]): `codex exec` has **no** `--ask-for-approval` flag
(installed `codex exec --help`); `approval_policy` is the documented config key, set with `-c`
exactly as the official TypeScript SDK does. `on-request` and `never` therefore retain Codex's
native meaning instead of introducing a KalCode approval layer. `web_search='disabled'` and an
empty MCP map prevent connected capabilities from appearing independently of the selected mode.
`shell_environment_policy.inherit='core'`
keeps provider keys (`OPENAI_*`, `CODEX_*`) out of the commands Codex runs (Codex keeps variables
named `*KEY*`/`*TOKEN*` by default). `--ignore-rules` means a repository's execpolicy `.rules`
never grant anything (K4); it also skips the user's own rules, which is noted as a gap below.
`--skip-git-repo-check` appears only in Plan. The message is sent on stdin (`-`), never on the
command line. Resume repeats the same sandbox and approval pair before `resume <thread id> -`.

Never used, in any mode: `--dangerously-bypass-approvals-and-sandbox`,
`--dangerously-bypass-hook-trust`, `--approve-for-me`, `--search`, `--add-dir`, `--oss`,
`--worktree`, `untrusted` approvals, live web search or an explicit workspace-network grant.
Tests fail if a forbidden switch appears, if a mode emits another mode's pair, or if resume drops
the selected pair (`codex::argv` unit tests and `turns_pipeline` against the fake).

#### What KalCode enforces for Codex threads today, and the gaps

| Enforced by | Guarantee |
| --- | --- |
| KalCode (launch flags) | Exact native sandbox/approval pair for the selected mode; connected tools and web search disabled; inherited MCP registrations cleared; repository execpolicy rules and user configuration ignored; provider keys excluded from model-run commands; provider-process credential scoping (§3). |
| Codex | Every execution decision inside its native sandbox and every native approval prompt. KalCode records status but does not answer the prompt. |

Gaps (honest): Codex has **no deny-rule flag** KalCode can pass per turn, so there is no Codex
equivalent of Claude Code's deny floor: reads of credential files the selected sandbox allows
(`.env` in the workspace, `~/.ssh`) are **not** blocked by KalCode. In Bypass,
`danger-full-access` also permits native shell network access, so remote actions are governed by
Codex's selected native mode rather than by a KalCode rule. Codex permission
profiles support `deny` read rules [18], but they don't compose with `--sandbox` (a
`sandbox_mode` anywhere in the loaded config silently wins), so using them safely needs a verified
precedence and is planned with the app-server adapter (§8.8). `--ignore-rules` also drops the
user's own `forbidden` rules. KalCode's permission engine does not judge Codex tool calls per
action (`hostApprovals: false`). Approve and Custom may require a native provider decision that a
headless process cannot display through KalCode; interactive panes are the normal surface for
that prompt.

### Gemini CLI (headless threads, PROVIDERS-2)

Every turn passes `--output-format stream-json` and the prompt on stdin, then:

| KalCode | Gemini CLI flags | Fidelity | Notes |
| --- | --- | --- | --- |
| Plan | `--approval-mode plan` | Stricter | Gemini CLI's read-only plan mode. |
| Approve | `--approval-mode default` | Stricter | Tool calls that need confirmation can't be answered headless, so they don't run. |
| Auto | `--approval-mode default` | Stricter | Runs like Approve. |
| Bypass | `--approval-mode auto_edit` | Stricter | File edits approved automatically; other tools that need confirmation don't run. |
| Custom | as Approve | Stricter | Approve baseline. |

Never used: `yolo` / `--yolo` (deprecated), `--allowed-tools` (deprecated for the Policy
Engine), `--skip-trust` (would trust the workspace and load its settings),
`--include-directories`, `--experimental-acp` [10]. Resume takes only a full session UUID (never
`latest` or an index, which could pick another session).

Gaps (honest): no deny-rule flag KalCode can pass per session, so reads of credential files are
not blocked by KalCode; settings of a folder the user trusted in Gemini CLI (its
`.gemini/settings.json`: tools, MCP servers, hooks) still apply; Gemini CLI is not installed on
the verification machine, so flag acceptance and event shapes are verified against the published
type definitions and fixtures only (smoke script written, not run).

## 6. Detection

`crates/providers/src/detect.rs`. Read-only: never installs, updates, signs in or sends a prompt.

1. **Resolve** the executable on `PATH`, then in documented install folders. Only absolute
   folders are searched: empty and relative `PATH` entries are skipped. On Windows only `PATHEXT`
   kinds the OS can start directly (`.exe`, `.com`, `.cmd`, `.bat`) are tried, and a native
   executable anywhere on the search path (the native installer's `claude.exe`) wins over a
   `.cmd`/`.bat` script launcher (an npm shim).

   | Provider | Documented folders checked after `PATH` |
   | --- | --- |
   | Claude Code | `~/.local/bin` (native launcher), `/opt/homebrew/bin`, `/usr/local/bin`, `%APPDATA%\npm`, `%LOCALAPPDATA%\Microsoft\WinGet\Links` |
   | Codex | `/opt/homebrew/bin`, `/usr/local/bin`, `%APPDATA%\npm` |
   | Gemini CLI | `/opt/homebrew/bin`, `/usr/local/bin`, `%APPDATA%\npm` |

2. **Version:** run only `<exe> --version` (15 s timeout) and compare with the adapter's minimum.
3. **Sign-in:** run the documented status command, if any (15 s timeout), and read only its
   documented signal. Verified 2026-09-25 against the real install on the verification machine
   (`real_codex_detection`: codex-cli 0.155.1 through its npm shim, signed in). `claude auth status` stdout is discarded unread (it contains the account
   email and organization); only the exit code counts (0 / 1; anything else is unknown). For
   `codex login status` only a leading `Logged in` with exit 0, or `Not logged in`, counts;
   anything else is unknown. Gemini CLI is always unknown.

Probes run with the sanitized provider environment, a neutral working directory (the temp folder,
never a project), 16 KiB output caps and tree kill on timeout.

| State | Meaning |
| --- | --- |
| `installed` | Found, version at or above the minimum (or no minimum yet). |
| `not_installed` | Not found on `PATH` or in the documented folders. |
| `outdated` | Found below the minimum (Claude Code 2.1.259, Codex 0.155.1); sessions refuse to start. |
| `error` | Found but the version check failed: `version_timeout`, `version_spawn_failed`, `version_failed`, `version_exit_status`, `version_unrecognized`, or `detection_crashed`. |

Sign-in is `authenticated`, `not_authenticated` or `unknown`.

**Shown** (`ProviderStatus`): name, state, path with the home folder as `~`, version, minimum
version, sign-in state, user-safe message, checked-at, the auth-check command, sign-in command,
install command, docs link, capabilities and permission mappings, adapter state, model source.
**Never read or shown:** account email, organization, plan or tokens.

`ProviderRegistry` detects every provider in parallel, each on its own thread, so a hanging or
crashing CLI affects only its row. Detections are serialized and cached. KalCode shows the
documented install command but never runs an installer.

## 7. Process supervision

`crates/providers/src/process.rs`. Every provider process:

| Rule | Detail |
| --- | --- |
| argv only | `Command` with an argument vector, never a shell string. Model names and session ids are validated before they reach argv (no leading `-`, restricted charset; ids must be UUIDs). |
| Launch (Windows shims) | `crates/providers/src/launch.rs`. A `.cmd`/`.bat` shim is read (at most 16 KiB, never executed) and its single `%dp0%` target resolved to an absolute file: a native target (current npm Claude Code: `bin\claude.exe`) starts directly; a script target starts as `<node.exe> <script>`, with `node.exe` from the shim's folder or an absolute `PATH` entry (never `node.cmd`). `cmd.exe` is used only for a shim KalCode can't read, with the hardened environment (§3) and the system `cmd.exe` with `/d`. Starting the shim in an empty KalCode folder instead is not possible: Claude Code has no flag that sets its project folder apart from its working directory. |
| Sanitized environment | `env_clear()`, then the per-provider allow-list (§3). |
| Bounded stdout | Read line by line on its own thread; lines over 8 MiB are discarded without buffering. |
| Redacted stderr | Last 16 KiB kept on its own thread, passed through the log redactor, and only logged. |
| Timeouts | Probes 15 s; interrupt acknowledgement 5 s; terminate grace 3 s, then kill. |
| Tree kill | Windows: `taskkill /T /F` by pid (argv). Unix: own process group, `kill -KILL -<pgid>`. Dropping a `SupervisedChild` kills its tree. |
| Isolation | Separate threads and channels per child; one crash, hang or flood cannot block another provider or KalCode. |
| No console window | `CREATE_NO_WINDOW` on Windows. |

## 8. Claude Code adapter

`crates/providers/src/claude/`. One supervised `claude -p` process per session, speaking
stream-JSON on stdin and stdout.

### 8.1 Starting a session

`start_session` re-runs detection and refuses to start when Claude Code is not installed,
outdated, in error, or signed out, or when `secretRef` is set. The working directory must be an
existing absolute folder resolved natively. argv:

```text
claude -p --input-format stream-json --output-format stream-json --verbose
       --include-partial-messages --permission-prompts none --strict-mcp-config
       <permission flags (§5)> --disallowedTools <KalCode deny rules (§5)>
       [--model <alias>] (--session-id <new uuid> | --resume <uuid>)
```

Input is one SDKUserMessage per line:
`{"type":"user","message":{"role":"user","content":"…"},"parent_tool_use_id":null}` (empty
messages rejected, at most 1 MiB).

### 8.2 Stream parsing and normalization

`stream.rs` follows the Agent SDK message types [3]. It is lenient about additions (unknown
fields and types are ignored) and strict about shape (a known type missing a required field is a
typed parse error). `normalize.rs` maps lines to `AgentEvent`s. Status comes only from
structured events, never from model prose.

| Claude Code line | `AgentEvent`s |
| --- | --- |
| `system/init` | `SessionStarted { providerSessionId, model }`, `Status(active)`; records `capabilities` |
| `system/api_retry` | `Status(recovering, "Retrying after … (attempt n of m)")` |
| `system/permission_denied` | `Error(permission_denied, recoverable)`; that tool's result becomes `ok: false` |
| `stream_event` `message_start` / `text_delta` | `Status(thinking)` / `MessageDelta` |
| `assistant` | `Error(api_<error>)` if the API call failed; `MessageCompleted` (text blocks); per `tool_use`: `ToolRequested` + `Status(editing \| running_command \| running_tool, summary)` |
| `user` `tool_result` | `ToolCompleted { ok }`; `FileChanged(modified)` after a successful Edit/Write/NotebookEdit; `Status(thinking)` |
| `result` | `Usage` (tokens, cost as reported by Claude Code), `Error(turn_<subtype>)` unless `success`, `TurnCompleted { ok }`, `Status(idle)` |
| other `system` subtypes, unknown types | ignored |
| subagent traffic (`parent_tool_use_id` set) | folded into the parent tool call, not surfaced |
| `control_response` / `control_request` | handled by the session (§8.4, §8.5) |

### 8.3 Tool calls → `NormalizedAction`

`actions.rs` classifies each tool call so one policy engine (Z4) can judge every provider. In Z2
the classification drives status and summaries; `actions::normalize` builds the full
`NormalizedAction` for Z4. Summaries are single-line, at most 160 characters.

| Claude Code tool | `ActionKind` |
| --- | --- |
| `Read`; `Glob`, `Grep` | `FileRead` (path, or the working directory) |
| `Edit`, `Write`, `NotebookEdit` | `FileWrite` |
| `Bash`, `PowerShell` | simple `git <sub>` → `Git { operation, remote }`; simple `npm\|pnpm\|yarn\|bun install\|i\|add`, `pip\|pip3\|cargo install\|add` → `PackageInstall`; anything else, including any command with a pipe, `;`, `&`, a redirection, a backtick, `$` or a newline → `Command { command, argv: [], cwd }` (never split or expanded) |
| `WebFetch`; `WebSearch` | `Network { host, url }`; `Network { host: "web search" }` |
| anything else | `Tool { tool, inputSummary }` (input key names only), evaluated conservatively |

### 8.4 Interrupt, terminate, resume

- **Interrupt.** Sent only when `system/init` advertised `interrupt_receipt_v1`:
  `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"interrupt"}}`.
  A matching non-error `control_response` within 5 s gives `Status(interrupted)` and the session
  stays open. Otherwise (no capability, no reply, error reply) KalCode emits
  `Error(interrupt_unconfirmed, recoverable)` and terminates the process: stricter, and resumable.
- **Terminate.** Close stdin, wait 3 s, kill the tree, wait up to 5 s. A deliberate stop ends
  `completed` with no crash error. Dropping a session stops it on a background thread.
- **Resume.** `SessionConfig.resumeSessionId` → `--resume <uuid>`. New sessions get a KalCode
  UUID via `--session-id`, so `provider_session_id()` is known before `system/init` confirms it.

### 8.5 Failure modes

| Failure | Behaviour |
| --- | --- |
| Malformed line (not JSON, not an object, no `type`, missing required field) | Skipped. The first four each emit `Error(protocol_error)`, the fifth a final notice, then silence. The line is never echoed (it may hold project content). |
| Oversized line (> 8 MiB) | Dropped without buffering; `Error(protocol_error)`; the next line parses normally. |
| Unexpected host request (`control_request` from Claude Code) | **Fails closed:** `Error(unexpected_host_request, not recoverable)`, the process is killed, nothing is approved. `respond_to_approval` returns `Unsupported` in Z2. |
| Crash (non-zero exit or signal, not requested) | `Error(process_exited, "…exit code N", recoverable)`, `Status(failed)`, `Exited { exitCode }`. The redacted stderr tail is logged only, never put in an event or the UI. |
| API error on an assistant message | `Error(api_<code>)` with user-safe copy; recoverable for rate limit, overload, server error, max output tokens. |
| Turn error result | `Error(turn_error_max_turns \| turn_error_during_execution \| turn_error_max_budget_usd …)`. |
| stdout closes but the process lingers | Wait 10 s, then kill the tree. |
| Spawn or stdin write failure | `ProviderError::Start` / `Io` with generic copy; details logged. |

### 8.6 Codex adapter (PROVIDERS-2)

`crates/providers/src/codex/`, on the shared turn engine `crates/providers/src/turns.rs`. A
KalCode session is a sequence of supervised `codex exec` processes sharing Codex's thread id:
the first turn starts a thread, later turns run `exec … resume <thread id> -`. This is how the
official Codex TypeScript SDK drives `codex exec` [14]. `start_session` re-runs detection and
refuses not installed, outdated (< 0.155.1), detection error, signed out, or `secretRef`; the
argv is validated before anything runs. Launch: Z2's rules (argv only, sanitized and hardened
environment, the npm `codex.cmd` shim resolved to `<absolute node.exe> …\@openai\codex\bin\codex.js`,
never `cmd.exe` picking a program from the workspace; `turns_launch_hardening`).

| Codex line [13] | `AgentEvent`s |
| --- | --- |
| `thread.started {thread_id}` | `SessionStarted` (kept for resume only if it is a UUID) |
| `turn.started` | `Status(thinking)` |
| `item.started` `command_execution` / `mcp_tool_call` / `web_search` | `ToolRequested`, `ToolStarted`, `Status(running_command \| running_tool, summary)` |
| `item.completed` `agent_message` | `MessageCompleted` |
| `item.completed` tool items | `ToolCompleted { ok }` (`completed`, and exit code 0 for commands) |
| `item.completed` `file_change` | `ToolRequested`, `Status(editing)`, `ToolCompleted`, `FileChanged` per path when it succeeded (`add` → created, `delete` → deleted, `update` → modified) |
| `item.completed` `error` | `Error(codex_item_error, recoverable)` |
| `turn.completed {usage}` | `Usage` (input/output tokens; Codex reports no cost), `TurnCompleted { ok: true }`, `Status(idle)` |
| `turn.failed {error}` | `Error(turn_failed, recoverable)`, `TurnCompleted { ok: false }` |
| `error {message}` | `Error(stream_error, recoverable)` (reconnect notices included) |
| reasoning, `todo_list`, `item.updated`, unknown types | ignored |

Tool calls become `NormalizedAction`s with the same classification as Claude Code
(`codex::normalize_item`: commands → `Command`/`Git`/`PackageInstall`, file changes →
`FileWrite`, web search → `Network`, MCP → `Tool`). Malformed lines: `protocol_error` (first four,
then one final notice), never echoed; oversized lines dropped. Provider error text is shown
single-line, redacted, at most 200 characters; status never comes from it.

**Interrupt** kills the running turn's process tree and reports `Status(interrupted)`; the
session stays open and the next message resumes the thread. A second message while a turn runs
is refused (`Io`), never queued into Codex. A turn that reported its end may still be exiting:
the next message waits for it (at most 10 s, then kills it). **Terminate** kills any running
turn and reports `Exited`. A turn process that exits non-zero without its own end marker becomes
`Error(process_exited, recoverable)` and a failed turn; the redacted stderr tail is only logged.

### 8.7 Gemini CLI adapter (PROVIDERS-2)

`crates/providers/src/gemini/`, the same turn engine. Turns run
`gemini --output-format stream-json --approval-mode <mode> [--model] [--resume <uuid>]` with the
prompt on stdin; the session id comes from `init`. Mapping [15]: `init` → `SessionStarted`
(with the model), assistant `message` deltas → `MessageDelta` (one message id until the next tool
call or the result, then `MessageCompleted`), `tool_use` → `ToolRequested`/`ToolStarted`/status by
tool (`run_shell_command` → running command, `write_file`/`replace` → editing, others → running
tool), `tool_result` → `ToolCompleted`, plus `FileChanged` after a successful write, `error` →
`Error(provider_warning | provider_error, recoverable)`, `result` → `Usage`, `TurnCompleted`,
and on error `rate_limited` (`RetryableQuotaError`), `quota_exhausted` (`TerminalQuotaError`) or
`turn_error` — from the structured `result.error.type` only [17]. Sign-in is always **unknown**
(no documented side-effect-free status command), which does not stop threads.

### 8.8 `codex app-server` — the long-term Codex surface (plan)

`codex app-server` speaks JSON-RPC 2.0 over stdio with `thread/start`, `thread/resume`,
`turn/start`, `turn/interrupt`, `model/list` and **server-initiated approval requests** the host
accepts or declines [8]. That is the surface that would let KalCode's permission engine judge
each Codex command and patch (`hostApprovals: true`), list models, and interrupt without killing
a process. It is **not** implemented yet because the installed CLI labels it `[experimental]`
in its own `--help` (0.155.1). Plan, when it is marked stable: an `app-server` session per
thread behind the same `AgentProvider` contract; approvals → `ApprovalRequired` with actions
from `codex::normalize_item`; a fake app-server in `kalcode-fake-provider` driven by schemas
generated by `codex app-server generate-json-schema` (a local command, run with the owner's
agreement); then permission profiles with `deny` read rules as Codex's deny floor once their
precedence against user config is verified.

### 8.9 Provider Health (PH, PROVIDERS-2)

`crates/providers/src/health/` (`HealthMonitor`, `observe::ObservedProvider`), IPC in
`apps/desktop/src-tauri/src/provider_health_commands.rs`, contract types in
`crates/contracts/src/health.rs`. See `docs/PROVIDER_HEALTH.md` for the model and
`docs/campaigns/PROVIDERS-2.md` for acceptance. In short: detection feeds installed / version vs
minimum / sign-in as reported; every thread session (all three adapters are wrapped) feeds
active sessions, time to first output (p50/p95 over 15 minutes), failures (60 minutes), and rate
limits only from the structured shapes in §4. Transitions emit `provider.health_changed` /
`provider.capacity_changed`. No polling: a read-only re-detection runs only after a session
couldn't start or the provider reported a sign-in failure (at most once a minute per provider,
backing off to 30 minutes). Recording an observation never delays a thread event.

## 9. Testing

- **Fixtures** (`crates/providers/tests/fixtures/claude/`) are hand-written from the documented
  message shapes, not captured traffic; no AI quota is used.
- **Fake provider** (`kalcode-fake-provider`, test support only, not bundled) is copied under a
  provider's executable name into a temp folder that becomes the only `PATH` entry. A JSON config
  selects its behaviour (version text and exit, auth exit, `codex login status` line, delays,
  crash, hang with a grandchild, host request). It replays fixtures and records its argv and the
  *names* of its environment variables so tests can assert on both.
- **Pipeline tests** (`crates/providers/tests/pipeline.rs`) cover detection states, timeouts,
  registry isolation, text and tool turns, malformed and oversized lines, interrupt with and
  without confirmation, crash reporting (no credential-shaped stderr in events), fail-closed host
  requests, terminate and drop killing grandchildren, cross-session isolation, resume and Plan
  argv, and refusal to start when unusable.
- **Unit tests** cover the permission invariants, env sanitization, bounded line reading, stderr
  redaction, parsing and normalization.
- **Real-provider tests are `#[ignore]`d.** `real_claude_detection` runs only `--version` and
  `auth status`. `real_claude_session_smoke` consumes AI quota: it additionally needs
  `KALCODE_REAL_PROVIDER_SMOKE=1` and the owner's explicit approval.
- **Provider panes (Z7-W4).** The fake provider has an interactive mode (started with
  `--settings`): a minimal TUI that fires the hooks in KalCode's settings file with the documented
  payload shapes and honours their exit codes and decisions; with `hook` as its first argument it
  stands in for `kalcode-hook`. `tests/interactive.rs` (status mapping, prose ignored, engine
  round trip, hand-over to the provider prompt, KalCode unreachable, argv/env/settings, hooks
  disabled, stop and revoke, headless/interactive routing) and `tests/interactive_runtime.rs`
  (the Z3 runtime and Z4 engine end to end) run it in a real PTY. `tests/interactive_real.rs`
  (`real_claude_interactive_smoke`) starts the real CLI and consumes AI quota; run it only through
  `tooling/smoke/claude-interactive-smoke.ps1` with the owner's approval.
- **Codex and Gemini CLI (PROVIDERS-2).** The fake provider also answers as `codex` (`exec
  --json`, `login status`, an interactive mode that runs the `notify` program and emits OSC 9 on
  `approve`) and as `gemini` (`--output-format stream-json`, an interactive mode), replaying the
  fixtures in `tests/fixtures/{codex,gemini}/` (hand-written from the official type
  definitions). `tests/turns_pipeline.rs` (detection, text and tool turns, resume, stdin-only
  prompts, env scoping, never-broader argv per mode, failures, crashes without stderr leaks,
  interrupt killing the tree, malformed output, quota errors, health through real sessions),
  `tests/turns_runtime.rs` (the Z3 runtime and Z4 engine end to end), `tests/interactive_cli.rs`
  (Codex and Gemini CLI panes in a real PTY, notify through the real bridge, OSC 9, process-only
  status, the router) and `tests/turns_launch_hardening.rs` (npm shims; planted `node.exe`,
  `node.cmd`, `codex.cmd`, `gemini.cmd`, `cmd.exe` never run). `tests/turns_real.rs` and
  `tests/interactive_cli_real.rs` are ignored: detection runs `--version` and `codex login status`
  only; the session smokes consume AI quota and run only through
  `tooling/smoke/{codex-headless,gemini-headless,codex-interactive}-smoke.ps1` with the owner's
  approval.

## 10. Open verification items

| Item | Status and mitigation |
| --- | --- |
| Interrupt request field name | The `interrupt` control request is documented by name, but its discriminator field (`subtype`) is inferred. Sent only when `interrupt_receipt_v1` is advertised, with a 5 s wait and termination as fallback. |
| `codex login status` output | Exit codes and wording are undocumented. Observed: `Logged in using ChatGPT`. Anything unexpected reads as unknown, never as signed in. |
| Gemini CLI | Not installed on the verification machine; detection, the adapter and panes are tested only against the fake provider and the published type definitions. Smoke script written (`gemini-headless-smoke.ps1`), not run. |
| Claude Code deny rules and command forms | Bash/PowerShell deny rules match the command text, not the program (§5). A full path, `sh -c` or quoting escapes them; the Claude Code mode then refuses the command unless the user's own allow rules cover it. Closed by the Z7 hook bridge. |
| Claude Code plan mode and `useAutoModeDuringPlan` | Plan mode may run classifier-approved commands when auto mode is available. Not relied on: Plan also passes `--restricted`, which removes command-running tools. |
| Codex / Gemini CLI adapters | Built (PROVIDERS-2). Codex native mode flags verified against installed `codex`, `codex exec`, `codex resume`, and `codex exec resume` help 0.157.0 plus the official configuration/CLI references; no provider inference was used. The real JSONL stream and execution behavior are confirmed only by the owner-approved smoke (`codex-headless-smoke.ps1`, written, not run). |
| Codex deny floor | None per turn (§5 gaps). Permission-profile `deny` rules exist but don't compose with `--sandbox`; planned with app-server. |
| Claude Code panes: `--settings` hooks with `--setting-sources user`, exec-form `args`, hook environment inheritance, UserPromptSubmit field name | Documented (hooks, settings and permissions references); exercised against the fake provider. Confirmed only by the owner-approved smoke run (`tooling/smoke/claude-interactive-smoke.ps1`, not run yet). |
| Codex panes | Hardened candidate: authenticated notify only; OSC 9 cannot change canonical status. Exact native Plan/Approve/Auto/Bypass/Custom mappings are tested, including resume; managed-profile isolation remains a release blocker. |

## 11. Sources

1. Claude Code headless mode — https://code.claude.com/docs/en/headless
2. Claude Code CLI reference — https://code.claude.com/docs/en/cli-reference
3. Agent SDK message types — https://code.claude.com/docs/en/agent-sdk/typescript#message-types
4. Claude Code model configuration — https://code.claude.com/docs/en/model-config
5. Codex non-interactive mode — https://learn.chatgpt.com/docs/non-interactive-mode
6. Claude Code permission modes — https://code.claude.com/docs/en/permission-modes
7. Codex approvals and security — https://learn.chatgpt.com/codex/agent-approvals-security
8. Codex app-server — https://learn.chatgpt.com/codex/app-server
9. Gemini CLI headless mode — https://geminicli.com/docs/cli/headless/
10. Gemini CLI reference — https://geminicli.com/docs/cli/cli-reference/
11. Codex authentication — https://learn.chatgpt.com/codex/auth
12. Claude Code permissions (rule syntax, Bash rule limits, settings precedence, hooks) —
    https://code.claude.com/docs/en/permissions
13. Codex exec event and item types (`ThreadEvent`, `ThreadItem`, "based on
    codex-rs/exec/src/exec_events.rs") —
    https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts,
    https://github.com/openai/codex/blob/main/sdk/typescript/src/items.ts
14. Codex TypeScript SDK's `codex exec` driver (argv, `--config approval_policy`, prompt on
    stdin, `resume <thread id>`, cancellation) —
    https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts,
    https://github.com/openai/codex/blob/main/sdk/typescript/src/threadOptions.ts
15. Gemini CLI stream-JSON event types —
    https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/output/types.ts
16. Gemini CLI session management (`--resume <uuid>`) —
    https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md
17. Gemini CLI quota errors and error types in stream-JSON results —
    https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/googleQuotaErrors.ts,
    https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/utils/errors.ts
18. Codex configuration reference and permission profiles (`approval_policy`, `web_search`,
    `shell_environment_policy`, `sandbox_workspace_write.network_access`, `notify`,
    `tui.notifications`, `permissions.<name>.filesystem` `deny`) —
    https://learn.chatgpt.com/docs/config-file/config-reference, https://learn.chatgpt.com/codex/permissions

Install: Claude Code https://code.claude.com/docs/en/setup (`curl -fsSL
https://claude.ai/install.sh | bash`, `irm https://claude.ai/install.ps1 | iex`, Homebrew, WinGet,
npm `@anthropic-ai/claude-code`) · Codex https://github.com/openai/codex (`npm install -g
@openai/codex`, `brew install --cask codex`) · Gemini CLI `npm install -g @google/gemini-cli`,
`brew install gemini-cli`.
