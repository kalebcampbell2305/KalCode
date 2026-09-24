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
| WebView | Strict CSP (`default-src 'self'`; no remote scripts; no `unsafe-eval`); no remote content; devtools disabled in release builds. |
| Secrets | `SecretStore` trait backed by the OS credential store (Windows Credential Manager, macOS Keychain, Secret Service/keyutils on Linux). `SecretString` redacts `Debug`/`Display` and zeroizes on drop. Secrets never go to SQLite, logs, events, or the UI. |
| Logs | Structured, local only; redaction pass for credential patterns (API keys, bearer tokens, private keys, URL credentials). |
| Database | Parameterized SQL only; migrations checksummed; pre-migration backups; refuse downgrade. |
| Unsafe Rust | `unsafe_code = "forbid"` workspace-wide. |
| Supply chain | Lockfiles committed; `cargo audit`, `cargo deny`, and `pnpm audit` run in CI. |
| Website | Security headers (CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, frame-ancestors none); JSON-only API with size limits, strict email validation, honeypot field, per-IP rate limiting via Workers Rate Limiting binding; no secrets in client bundles. |

## 3. Private-system boundary

The owner's private JARVIS system is not part of KalCode. The repository must never contain its
code, prompts, memories, model files, training data, or architecture, and must not depend on
private repositories. `tooling/check-branding.mjs` enforces product-naming rules in CI, and
code review checks for imported private material.

## 4. Planned controls (by campaign)

- Z1: path canonicalization, workspace-root containment checks, symlink escape detection, PTY
  process-tree cleanup.
- Z2: provider process isolation, sanitized environment for child processes, credential scoping.
- Z4: permission engine (see `docs/PERMISSIONS.md`) with audit log of consequential decisions.
- Z13: signed updates (Tauri updater with minisign keys), code-signed installers, webhook
  signature verification for billing, server-side entitlement authority.

## 5. Reporting

A security contact address will be published on https://kalcoded.com/security once a
monitored mailbox is configured.
