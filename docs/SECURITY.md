# KalCode Security

Status: living document · Z0 baseline

KalCode controls powerful tools on a user's machine. Security is architecture, not a feature.

## 1. Security assumptions (Z0)

1. The user's OS account is trusted; other local users and processes are not given access to
   KalCode data beyond OS file permissions on the app-data directory.
2. The WebView is treated as **potentially compromised** (e.g. by rendering untrusted provider
   output). It receives only the allow-listed KalCode commands and no generic native plugins.
3. AI providers and their output are untrusted input. (Enforced by the permission engine from Z4.)
4. The website Worker is internet-facing; every request body is untrusted.
5. Nothing in Z0 sends user data off-device. The website stores only early-access emails.

## 2. Controls in place (Z0)

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
| Website | Security headers (CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame-ancestors none); JSON-only API with size limits, strict email validation, honeypot field, per-IP rate limiting via Workers Rate Limiting binding; no secrets in client bundles. |

## 3. Private-system boundary

The owner's separate private projects are not part of KalCode. The repository must never contain their
code, prompts, memories, model files, training data, branding or architecture, and must not depend on
private repositories. `tooling/check-branding.mjs` enforces product-naming rules in CI, and
code review checks for imported private material.

## 4. Planned controls (by campaign)

- Z1: path canonicalization, workspace-root containment checks, symlink escape detection, PTY
  process-tree cleanup.
- Z2: provider process isolation, sanitized environment for child processes, credential scoping.
- Z4: permission engine (see `docs/PERMISSIONS.md`) with audit log of consequential decisions.
- Z13: signed updates (Tauri updater with minisign keys), code-signed installers, webhook
  signature verification for billing, server-side entitlement authority.

## 5. Zero company AI cost

KalCode never calls hosted AI or speech APIs with company credentials. Provider work runs through
the user's own provider CLI/account; KalVoice dictation uses on-device speech recognition and
the OS speech synthesizer. `tooling/check-zero-cost.mjs` enforces this in CI by rejecting product
code that references hosted inference or speech endpoints or company API-key variables.

## 6. Reporting

Report security issues to kalcodebuilds@gmail.com (also listed at
https://kalcoded.com/security).
