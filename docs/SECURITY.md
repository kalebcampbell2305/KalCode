# KalCode Security

Status: living document · Z0 baseline · Z2 provider runtime

KalCode controls powerful tools on a user's machine. Security is architecture, not a feature.

## 1. Security assumptions (Z0)

1. The user's OS account is trusted; other local users and processes are not given access to
   KalCode data beyond OS file permissions on the app-data directory.
2. The WebView is treated as **potentially compromised** (e.g. by rendering untrusted provider
   output). It receives only the allow-listed KalCode commands and no generic native plugins.
3. AI providers and their output are untrusted input. Provider processes are contained by the
   Z2 supervision controls below; their actions are judged by the permission engine from Z4.
4. The website Worker is internet-facing; every request body is untrusted.
5. KalCode itself sends no user data off-device. The website stores only early-access emails.
   Provider CLIs talk to their own services under the user's own account (`docs/PROVIDERS.md`
   §3); KalCode holds no provider credentials of its own.

## 2. Controls in place

| Area | Control |
| --- | --- |
| IPC | Command allow-list via Tauri capabilities generated from `build.rs`; each command validates input natively; no frontend-supplied paths or shell arguments. |
| WebView | Strict CSP (`default-src 'self'`; no remote scripts; no `unsafe-eval`; `style-src 'unsafe-inline'` only, with no external image/font/connect sources to exfiltrate through); no remote content; the Tauri `devtools` feature is off. |
| Environment | Normal builds remove WebView2 override variables (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`, `WEBVIEW2_USER_DATA_FOLDER`, …) as the first action of `main`, so a persistent user environment cannot open a DevTools port or swap the browser runtime; `KALCODE_DATA_DIR` is ignored. Only debug builds and the `e2e`-feature test binary keep them. Verified against a release binary. |
| Unsafe code | `unsafe_code = "deny"` workspace-wide. The single exception is the audited `std::env::remove_var` call at the start of `main` (no other thread exists yet). |
| Single writer | Exclusive OS file lock per data folder; a second process gets `already_running`. |
| Secrets | `SecretStore` trait backed by the OS credential store (Windows Credential Manager, macOS Keychain, Secret Service/keyutils on Linux). `SecretString` redacts `Debug`/`Display` and zeroizes on drop. Secrets never go to SQLite, logs, events, or the UI. |
| Logs | Structured, local only. Every line passes a redaction pass (provider key formats, JWTs, bearer/basic auth, URL credentials, private keys, and `*key/token/secret/password…=value` pairs including JSON-escaped values), tested against real JSON formatter output. Panics are also written synchronously to `logs/crash.log`. |
| Database | Parameterized SQL only; migrations checksummed; pre-migration backups; refuse downgrade. |
| Supply chain | Lockfiles committed; `cargo audit` and `pnpm audit` run in CI; pnpm allows install scripts only for esbuild, workerd, sharp and the Tauri CLI. |
| Provider processes (Z2) | Spawned from an argv vector, never a shell string; model names and session ids validated before they reach argv. Each process has its own reader threads, so one crash, hang or flood cannot affect another provider or KalCode. Timeouts on every probe (15 s), interrupt acknowledgement (5 s) and termination (3 s grace, then kill). The whole process tree is killed on terminate, timeout or drop (`taskkill /T /F` on Windows, process group on Unix). |
| Provider environment (Z2) | `env_clear()`, then an OS/locale/temp/proxy allow-list plus only that provider's own variables (`ANTHROPIC_*`/`CLAUDE_*`, `OPENAI_*`/`CODEX_*`, `GEMINI_*`/`GOOGLE_*`). `KALCODE_*`, `WEBVIEW2_*` and unrelated secrets never pass. |
| Provider output (Z2) | stdout lines capped at 8 MiB; malformed lines skipped and never echoed. stderr kept as a 16 KiB tail, redacted, and only logged, never sent to events or the UI. An unexpected permission request from a provider fails closed: the session is stopped and nothing is approved. |
| Provider configuration (Z2) | Claude Code sessions pass `--setting-sources user` (or `--restricted` in Plan) and `--strict-mcp-config`, so a repository's project settings, hooks and `.mcp.json` servers are not loaded. |
| Provider permissions (Z2) | Every KalCode mode maps to an equal or stricter provider-native mode; the broadest modes (`bypassPermissions`, `auto`, `danger-full-access`, `yolo`) are never used. Until host approvals arrive in Z4, anything that would prompt is denied (`--permission-prompts none` for Claude Code). Enforced by unit tests. |
| Provider credentials (Z2) | KalCode reads no provider credentials and has none of its own; providers use the user's own CLI sign-in. Detection runs only `--version` and documented sign-in status commands; `claude auth status` output (account email, organization) is discarded unread and only its exit code is used. |
| Website | Security headers (CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame-ancestors none); JSON-only API with size limits, strict email validation, honeypot field, per-IP rate limiting via Workers Rate Limiting binding; no secrets in client bundles. |
| Entitlements (built; local only until Z13) | Server-authoritative: only the API (`apps/api`) decides a tier, from D1. OWNER is a database grant that only operator tools with the owner's Cloudflare credentials can write; the database refuses OWNER from billing, OWNER expiry and duplicate active OWNER grants, keeps grants immutable, and writes `audit_log` in the same statement. No email or account id is hardcoded anywhere; no endpoint changes a tier; account routes answer 401 until sign-in exists. Documents and KalVoice usage receipts are Ed25519-signed JWS (private key only in a Worker secret); the desktop (`crates/entitlements`) trusts only compiled-in public keys, binds documents to the signed-in account, and falls back to Free after at most 7 days offline. Details and threat model: `docs/BILLING.md` §10. |

## 3. Private-system boundary

The owner's separate private projects are not part of KalCode. The repository must never contain their
code, prompts, memories, model files, training data, branding or architecture, and must not depend on
private repositories. `tooling/check-branding.mjs` enforces product-naming rules in CI, and
code review checks for imported private material.

## 4. Planned controls (by campaign)

- Z1 (implemented): workspace folders come only from the native picker and are canonicalized;
  shells are chosen by detected id (no executable, arguments or working directory from the
  WebView); every id is validated (`is_valid_id`), sizes and input length are bounded; closing a
  tab closes its pseudo-terminal, ending programs started in it; KalCode and test variables are
  stripped from shell environments; the dialog plugin is used from Rust only. Workspace-root
  containment and symlink-escape checks for file access arrive with file tools (Z3/Z4).
- Z4: permission engine (see `docs/PERMISSIONS.md`) with audit log of consequential decisions.
- Z13: signed updates (Tauri updater with minisign keys), code-signed installers, sign-in and
  per-account rate limiting on the API, Stripe webhook signature verification (billing may only
  write Pro/MAX grants; the database already refuses billing OWNER), production signing key and
  its public key compiled into the desktop.

## 5. Zero company AI cost

KalCode never calls hosted AI or speech APIs with company credentials. Provider work runs through
the user's own provider CLI/account; KalVoice dictation uses on-device speech recognition and
the OS speech synthesizer. `tooling/check-zero-cost.mjs` enforces this in CI by rejecting product
code that references hosted inference or speech endpoints or company API-key variables.

## 6. Reporting

Report security issues to kalcodebuilds@gmail.com (also listed at
https://kalcoded.com/security).
