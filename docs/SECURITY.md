# KalCode Security

Status: living document · Z0 baseline · Z2 provider runtime · SEC-0.1.1 hardening
(`docs/campaigns/SEC-0.1.1.md`)

KalCode controls powerful tools on a user's machine. Security is architecture, not a feature.

## 1. Security assumptions (Z0)

1. The user's OS account is trusted; other local users and processes are not given access to
   KalCode data beyond OS file permissions on the app-data directory.
2. The WebView is treated as **potentially compromised** (e.g. by rendering untrusted provider
   output). It receives only the allow-listed KalCode commands and no generic native plugins.
3. AI providers and their output are untrusted input. Provider processes are contained by the
   Z2 supervision controls below. The permission engine (Z4) judges the actions a provider hands
   to KalCode; Claude Code threads don't hand theirs over yet, so for them KalCode enforces
   through launch flags only (see "Provider permissions" below and `docs/PROVIDERS.md` §5).
4. The website Worker is internet-facing; every request body is untrusted.
5. KalCode itself sends no coding prompts, transcripts, workspace content or provider credentials
   off-device. The account API stores verified account identity, session hashes, billing state and
   KalVoice request ledger data described in `docs/DATA_MODEL.md`; passwordless links are delivered
   through Resend.
   Provider CLIs talk to their own services under the user's own account (`docs/PROVIDERS.md`
   §3); KalCode holds no provider credentials of its own.

## 2. Controls in place

| Area | Control |
| --- | --- |
| IPC | Command allow-list via Tauri capabilities generated from `build.rs`; each command validates input natively; no frontend-supplied paths or shell arguments. Test hooks (`test_permission_probe`) exist only in debug and `e2e` builds: `#[cfg]`-gated, declared in `build.rs` only for those builds, and granted at runtime from `test-capabilities/test-hooks.json`, never from `capabilities/`. `tooling/check-capabilities.mjs` (with its own tests) fails CI if any file under `capabilities/` is not allow-listed and fully checked, or if a test hook could ship. |
| WebView | Strict CSP (`default-src 'self'`; no remote scripts; no `unsafe-eval`; `style-src 'unsafe-inline'` only, with no external image/font/connect sources to exfiltrate through); no remote content; the Tauri `devtools` feature is off. |
| Environment | Normal builds remove every `WEBVIEW2_*`, `COREWEBVIEW2_*` and `WEBKIT_INSPECTOR*` variable (prefix match, case-insensitive) as the first action of `main`, so a persistent user environment cannot open a DevTools port, swap the browser runtime or change its hosting mode; `KALCODE_DATA_DIR` is ignored. Only debug builds and the `e2e`-feature test binary keep them. Terminal shells never receive `KALCODE_*` or any of those prefixes. |
| Unsafe code | `unsafe_code = "deny"` workspace-wide. Exceptions are individually scoped `#[allow(unsafe_code)]` items around OS APIs with no safe wrapper: the `std::env::remove_var` call at the start of `main` (no other thread exists yet), process/Job Object and guardian supervision, file locks, updater installation, WebView2 child views, microphone capture, component storage, and the KalVoice push-to-talk foreground check (read-only `GetForegroundWindow`/`GetWindowThreadProcessId` plus an out-of-context `EVENT_SYSTEM_FOREGROUND` hook; no input hooks, no DLL injection). `rg "allow\(unsafe_code\)"` lists every site. |
| Single writer | Exclusive OS file lock per data folder; a second process gets `already_running`. |
| Secrets | `SecretStore` trait backed by the OS credential store (Windows Credential Manager, macOS Keychain, Secret Service/keyutils on Linux). `SecretString` redacts `Debug`/`Display` and zeroizes on drop. Secrets never go to SQLite, logs, events, or the UI. |
| Logs | Structured, local only. Every line passes a redaction pass (provider key formats, JWTs, bearer/basic auth, URL credentials, private keys, and `*key/token/secret/password…=value` pairs including JSON-escaped values), tested against real JSON formatter output. Panics are also written synchronously to `logs/crash.log`. |
| Database | Parameterized SQL only; migrations checksummed; pre-migration backups; refuse downgrade. |
| Supply chain | Lockfiles committed; `cargo deny check` (advisories, bans, licenses, sources) blocks every PR; `pnpm audit --audit-level high` covers dev dependencies; RustSec audit-check also runs; pnpm allows install scripts only for esbuild, workerd, sharp and the Tauri CLI. |
| Provider processes (Z2) | Spawned from an argv vector, never a shell string; model names and session ids validated before they reach argv. Only absolute folders are searched for a provider, and a native executable wins over a `.cmd` shim. A Windows `.cmd`/`.bat` shim is never trusted to pick its program: its target is resolved and started directly (native binary, or an absolute `node.exe` with the script), so a `node.cmd`/`node.exe`/`cmd.exe` planted in a workspace can't run when a thread starts (`crates/providers/src/launch.rs`, tests in `tests/launch_hardening.rs`). Each process has its own reader threads, so one crash, hang or flood cannot affect another provider or KalCode. Timeouts on every probe (15 s), interrupt acknowledgement (5 s) and termination (3 s grace, then kill). The whole process tree is killed on terminate, timeout or drop (`taskkill /T /F` on Windows, process group on Unix). |
| Provider environment (Z2) | `env_clear()`, then an OS/locale/temp/proxy allow-list plus only that provider's own variables (`ANTHROPIC_*`/`CLAUDE_*`, `OPENAI_*`/`CODEX_*`, `GEMINI_*`/`GOOGLE_*`). `KALCODE_*`, `WEBVIEW2_*` and unrelated secrets never pass. Always `NoDefaultCurrentDirectoryInExePath=1` and a `PATH` of absolute entries only, so nothing is looked up in the workspace. |
| Provider output (Z2) | stdout lines capped at 8 MiB; malformed lines skipped and never echoed. stderr kept as a 16 KiB tail, redacted, and only logged, never sent to events or the UI. An unexpected permission request from a provider fails closed: the session is stopped and nothing is approved. |
| Provider configuration (Z2) | Claude Code sessions pass `--setting-sources user` (or `--restricted` in Plan) and `--strict-mcp-config`, so a repository's project settings, hooks and `.mcp.json` servers are not loaded. |
| Provider permissions (Z2, SEC-0.1.1) | Every KalCode mode maps to an equal or stricter provider-native mode; the broadest modes (`bypassPermissions`, `auto`, `danger-full-access`, `yolo`) are never used. KalCode can't answer provider prompts yet, so anything that would prompt is denied (`--permission-prompts none` for Claude Code). Claude Code sessions also get KalCode deny rules (`--disallowedTools`) that the user's own Claude Code allow rules and hooks can't override: in every mode `git push`, package publishes, deploy/cloud CLIs, `gh` and `ssh`/`scp` in Bash and PowerShell, and reading common credential files (`.env*`, `.npmrc`, SSH keys, `~/.aws`…); in Plan, Approve, Auto and Custom also the edit and web tools. Enforced by unit tests. **Not enforced yet for Claude Code:** KalCode's per-action engine, Custom rules and approvals. Other commands follow Claude Code's own rules, including the user's own Claude Code user settings (every mode except Plan), and a deny rule matches the command text, so a push written another way (full path, `sh -c`) is decided by those rules. Per-action enforcement arrives with provider panes and the hook bridge (Z7). |
| Provider panes and hook bridge (Z7-W4) | Behind the `provider_panes` flag (no endpoint is opened when it is off). The real CLI runs in a PTY started with `PtySession::spawn_program` (argv, `env_clear` then the Z2 sanitized environment). Hooks come only from KalCode's per-session `--settings` file, in exec form (no shell), pointing at the absolute `kalcode-hook` next to the KalCode executable; repository settings stay unloaded (`--setting-sources user`, `--restricted` in Plan, `--strict-mcp-config`); the Z2 deny floor still applies. The helper talks to KalCode over a per-run, randomly named pipe created with `FILE_FLAG_FIRST_PIPE_INSTANCE` and remote clients rejected (Unix: a fresh 0700 socket directory), never TCP, with a mutual HMAC-SHA256 challenge under a per-session key that only the provider's environment carries and that never crosses the wire; fresh server nonces defeat replay; ended sessions are revoked. `PreToolUse` fails closed (exit 2 on every error, its own deadline and panics), status hooks fail open. Hook payloads are filtered to the fields KalCode uses; the first prompt is used only for the title and never stored. Approve/deny goes through the permission engine (`DecisionRouting::Engine`, since the classifier hardening merged); shapes the classifier can't judge yet (recursive searches, pipelines, multi-level wildcards) are sent as opaque, so they always ask. Threat model: `docs/campaigns/Z7-W4-THREATS.md`. Not done (needs reviewed FFI): an owner-only pipe DACL and client-PID checks. |
| Provider credentials (Z2) | KalCode reads no provider credentials and has none of its own; providers use the user's own CLI sign-in. Detection runs only `--version` and documented sign-in status commands; `claude auth status` output (account email, organization) is discarded unread and only its exit code is used. |
| Website | Security headers (CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame-ancestors none); JSON-only API with size limits, strict email validation, honeypot field, per-IP rate limiting via Workers Rate Limiting binding; no secrets in client bundles. Early-access list is double opt-in: joining and removal each need a single-use, 72-hour link (random 32-byte code, only its SHA-256 stored) that acts only on a POST from the page it opens, never on GET; identical responses whether or not an address is listed; per-address email throttle (1 per 10 min, 5 per day) and a site-wide daily email budget; a failed send undoes everything it wrote. Email goes through Resend's REST API with a sending-only, domain-restricted key held as a Worker secret; links always point at https://kalcoded.com (never the request host); logs carry no addresses or links. Details: `docs/WEBSITE.md` "Early access and email". |
| Accounts and entitlements (built locally; configuration/deployment pending) | Primary sign-in uses a high-entropy one-time email proof; desktop completion additionally requires S256 PKCE and bounded polling, while website sessions use HttpOnly, Secure, SameSite=Lax cookies. The API reaches the existing website Resend adapter only through a named internal service binding with fixed templates, durable proof deduplication and the shared daily D1 budget; there is no public mail relay. Optional GitHub OAuth uses state and S256 PKCE. Sessions are random, hashed at rest, expiring, revocable and atomically rotated. Stripe Checkout and Portal accept only server-owned customers, Prices, quantities and return URLs. A post-creation D1 compare-and-set binds each returned Checkout Session to its exact still-authorized intent; a lost fence expires the remote session and returns no URL. Expired reservations clear stale session handles before reuse, and an OWNER grant is refused while an unexpired finalized public Checkout remains usable. Webhooks verify the untouched signed body, deduplicate with expiring versioned claims, retrieve current live-mode state, validate one known Price at quantity one, and apply grants under a versioned D1 fencing lease. Subscription activation moves any finalized Checkout into a durable cleanup outbox before deleting its intent, and the event cannot finish until Stripe reports that Checkout terminal. Invalid snapshots revoke and quarantine rather than preserving stale access. Deleted accounts cannot authenticate or be reactivated by a delayed webhook. OWNER remains an operator-only database grant and can never come from billing. Signed entitlement/usage documents remain account-bound and expire into Free. Details: `docs/BILLING.md` §9–10. |

## 3. Private-system boundary

The owner's separate private projects are not part of KalCode. The repository must never contain their
code, prompts, memories, model files, training data, branding or architecture, and must not depend on
private repositories. `tooling/check-branding.mjs` enforces product-naming rules in CI, and
code review checks for imported private material.

## 4. Planned controls (by campaign)

- Z1 (implemented): workspace folders come only from the native picker and are canonicalized,
  and a whole drive, network share root or the home folder itself is refused as a workspace
  (`folder_too_broad`; folders inside them are fine);
  shells are chosen by detected id (no executable, arguments or working directory from the
  WebView); every id is validated (`is_valid_id`), sizes and input length are bounded; closing a
  tab closes its pseudo-terminal, ending programs started in it; KalCode and test variables are
  stripped from shell environments; the dialog plugin is used from Rust only. Terminals start
  only an absolute, existing shell (checked before the pseudo-terminal library sees it, with a
  cleaned `PATHEXT`), so a deleted shell is a clean error, not a crash; shell detection ignores
  empty and relative `PATH` entries, so a planted `pwsh.exe` can't become the default shell. Workspace-root
  containment and symlink-escape checks for file access arrive with file tools (Z3/Z4).
- Z4: permission engine (see `docs/PERMISSIONS.md`) with audit log of consequential decisions.
- Z7: provider panes and the hook bridge (built in Z7-W4, behind a flag; see the table above): a
  KalCode `PreToolUse` hook sees every Claude Code tool call in a pane and blocks it when KalCode
  is unreachable, and puts each call through the permission engine (engine routing, on since the
  classifier hardening merged). Headless threads keep the launch-flag enforcement described in
  "Provider permissions" above.
- Z13: signed updates (Tauri updater with minisign keys), code-signed installers, sign-in and
  per-account rate limiting on the API, Stripe webhook signature verification (billing may only
  write Pro/MAX/MAX 2X grants; the database already refuses billing OWNER), production signing key and
  its public key compiled into the desktop.

## 5. Zero company AI cost

KalCode never calls hosted AI or speech APIs with company credentials. Provider work runs through
the user's own provider CLI/account; KalVoice dictation uses on-device speech recognition and
the OS speech synthesizer. `tooling/check-zero-cost.mjs` enforces this in CI by rejecting product
code that references hosted inference or speech endpoints or company API-key variables.

## 6. Reporting

Report security issues to kalcodebuilds@gmail.com (also listed at
https://kalcoded.com/security).
