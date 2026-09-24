# KalCode Permission Architecture

Status: implemented in campaign Z4 (`crates/permissions`, migration `0005`) · Contract types:
`crates/contracts/src/permissions.rs` (TypeScript: `packages/protocol/src/generated`)

Permissions are security infrastructure. They govern every provider, agent, KalVoice action,
automation and plugin. **KalVoice is not above the permission model.** Every permission mode —
Plan, Approve, Auto, Bypass and Custom — is available on every plan, including Free.

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

**Commands.** The tokenizer accepts the union of bash, cmd.exe and PowerShell syntax and resolves
every ambiguity toward more authority: `;`, `&&`, `||`, `|`, `&`, newlines, `()` and `{}` split
commands; quotes, `\` and `^` escapes are removed before the program is identified (`r"m"`,
`r^m`, `\rm` are `rm`); text with backslashes is classified under both POSIX and Windows escaping;
`#` is not a comment. Wrappers are unwrapped (`sudo`, `env`, `nice`, `timeout`, `xargs`, `start`,
`Start-Process`, `wsl`, `busybox`), shells are recursed into (`bash -c`, `cmd /c`, `powershell
-Command`, positional PowerShell scripts, `-EncodedCommand` in any abbreviation, decoded from
UTF-16LE base64), to a depth of 4. Programs are classified by name: read-only tools
(`terminal.read_only`), file writers, destructive tools (`rm -r`, `del /s`, `rd /s`,
`Remove-Item -Recurse`, `format`, `mkfs`, `dd of=`, `diskpart`, `shred`, recursive `chmod`,
`robocopy /MIR`, `rsync --delete`, `git reset --hard`, `git clean -f`, `git push --force` …),
package managers, git (every subcommand), network clients (with data-sending detection and
messaging/billing hosts), SSH-like tools (`cloud.modify`), cloud/deploy CLIs (vercel, wrangler,
aws, gcloud, az, kubectl, terraform, gh, docker, stripe …), credential tools and `printenv`.
Unknown programs are `terminal.execute`; their path-looking arguments are containment-checked.

**Opaque** means KalCode could not see everything the command will do: command/process
substitution, backticks, `eval`/`iex`/`source`, aliases and functions, `find -exec`, `xargs`,
inline interpreter code (`python -c`, `node -e`), encoded PowerShell, piping into a shell,
dangerous environment variables (`PATH`, `LD_PRELOAD`, `GIT_*`, `NODE_OPTIONS`…), `git -c`,
`git config` writes, unknown git subcommands (possible aliases), LOLBins (`mshta`, `rundll32`,
`certutil -urlcache`), unterminated quotes, heredocs, control/invisible characters, text longer
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

## 6. Audit and persistence (migration `0005_permissions.sql`)

| Table | Contents | Integrity |
| --- | --- | --- |
| `approvals` | request, policy decision, allowed answers, context names, status | content immutable; resolved rows immutable; never deleted; CHECKs: only `ask` decisions stored, approved ⇒ approvable ∧ answer in the allowed set ∧ answered by the user |
| `permission_grants` | thread/workspace/rule grants, expiry, revocation | content immutable; revoke once; never deleted |
| `permission_audit` | append-only log: `approval.requested/approved/denied/expired`, `grant.created/revoked`, `permission.mode_changed`, `permission.default_mode_changed`, `permission.bypass_enabled`, `permission.bypass_refused`; actor `user`/`system`/`agent`/`kalvoice`/`automation` | UPDATE and DELETE are refused by triggers |
| `permission_profiles` | saved Custom profiles | |
| `permission_settings` | default mode (and Custom profile) for new threads | |

Each consequential change writes its audit row and its event (`approval.*`,
`permission.mode_changed`) in **one transaction** (`Core::transact`). Summaries in events and
audit rows pass through the log redaction pass and never contain file contents.

## 7. Integration surface

- `PermissionService` implements `PermissionGate`. `evaluate` uses both the mode the caller
  passes and the thread's stored mode and returns the stricter result. `open_request` re-evaluates
  and refuses anything the policy wouldn't ask about (a forged or stale `Ask` can't create an
  approvable request). Seams: `WorkspaceRoots` (Z1) and `ThreadModeStore` (Z3); until wired,
  every path is outside the workspace and thread mode changes report `thread_not_found`.
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

| Provider | Plan | Approve | Auto | Bypass | Custom | Source |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | pending Z2 | pending Z2 | pending Z2 | pending Z2 | pending Z2 | Z2 research against current official docs |
| Codex | pending Z2 | pending Z2 | pending Z2 | pending Z2 | pending Z2 | Z2 |
| Gemini CLI | pending Z2 | pending Z2 | pending Z2 | pending Z2 | pending Z2 | Z2 |

Details live in `docs/PROVIDERS.md` once Z2 lands.

## 9. Threat model (summary)

Untrusted: provider output and tool calls (prompt injection), the WebView (treated as possibly
compromised), anything in the workspace (hooks, configs, links). Trusted: native code and the
user's OS account. See `docs/campaigns/Z4.md` for the escape-test matrix and known limits
(time-of-check/time-of-use, hard links on Windows, scripts' internals, WebView approvals).
