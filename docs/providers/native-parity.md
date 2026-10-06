# Native provider parity

KalCode hosts supported provider CLIs in real terminals. Provider-native authentication, permissions and policy remain authoritative. Cursor's verified integration is documented in [cursor.md](cursor.md).

| Capability | Claude Code | Codex | Gemini CLI | Cursor |
| --- | --- | --- | --- | --- |
| Native coding terminal, workspace, resize, input and interrupts | Shared PTY adapter | Shared PTY adapter | Shared PTY adapter | Shared PTY adapter |
| Native file, edit, search, shell and Git tools | Native CLI | Native CLI | Native CLI | Native CLI |
| Account persistence | Native managed profile | Native managed profile | Native managed profile | Native OS-user sign-in |
| Concurrent isolated accounts | Managed profiles | Managed profiles | Managed profiles | Not verified; one native account |
| Model choices | Provider model configuration | Exact-account app-server `model/list`, including model-specific effort | Native model configuration | Runtime `agent models`; no static list |
| Turn status | Authenticated hooks | Authenticated observing hooks (verified 0.160.x; session-scoped, never deciding) plus completion notifications; other lines completion notifications only | Process-only status (no per-session hook mechanism without writing or hiding user settings) | Authenticated plugin hooks, with limited fallback |
| Usage | Canonical provider-reported source | Canonical provider-reported source | Unavailable | Unavailable |
| User settings and integrations | Native configuration | Native configuration | Native configuration | Native configuration plus additive observer plugin |
| Unified Memory | Shared workspace service and native prompt context | Shared workspace service and task context | Shared workspace service and task context | Shared workspace service and native startup/prompt context |

This table describes integration mechanisms, not certification of every upstream extension or model. Provider policy can disable a native feature; KalCode must show the real limitation and must not fabricate status or availability.

## Squad and queued-agent launches

Squads, Recipes and agent Operations use the same provider-pane adapter as Code's
New agent action. Each launched member has a real PTY and canonical coding session;
the selected account, exact model, supported effort, native configuration and
worktree flow through that adapter. KalVoice calls the same Squad launch command.
No provider-specific Squad executor or headless replacement limits native tools.

Provider adapters determine interactive support and effort mapping. A provider
without the requested capability produces an actionable member-level failure;
independent members continue. Deterministic native tests prove orchestration and
terminal identity without claiming that a paid upstream request was exercised.
See [Squads](../SQUADS.md) for dependencies, recovery and ownership behavior.

## Parity rule and verification

AGENTS.md, "Permanent native provider parity rule": a provider inside KalCode must keep every
capability it has in its normal native terminal. This page records, per provider and capability,
what the provider supports natively and where KalCode stands. Keep it truthful. If the provider
doesn't support something, KalCode doesn't fake it. If the provider supports it and KalCode
doesn't, that's a KalCode bug: fix it, then update this page.

**How parity is checked.** `crates/providers/tests/native_parity_real.rs` runs each installed CLI
twice, once with the user's own environment (native) and once with exactly the environment and
account profile a managed KalCode session gets, and compares what each reports:

```text
KALCODE_NATIVE_PARITY=1 cargo test -p kalcode-providers --test native_parity_real -- --ignored --nocapture
```

On 2026-10-04, on the owner's Windows machine (Claude Code 2.1.289, Codex 0.160.0, Gemini CLI
0.61.0):

| | Native terminal | KalCode before this fix | KalCode after |
| --- | --- | --- | --- |
| Claude Code MCP servers (user + plugin) | 15 | 0 (only the account's claude.ai connector) | 15, identical |
| Codex MCP servers | `cua_repl`, `node_repl` | none (profile `config.toml` was a one-line stub) | identical |
| Gemini CLI MCP servers | none configured | MCP disabled by `--allowed-mcp-server-names <sentinel>` | identical |

Account-bound entries are compared separately because the scratch profile is deliberately
signed out: Claude's claude.ai connectors and Codex plugin servers appear only for a signed-in
account. A mirror of the whole native Codex home without `auth.json` doesn't list Codex plugin
servers either.

## How a managed account session is built

A connected account runs its provider with its own profile directory (`CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, `GEMINI_CLI_HOME`), so accounts keep separate credentials and sessions. Everything
else comes from the user's native setup:

- **Environment** (`crates/providers/src/env.rs`, `EnvPolicy::NATIVE`). This is the user's whole
  environment except KalCode-internal variables (`KALCODE_*`, `WEBVIEW2_*`, `WEBKIT_INSPECTOR*`).
  A managed session also drops only the variables that would make that provider authenticate as
  another identity (`env::auth_overrides`: its API keys and tokens, alternative cloud backends,
  its own profile selector, Codex sign-in issuer overrides). Other providers' keys still pass.
- **Configuration** (`crates/providers/src/native_config.rs`, before every launch):
  - **Linked** (a junction on Windows, a symlink elsewhere) to the native directory, so changes
    on either side are the same change: Claude `agents`, `commands`, `skills`, `rules`,
    `output-styles`, `hooks`, `plugins`; Codex `skills`, `prompts`, `rules`, `agents`, `plugins`;
    Gemini `skills`, `extensions`, `commands`, `agents`, `policies`. A profile directory that
    already had content is kept beside the link as `<name>.kalcode-before-native-config`.
  - **Copied:** `CLAUDE.md`, `keybindings.json`; Codex `AGENTS.md`, `AGENTS.override.md`,
    `hooks.json`; `GEMINI.md`. A copy the user edited inside KalCode is kept as a backup before
    a native change replaces it.
  - **Merged three ways** against the last native snapshot (`.kalcode-native-config.json` in the
    profile): Claude and Gemini `settings.json`, plus Claude's user-scope `mcpServers` and
    per-project MCP keys in `.claude.json`. A native change reaches the profile, a value changed
    inside KalCode survives, and keys only the profile has are kept. Settings that choose how the
    provider authenticates are never merged: Claude `apiKeyHelper`, AWS auth helpers,
    `forceLogin*` and auth keys in `env`, and Gemini `security.auth`.
  - **Codex `config.toml`** is the user's native file under KalCode's header. Only
    `cli_auth_credentials_store` is left out, because it would move the account's sign-in.
- **Never touched:** the native side is only read. Credentials, account identity and onboarding
  state stay in the profile. Tests never write the user's real configuration.

## Matrix

Legend: **Parity** means it works inside KalCode as it does natively. **Gap** means it is
supported natively but not yet inside KalCode (a KalCode bug). **Bound** means it is tied to the
selected KalCode account by design.

### Claude Code

| Capability | Native | KalCode |
| --- | --- | --- |
| Files, search, shell, Git, build, test | Yes | Parity |
| Environment (PATH, SSH agent, `GH_TOKEN`, toolchains, proxies) | Yes | Parity (`EnvPolicy::NATIVE`) |
| User settings (`settings.json`: env, permissions, plugins, hooks, status line) | Yes | Parity (three-way merge) |
| User MCP servers (`~/.claude.json`) | Yes | Parity (merged; verified 15/15) |
| Project and local MCP servers | Yes | Parity for local-scope servers (merged per project). Project `.mcp.json` loading is part of the provider tool-calling fix (`--strict-mcp-config` removal) |
| Plugins and marketplaces | Yes | Parity (linked `plugins`) |
| Skills, agents, commands, rules, output styles | Yes | Parity (linked) |
| Global instructions (`~/.claude/CLAUDE.md`) | Yes | Parity (copied) |
| Project `CLAUDE.md`, project settings | Yes | Parity: the real workspace is the working directory |
| Subagents | Yes | Parity (user agents linked) |
| Web search and fetch | Yes | Fixed by the provider tool-calling change (the deny floor no longer blocks web tools) |
| Authentication | Yes | Bound: each account's own sign-in; an `ANTHROPIC_API_KEY` in the environment doesn't override the selected account |
| Session resume | Yes | Parity for sessions started in KalCode. **Gap:** a session started in a native terminal lives in the native `projects/` and can't be resumed from a KalCode account profile yet (and vice versa) |
| Interactive terminal (keys, Ctrl+C, resize, ANSI, prompts) | Yes | Parity: real ConPTY/openpty with resize forwarded (`provider_pane_resize`) |

### Codex

| Capability | Native | KalCode |
| --- | --- | --- |
| Files, search, shell, Git, build, test | Yes | Parity |
| Environment | Yes | Parity (`EnvPolicy::NATIVE`) |
| `config.toml` (MCP servers, plugins, features, model providers, notify, project trust) | Yes | Parity (native file per launch). Before: a one-line stub, with the workspace forced to `untrusted` |
| Project trust | Yes | Parity: the user's own `[projects]` trust (the forced `untrusted` override is gone) |
| Skills, prompts, rules, agents, plugins | Yes | Parity (linked) |
| Global `AGENTS.md`, hooks (`hooks.json`) | Yes | Parity (copied) |
| Business, Enterprise and Edu plans | Yes | Parity: organization cloud configuration applies as it does natively. Before: refused ("organization plans not supported yet") |
| Web search | Yes | Fixed by the provider tool-calling change (`web_search='disabled'` removed from argv) |
| Authentication | Yes | Bound: each account's own `auth.json`; `OPENAI_API_KEY`/`CODEX_API_KEY` don't override it |
| Session resume | Yes | Parity inside KalCode. **Gap:** native-terminal sessions aren't visible to a KalCode account profile |

### Gemini CLI

| Capability | Native | KalCode |
| --- | --- | --- |
| Working directory | The workspace | Parity: the real workspace. Before: a neutral folder outside the repository, with the repository as an include directory |
| Environment, including `.env` loading | Yes | Parity. Before: `advanced.ignoreLocalEnv` was forced |
| User settings, MCP servers, extensions, skills, agents, hooks | Yes | Parity (merged and linked). Before: `--allowed-mcp-server-names <sentinel>`, `--extensions none`, and skills, agents and hooks forced off |
| Workspace settings and `GEMINI.md` | Yes | Parity: the workspace is the working directory |
| Administrator system settings and policies | Yes | Parity: no longer redirected to empty files. Launches no longer refuse when administrator policies exist |
| Plan mode | `--approval-mode plan` | Parity (Gemini's own Plan mode; KalCode's extra tool floor is gone) |
| Authentication | Yes | Bound: per-profile encrypted credential store; `GEMINI_API_KEY` doesn't override the account |
| Sign-in | Yes | KalCode's sign-in step (authenticate, then exit) runs with a read-only floor and no MCP servers or extensions; it is not a coding session. Administrator system settings apply to it as natively (no longer redirected to user-owned empty files, which Gemini 0.61 skipped with two "Security Warning" lines) |

### Cursor

Cursor signs in as the native OS user (no per-account profile), so a Cursor session already gets
the user's own environment (`EnvPolicy::NATIVE`) and configuration. See [cursor.md](cursor.md).

### Future providers

A new adapter starts from `EnvPolicy::NATIVE` and the `native_config` pattern, and must pass
`native_parity_real.rs` before it ships.

## Open gaps

1. **Native-terminal session history** (Claude Code, Codex). A KalCode account profile has its
   own session store, so a session started in a plain terminal can't be resumed in KalCode, and
   the reverse also fails. Linking the session store would merge every account's history and
   break per-account usage attribution, so this needs an explicit design.
