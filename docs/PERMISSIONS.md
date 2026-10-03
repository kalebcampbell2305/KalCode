# KalCode Permission Architecture

Status: implemented in campaign Z4 (`crates/permissions`, schema v4, migration `0004`) · Contract types:
`crates/contracts/src/permissions.rs` (TypeScript: `packages/protocol/src/generated`)

Permissions are security infrastructure. They are designed to govern every provider, agent,
KalVoice action, automation and plugin. **KalVoice is not above the permission model.** Every
permission mode — Plan, Approve, Auto, Bypass and Custom — is available on every plan, including
Free.

> **What is enforced today (0.1.1).** The engine judges an action only when a provider hands it
> to KalCode (`ApprovalRequired`). Claude Code headless threads don't (`hostApprovals: false`),
> so for them the rules in §3–§5 — Custom rules, standing grants, "remote-consequential always
> asks" — are **not** applied per tool call. KalCode enforces for Claude Code through launch
> flags instead: a Claude Code mode no broader than the KalCode mode, prompts denied, and
> KalCode deny rules for remote actions and credential files (and, in Plan/Approve/Custom, edit and
> web tools) that the user's own Claude Code settings can't override. Other commands follow
> Claude Code's own rules, including the user's own Claude Code user settings. Details and
> limits: §8 and `docs/PROVIDERS.md` §5. Provider panes observe hook events but keep provider-native
> prompts and Auto classification authoritative (`docs/PROVIDER_PANES.md`).

## 1. Model

```text
NormalizedAction ─▶ classify ───────────────▶ evaluate policy ─────────────▶ PolicyDecision
 (provider adapter)  scopes, opaque?,          mode baseline, profile rules,   ├─ allow → run it
                     fingerprint, subjects     user rules, standing grants     ├─ ask   → open_request → approval.requested
                     (paths, hosts, command)                                    └─ deny  → provider receives the denial
```

The engine is **deterministic**: the same action, mode, rules and grants always produce the same
decision (path containment reads the filesystem, so "same" includes the same links on disk). It
**fails closed**: anything it cannot interpret is either outside the workspace or *opaque*.

### Scopes

`filesystem.read`, `filesystem.write`, `filesystem.outside_workspace`, `terminal.read_only`,
`terminal.execute`, `package.install`, `git.read`, `git.commit`, `git.push`, `network.docs`,
`network.other`, `browser.navigate`, `browser.interact`, `credentials.access`, `messaging.send`,
`deploy.production`, `cloud.modify`, `billing.spend`, `destructive` (plugin scopes arrive with Z11).

- **Remote-consequential**: `git.push`, `messaging.send`, `deploy.production`, `cloud.modify`,
  `billing.spend` — never allowed by a mode, including Bypass.
- **Always ask** (Auto) and **once-only** (no standing grants): remote-consequential plus
  `destructive`, `credentials.access`, `filesystem.outside_workspace`.

## 2. Classification (`crates/permissions/src/{paths,command,network,classify}.rs`)

| Action | Scopes | Notes |
| --- | --- | --- |
| `file_read` / `file_write` / `file_delete` | `filesystem.read` / `filesystem.write` (+ `filesystem.outside_workspace`, `credentials.access`, `network.other` for UNC) | Deleting a folder, the root or anything in `.git` adds `destructive`; writing inside `.git/` adds `terminal.execute` and is *sensitive* (hooks/config run code). |
| `command` | per program (below); the display text **and** `argv` are both classified and combined | cwd outside the workspace adds `filesystem.outside_workspace`. |
| `package_install` | `package.install` (+ outside for system managers such as brew/apt/winget/choco) | URL/git sources add `network.other`. |
| `git` | status/diff/log → `git.read`; commit/checkout → `git.commit` + `terminal.execute` (hooks); branch → `git.commit`; push → `git.push` + `terminal.execute`; pull → `git.commit` + `network.other`; reset → `git.commit` + `destructive`; other → opaque | |
| `network` | `network.docs` for documentation hosts (`network.rs::DOCS_HOSTS`, label-boundary match), otherwise `network.other` | A `url` whose host differs from `host`, or an unparseable host, is opaque. `https://docs.rs@evil.example` is `evil.example`. |
| `browser` | navigate/read verbs → `browser.navigate`, everything else → `browser.interact`; external hosts add network scopes | uploads are opaque. |
| `deploy` | `deploy.production` (every target) | |
| `tool` (unrecognized) | `terminal.execute`, **opaque** | |

**Workspace containment.** The root is canonicalized; a path is inside only if *both* the Win32
reading (`..` applied textually, then links resolved) and the POSIX reading (links resolved
component by component, `..` to the real parent) land under the root, compared by path components.
Outside or opaque: `..` escapes, absolute paths elsewhere, sibling prefixes (`C:\ws2` vs `C:\ws`),
symlinks and junctions leading out, dangling links, UNC (`\\server\share`, `//server`), device
and object namespaces (`\\.\`, `\\?\GLOBALROOT`, `\??\`), alternate data streams (`a.txt:x`),
reserved device names (`CON`, `NUL`, `COM1`…), names ending in a dot or space (Windows),
drive-relative paths (`C:foo`), driveless rooted paths on Windows, unverifiable 8.3 short names,
`~`, `$VAR`, `%VAR%`, control and invisible Unicode characters, and any path when the workspace
root is unknown. Verbatim roots (`\\?\C:\…`) are joined in their plain form because Rust's
`PathBuf::push` resolves `..` textually on verbatim paths.

**Commands.** KalCode does not know which shell will run the text, so every command text is
read **five ways** and every reading is classified; the scopes of all readings are added together
and any reading that can't be interpreted makes the command opaque, so the most
authority-requiring interpretation always wins (fail closed; `command/dialects.rs`):

* **POSIX sh/bash** — `'…'` is literal; `"…"` honours `\"`, `$…` and backticks; `\` escapes any
  character; `$'…'` ANSI-C strings are decoded (`$'\x72\x6d'` is `rm`); `#` at a word start is a
  comment; `^` and `%` are ordinary characters; brace expansion (`{rm,-rf,x}`) marks the word as
  an expansion; `${X:-$(cmd)}` classifies `cmd`.
* **cmd.exe** — `^` escapes outside double quotes (literal inside them); `'`, `` ` ``, `$` and
  `\` are ordinary characters, so `echo 'a & rd /s /q x'` runs `rd`; `&`, `&&`, `||`, `|`,
  newlines and parentheses separate; `,` and `;` separate arguments; `@` before a command is
  dropped and a command name ends at `/` (`@rd/s/q x` is `rd /s /q x`, `/s/q` is two switches);
  `%VAR%` is expanded **before** the line is parsed (its value can add separators), so any
  `%VAR%` makes the command opaque; `!VAR!` (delayed expansion) as the program is opaque.
* **PowerShell** — smart quotes (`‘ ’ ‚ ‛ “ ” „`) are quotes and en dash, em dash, horizontal bar
  (and figure dash) are dashes (`–Recurse` is `-Recurse`); `` ` `` escapes; `''`/`""` are
  escaped quotes; `;`, `|`, `&&`, `||`, newlines separate; `&` at a command start is the call
  operator (`& 'Remove-Item' …`); `{…}` script blocks and `(…)` groups are classified as commands
  even when glued to a cmdlet (`ForEach-Object{Remove-Item $_}`, `@{e={…}}`); `#` and
  `<# … #>` are comments; `--%` (stop parsing) and `` `u{…} `` escapes make it opaque.
* The **union** reading (all three syntaxes at once: `;`, `&&`, `||`, `|`, `&`, newlines, `()`
  and `{}` split; quotes, `\` and `^` are removed before the program is identified, so `r"m"`,
  `r^m` and `\rm` are `rm`; `#` is not a comment), with POSIX backslash escapes and — when the
  text contains a backslash — again with literal backslashes.

A command is eligible for prefix rules only when every reading agrees it is the same single
simple command. Paths are resolved once per classification and reused by every reading.
Wrappers are unwrapped (`sudo`, `env` incl. `--chdir=DIR`, `nice`, `timeout`, `xargs`, `start`,
`Start-Process`, `wsl`, `busybox`), shells are recursed into (`bash -c`, `cmd /c`, `powershell
-Command`, positional PowerShell scripts, `-EncodedCommand` in any abbreviation, decoded from
UTF-16LE base64), to a depth of 4. Programs are classified by name: read-only tools
(`terminal.read_only`), file writers, destructive tools (`rm -r`, `del /s`, `rd /s`,
`Remove-Item -Recurse`, `format`, `mkfs`, `dd of=`, `diskpart`, `shred`, recursive `chmod`,
`robocopy /MIR`, `rsync --delete`/`--del`, `git reset --hard`, `git clean -f`,
`git push --force` …), package managers, git (every subcommand), network clients (with
data-sending detection, uploaded files — `-d @f`, `-F x=@f`, `-T f`, `--post-file`, `-InFile` —
containment- and credential-checked, and messaging/billing hosts), SSH-like tools
(`cloud.modify`), cloud/deploy CLIs (vercel, wrangler, aws, gcloud, az, kubectl, terraform, gh,
docker, stripe …), and credential tools. Unknown programs are `terminal.execute`; their
path-looking arguments are containment-checked.

**Abbreviations.** GNU long options may be abbreviated (`rm --rec`, `git push --forc`,
`git reset --har`, `wget --post-f`), and PowerShell accepts any parameter prefix and `:value`
(`-rec`, `-Recurse:$true`, `-Me Post`, `-InF`, `-Ur`): every check that *adds* authority
accepts any prefix (an ambiguous prefix is refused by the program, so this only ever adds
authority); checks that would *remove* authority (`--dry-run`, `--staged`) stay exact.

**Execution options on read-only programs.** `git grep -O`/`--open-files-in-pager`,
`--ext-diff`, `--upload-pack`/`--receive-pack`/`--exec` (fetch, pull, ls-remote, clone `-u`,
archive, push), `rebase -x`, `difftool -x`/`--extcmd`, `--tool`, `send-email --*-cmd`,
`filter-branch` filters and `git help -w` make Git run a program: `terminal.execute` and opaque.
`--output[=]FILE` on a diff/log command is a file write; a write into `.git/hooks` or
`.git/config` (by any command) is opaque. Likewise `man -P/-H/--pager/--html`, `bat --pager`,
`sort --compress-program`, `fc` (re-runs history in bash), `watchman … trigger` (opaque) and
`less -o`/`tree -o` (file writes).

**Secrets in the environment.** Printing the environment or shell variables is a sensitive read
(`credentials.access`, which asks in every mode): `env`, `printenv`, `set` (and cmd.exe's
`set PREFIX`), `export -p`, `declare -p`, `compgen -v`, BSD `ps e`, `Get-ChildItem env:` (and
`gci`/`dir`/`ls`), `Get-Item env:X`, `Get-Variable`, `[Environment]::GetEnvironmentVariable`,
`Win32_Environment`, `/proc/*/environ`, and any expansion of a variable whose name suggests a
secret (`KEY`, `TOKEN`, `SECRET`, `PASS`, `PWD`, `CRED`, `AUTH`, `SESSION`, `COOKIE`, `PRIVATE`,
`API`, …) in any syntax: `$X`, `${X}`, `$env:X`, `${env:X}`, `%X%`, `!X!`.

**Wildcards.** A wildcard argument that can expand to a credential file is `credentials.access`:
statically, when the pattern (case-insensitive, POSIX dot rule) can match a credential name
(`cat .en*`, `.en?`, `.[e]nv`, `type *.pem`, `cat id_*`, `~/.ss*/id_rsa`, `**/…`); and by listing
the folder (bounded to 4 096 entries), because PowerShell's and cmd.exe's `*` also match dot
files (`type *.md` next to a `.env.md`). Patterns made only of wildcards (`*`, `*.*`) are judged
by the folder listing alone. Programs that only list names (`ls`, `dir`, `Get-ChildItem`, `tree`,
`stat` …) are exempt. The credential name list also covers `.vault-token`, `.s3cfg`, `.boto`,
`.dockercfg`, `.my.cnf`, `.terraformrc`, `credentials.tfrc.json`, `kubeconfig`, `auth.json`,
`*_sk` SSH keys, `*.p8`, `*.keychain-db`, `environ`, and the `gcloud`, `.oci` and `.terraform.d`
folders.

**Opaque** means KalCode could not see everything the command will do: command/process
substitution, backticks, `eval`/`iex`/`source`, aliases and functions, `find -exec`, `xargs`,
inline interpreter code (`python -c`, `node -e`), encoded PowerShell, piping into a shell,
dangerous environment variables (`PATH`, `LD_PRELOAD`, `GIT_*`, `NODE_OPTIONS`…), `git -c`,
`git config` writes, unknown git subcommands (possible aliases), Git execution options (above),
writes into `.git/hooks`/`.git/config`, LOLBins (`mshta`, `rundll32`, `certutil -urlcache`),
cmd.exe `%VAR%` expansion and delayed-expansion programs, brace-expanded programs, PowerShell's
stop-parsing token, unterminated quotes, heredocs, control/invisible characters, text longer
than 16 KiB, or nesting deeper than 4. Opaque actions are **never allowed without an explicit
approval in any mode, including Bypass**, never match allow rules or grants, can only be approved
once, and in a Custom profile every `deny`/`never` rule applies to them (they can't be ruled out).

Scripts a command runs (`npm test`, `make`, `./build.sh`) are classified as `terminal.execute`;
KalCode does not look inside them.

## 3. Modes and profiles

Precedence per scope (most restrictive result across scopes wins):

1. Custom profile `never` rule → **Deny, not approvable**.
2. Custom profile `deny` rule → Deny. (Both match conservatively: a matcher whose subject is
   unknown counts as a match.)
3. Plan's read-only boundary → Deny for anything that modifies.
4. Auto: always-ask scopes ask. Every mode: remote-consequential scopes ask unless a rule **with
   a matcher** allows them.
5. `allow` rules (Custom profile, and the user's "Allow via rule" rules) → Allow (exact matches only).
6. Custom profile `ask` rule → Ask.
7. The mode baseline (below; `policy::baseline`).
8. A matching standing grant turns Ask into Allow (never for opaque/sensitive actions or always-ask scopes).
9. Opaque: any Allow becomes Ask.

| Scope group | Plan | Approve | Auto | Bypass |
| --- | --- | --- | --- | --- |
| `filesystem.read`, `git.read`, `terminal.read_only` | allow | allow | allow | allow |
| `filesystem.write`, `terminal.execute`, `git.commit` | **deny** | ask | allow | allow |
| `network.docs`, `browser.navigate` | ask | ask | allow | allow |
| `network.other` | ask | ask | ask | allow |
| `package.install`, `browser.interact` | **deny** | ask | ask | allow |
| `destructive` | **deny** | ask | ask | allow (local) |
| `credentials.access`, `filesystem.outside_workspace` | ask | ask | ask | ask |
| remote-consequential | **deny** | ask | ask | ask |

Custom profiles fall back to the Approve column for scopes they don't mention. Built-in profiles
(`profiles.rs`; mode profiles are generated from the baseline so Settings shows exactly what is
enforced): **Plan**, **Approve**, **Auto**, **Bypass**, and the Custom examples **Code Reviewer**
(reads, docs and read-only commands allowed; running commands and messaging ask; writes, installs,
commits and secrets denied; push, deploy, cloud, billing and destructive **never**) and **Local
Builder** (local edits, commands and commits allowed; installs, push, network, secrets,
destructive ask; messaging, deploy, cloud and billing **never**).

Rule matchers: command-like scopes use a word-boundary command prefix on the normalized words of a
*single simple command* (`npm test` matches `npm test -- -u`, not `npm testx`, and never
`npm test && …`); network/browser scopes a domain (subdomains included); filesystem scopes a
workspace-relative glob (`*`, `?`, `**`).

**Bypass** is broad local authority only. It is set only by the user, with `confirmBypass: true`
after an explicit confirmation dialog, and shows a persistent indicator (sidebar notice and a
Settings banner). Agents, KalVoice and automations are refused (and the refusal is audited); they
cannot change any mode.

## 4. Decisions and standing grants

The answers a request allows (`grants::allowed_decisions`, stored with the request and enforced by
the database): **Deny** always; **Approve once** when approvable; **Allow for thread** and **Allow
for workspace** only when the action is neither opaque nor sensitive and has no always-ask scope;
**Allow via rule** additionally only for local, low-risk scopes with a derivable matcher (not
offered by the approval prompt, which shows Deny / Approve once / Allow for thread / Allow for
workspace per directive §7.4).

| Grant | Covers | Ends |
| --- | --- | --- |
| Thread | the same *fingerprint* in the same thread and workspace | the thread stops or its process exits (`expire_for_thread`), or 24 hours |
| Workspace | the same fingerprint in any thread of the workspace | 30 days |
| Rule | an allow rule per scope with the request's matcher, every workspace | never (until revoked) |

Fingerprints: file reads/writes inside the workspace share one fingerprint ("changing any file in
this workspace"); deletions, secrets, `.git`, and anything outside are per path; commands are the
exact normalized command text plus working folder; packages, git operations, hosts, browser verbs,
deploy targets and tools are exact. The prompt states what a grant would cover.

## 5. Stale approvals

A pending request expires — and can never be approved — when its thread stops or its process
exits (`expire_for_thread`, which also revokes the thread's grants), when a new request arrives
for the same provider action (superseded), when the thread's permission mode changes, and when
KalCode restarts (the provider sessions that asked are gone). Each expiry emits `approval.expired`.

Provider panes (Z7-W4) add one more: a request a pane's `PreToolUse` hook is holding that nobody
answers within the ask window (540 s, inside the hook's 600 s timeout) is handed to the
provider's own prompt in the pane, where the person answers it, and the KalCode request expires
with reason `answered_in_provider` (`PermissionService::expire_answered_in_provider`, audited,
`approval.expired` emitted). Unlike `expire_for_thread`, this does not revoke the thread's grants.

## 6. Audit and persistence (schema v4, `0004_permissions.sql`)

| Table | Contents | Integrity |
| --- | --- | --- |
| `approvals` | origin (`origin_kind`, `origin_id`; `thread_id`, `workspace_id` and `provider_id` required only for thread origins), request, policy decision, allowed answers, context names, status, expire reason (`thread_stopped`, `superseded`, `mode_changed`, `process_restarted`, `answered_in_provider`) | content immutable; resolved rows immutable; never deleted; CHECKs: only `ask` decisions stored, approved ⇒ approvable ∧ answer in the allowed set ∧ answered by the user; known origins and expire reasons only |
| `permission_grants` | thread/workspace/rule grants, expiry, revocation | content immutable; revoke once; never deleted |
| `permission_audit` | append-only log: `approval.requested/approved/denied/expired`, `grant.created/revoked`, `permission.mode_changed`, `permission.default_mode_changed`, `permission.bypass_enabled`, `permission.bypass_refused`, and the Trust Kernel's `trust.action_blocked`, `trust.ceiling_applied`, `trust.invariant_enforced`, `grant.ceiling_clamped` (listed up front: the CHECK can't be widened without rebuilding the table); actor `user`/`system`/`agent`/`kalvoice`/`automation` | UPDATE and DELETE are refused by triggers |
| `permission_profiles` | saved Custom profiles | |
| `permission_settings` | default mode (and Custom profile) for new threads | |

Each consequential change writes its audit row and its event (`approval.*`,
`permission.mode_changed`) in **one transaction** (`Core::transact`). Summaries in events and
audit rows pass through the log redaction pass and never contain file contents.

## 7. Integration surface

- `PermissionService` implements `PermissionGate`. `evaluate` uses both the mode the caller
  passes and the thread's stored mode and returns the stricter result. `open_request` re-evaluates
  and refuses anything the policy wouldn't ask about (a forged or stale `Ask` can't create an
  approvable request). Seams (wired in wave 2): `WorkspaceRoots` = `CoreWorkspaceRoots` over Z1's
  workspaces (a moved or re-pointed folder has no root, so every path is outside), and
  `ThreadModeStore` = the thread runtime (Z3), which holds this service as its gate. The thread
  runtime never starts without the engine.
- IPC: `approval_list { status? }` → `ApprovalView[]` (an `ApprovalRequest` plus
  `allowedDecisions`, `grantCoverage`, `context`, `createdAt`, `expireReason`),
  `approval_decide { requestId, decision }` → `ApprovalView`, `permission_profiles_list`,
  `thread_set_permission_mode { threadId, mode, confirmBypass?, profileId? }`, and the additive
  `permission_settings_get` / `permission_settings_update { defaultMode, profileId?, confirmBypass? }`.
- UI: `PermissionPrompt` (`@kalcode/ui/components`), `ApprovalPrompt`, `usePermissions`,
  `ApprovalsPanel`, `PermissionsSettings` (`apps/desktop/src/surfaces/permissions`).

## 8. Provider mapping

KalCode presents one permission UX, but providers expose different mechanisms. Each adapter
declares a `PermissionMapping` describing, per KalCode mode, the provider-native configuration it
uses and whether the mapping is **exact**, **approximate (stricter)** or **unsupported**. Rules:

- Never silently grant more authority than the KalCode mode implies.
- If a provider cannot express a mode, choose the closest **stricter** mapping and show the
  difference in the UI.
- Where a provider can route approvals to a host, KalCode is the approver: every tool call is
  normalized to a `NormalizedAction` and evaluated by this engine. Otherwise the adapter runs the
  provider in its most restrictive mode and KalCode enforces at the tool level it can observe.
- Bypass never maps to a provider's "skip all permissions" flag unless the adapter still routes
  remote-consequential and opaque actions through the gate.

| Provider | Plan | Approve | Auto | Bypass | Custom | Who decides each tool call today |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code (headless) | `--restricted --permission-mode plan` | `--permission-mode default` | `--permission-mode auto` | `--permission-mode acceptEdits` | as Approve (profile rules are not applied) | Claude Code decides under KalCode's deny floor. Auto uses Claude Code's background classifier; unsupported Auto falls back to Manual. Prompts are denied headless. Credential files and remote actions remain denied in every mode; edit and web tools are also denied in Plan, Approve and Custom. |
| Claude Code (provider pane, Z7-W4) | `--restricted --permission-mode plan` | `--setting-sources user --permission-mode manual` | `--setting-sources user --permission-mode auto` | `--setting-sources user --permission-mode acceptEdits` | as Approve | Claude Code's native prompt/classifier decides under the same deny floor. KalCode observes hooks but does not answer provider prompts (`ProviderPrompt` routing). Auto falls back to Manual when unavailable. The feature is behind the `provider_panes` flag. |
| Codex (headless) | `--sandbox read-only`, `never` | `--sandbox workspace-write`, `on-request` | `--sandbox workspace-write`, `never` | `--sandbox danger-full-access`, `never` | as Approve | Codex decides inside its native sandbox. Auto runs workspace work without prompts; headless approval requests cannot be answered. Web/search and workspace network access remain disabled. |
| Codex (provider pane) | `--sandbox read-only`, `never` | `--sandbox workspace-write`, `on-request` | `--sandbox workspace-write`, `on-request` | `--sandbox danger-full-access`, `never` | as Approve | Codex decides; native prompts stay visible in the pane. Auto retains the workspace sandbox and asks before escalation. Web/search and workspace network access remain disabled. |
| Gemini CLI (headless) | `--approval-mode plan` | `--approval-mode default` | `--approval-mode auto_edit` | `--approval-mode auto_edit` | as Approve | Gemini CLI decides. Auto approves only file edits; shell and other prompts are denied headless. `yolo` is never used. |
| Gemini CLI (provider pane) | `--approval-mode plan` | `--approval-mode default` | `--approval-mode auto_edit` | `--approval-mode auto_edit` | as Approve | Gemini CLI decides. Auto approves only file edits; shell and other risky tools still prompt in the pane. `yolo` is never used. |

All mappings are *approximate (stricter)*. Flags, deny rules and their limits (a Bash deny rule
matches the command text, so a push written another way falls back to Claude Code's mode and the
user's own Claude Code allow rules): `docs/PROVIDERS.md` §5.

## 9. Threat model (summary)

Untrusted: provider output and tool calls (prompt injection), the WebView (treated as possibly
compromised), anything in the workspace (hooks, configs, links). Trusted: native code and the
user's OS account. See `docs/campaigns/Z4.md` for the escape-test matrix and known limits
(time-of-check/time-of-use, hard links on Windows, scripts' internals, WebView approvals).

Classifier hardening from the 2026-09-24 review (per-dialect readings, abbreviations and Unicode
dashes, Git execution options, environment secrets, wildcards) and its regression suites
(`crates/permissions/tests/sec_latent_classifier.rs`, the dialect and deny-wins properties in
`tests/properties.rs`): `docs/campaigns/SEC-LATENT.md`. Known residuals there: recursive search
(`grep -r`, `rg`) reads every file under its folder including `.env`; a pipeline that feeds names
into a reader (`gci -Include *.pem | gc`) is judged per command; multi-level wildcards
(`src/*/config`) are only checked statically.
