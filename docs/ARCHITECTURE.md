# KalCode Architecture

Status: living document · Campaign: Z0 · Last reviewed: 2026-09-24

This document describes how KalCode is built. Anything that affects more than one subsystem
belongs here or in an ADR under `docs/adr/`.

## 1. System overview

```text
┌──────────────────────────── KalCode Desktop (Tauri 2) ─────────────────────────────┐
│                                                                                     │
│  WebView (React 19 + TypeScript + Vite)          Native runtime (Rust)              │
│  ─────────────────────────────────────           ───────────────────────            │
│  apps/desktop/src                                apps/desktop/src-tauri  (shell)    │
│    ├─ shell/     navigation, palette, theme        ├─ commands.rs  typed IPC        │
│    ├─ surfaces/  Dashboard, Settings, …            └─ main/lib.rs  lifecycle        │
│    ├─ runtime/   event store, query hooks                    │                      │
│    └─ ipc/       typed client ── invoke/Channel ──▶ crates/native-core (kalcode_core)│
│                                                    ├─ db/        SQLite+migrations  │
│  packages/ui       tokens + React primitives       ├─ events/    protocol, store, bus│
│  packages/protocol generated types, plans,         ├─ settings/  typed settings     │
│                    provider/permission contracts   ├─ diagnostics/                  │
│                                                    ├─ error.rs   KalError taxonomy  │
│                                                    ├─ logging.rs structured logs    │
│                                                    └─ flags.rs   feature flags      │
│                                                   crates/secure-store (OS keychain)  │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────── kalcoded.com (Cloudflare Worker + static assets) ────────────────┐
│ apps/website: Astro (static HTML) + Worker (`/api/*`) + D1 (early-access list)    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Future (not built in Z0): `apps/api` (accounts, billing, entitlement — Z13), provider packages
(Z2), PTY / filesystem / permissions crates (Z1, Z4), mission engine (Z9).

## 2. Repository layout

```text
KalCode/
├── apps/
│   ├── desktop/            React frontend + src-tauri (Tauri shell crate `kalcode-desktop`)
│   └── website/            kalcoded.com — Astro static site + Cloudflare Worker + D1
├── crates/
│   ├── native-core/        `kalcode_core`: db, migrations, events, settings, errors, logging
│   └── secure-store/       `kalcode_secure_store`: SecretStore trait + OS keychain backend
├── packages/
│   ├── protocol/           `@kalcode/protocol`: generated IPC/event types, plans, contracts
│   └── ui/                 `@kalcode/ui`: design tokens, brand assets, React primitives
├── docs/                   living documentation, ADRs, campaign reports
├── tooling/                repo scripts (branding check, asset generation)
└── .github/workflows/      CI
```

The directive's reference layout is the target; directories are created when the campaign that
needs them begins, so the tree never contains empty placeholder packages.

## 3. Process & trust model

| Zone | Trust | Authority |
| --- | --- | --- |
| Native runtime (Rust) | Trusted | Owns the database, filesystem, processes, secrets, OS integration. |
| WebView (React) | **Untrusted by default** | May only call the explicitly allow-listed KalCode commands. No `fs`, `shell`, `http` plugins, no arbitrary IPC. |
| Provider processes (Z2+) | Untrusted | Run as child processes supervised by native code; all actions pass through the permission engine (Z4). |
| Website Worker | Trusted server | Validates all input; stores only early-access emails. |

Consequences:

- Every Tauri command validates its input in Rust. The frontend cannot pass paths, shell
  arguments or SQL fragments to native code in Z0; commands that act on the filesystem use
  native-owned paths (e.g. "open logs folder" resolves the log directory itself).
- The Tauri capability file (`apps/desktop/src-tauri/capabilities/main.json`) grants the main
  window only `core:default`-level window/event permissions plus the KalCode command allow-list
  generated in `build.rs`.
- A strict Content-Security-Policy is configured in `tauri.conf.json` (no remote script, no eval).

## 4. IPC boundary (v1)

All IPC types are defined in Rust and exported to TypeScript with `ts-rs` into
`packages/protocol/src/generated/`. CI fails if the generated files are stale.

| Command | Input | Output | Notes |
| --- | --- | --- | --- |
| `boot` | — | `BootState` | build info, feature flags, and the startup error if the core failed to start |
| `window_ready` | — | — | shows the main window after the first themed paint |
| `settings_get` | — | `Settings` | |
| `settings_update` | `SettingsPatch` | `Settings` | validated; settings and `settings.changed` commit in one transaction |
| `events_recent` | `{ limit, beforeSeq? }` | `EventEnvelope[]` | native rejects limits outside 1..=500; the TS client clamps |
| `events_subscribe` | `Channel<EventEnvelope>` | `SubscriptionId` | one per webview; replaced on resubscribe, dropped on page reload |
| `events_unsubscribe` | `SubscriptionId` | `bool` | a webview can cancel only its own subscription |
| `diagnostics_get` | — | `Diagnostics` | sanitized, no project content |
| `diagnostics_open_log_dir` | — | — | native resolves the path |
| `diagnostics_open_data_dir` | — | — | native resolves the path (startup-error screen) |
| `secure_store_check` | — | `SecureStoreCheck` | writes, reads, deletes a probe credential; 2 s cooldown, serialized |

Database-backed commands run off the main thread (`#[tauri::command(async)]`).

Errors cross the boundary as `IpcError { category, code, message, retryable }` (see §7). The
frontend client (`apps/desktop/src/ipc`) is the only module allowed to call `invoke`.

Subscription protocol: the client subscribes first, then fetches `events_recent`, and merges
by `seq` (deduplicating), so no event can fall between the two calls.

## 5. Persistence

- SQLite via `rusqlite` (bundled SQLite), one database file: `<app-data>/kalcode.db`.
- Pragmas: `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`.
- Migrations are embedded SQL files (`crates/native-core/migrations/NNNN_name.sql`), applied in
  order inside one transaction each, recorded in `schema_migrations` with a SHA-256 checksum.
- Before applying migrations to an existing database, a consistent backup is written with the
  SQLite backup API to `<app-data>/backups/kalcode-pre-v{N}-{timestamp}.db` (last 5 retained).
- A checksum mismatch or a database newer than the app is a hard, user-visible error — never a
  silent rewrite. See `docs/DATA_MODEL.md`.
- Data directory: the OS app-data directory for identifier `com.kalcode.desktop`. An exclusive
  lock on `<data>/kalcode.lock` guarantees one KalCode process per data folder.
  `KALCODE_DATA_DIR` (absolute paths only) overrides it in debug and `e2e`-feature builds only.
- WAL journal mode is enabled only after migrations succeed, so a database this build refuses
  (e.g. one from a newer KalCode) is left untouched.

## 6. Event protocol

The event protocol is the backbone for the Dashboard, activity feed, recovery, auditing and
diagnostics. Every state change that a user could care about is an event. See
`docs/EVENT_PROTOCOL.md`. Flow:

```text
domain operation ─▶ EventStore.append (SQLite, assigns seq) ─▶ EventBus.publish ─▶ Channel ─▶ UI store
```

Events are persisted **before** they are published, so the UI never shows something the
database does not know about.

## 7. Error architecture

`kalcode_core::KalError` carries a category, a stable machine code, a user-safe message, a
retryable flag, and an internal source chain that is logged but never sent to the UI.

Categories (`ErrorCategory`): `Database`, `Filesystem`, `Validation`, `Permission`, `Provider`,
`Authentication`, `Terminal`, `Git`, `Network`, `Plugin`, `Mission`, `Verification`, `Billing`,
`Update`, `SecureStore`, `Internal`.

The UI maps errors to `ErrorState` / toast copy that explains what failed, what is safe, and
what the user can do.

## 8. Logging & observability

- `tracing` with a JSON file layer (daily rotation, 14 files retained) at `<app-data>/logs/`
  and a compact stderr layer in development.
- Standard fields: `module`, `event`, `duration_ms`, `error_code`, plus `workspace_id`,
  `thread_id`, `mission_id`, `provider_id` spans when applicable.
- Secrets never reach logs: secret values are wrapped in `SecretString` (redacted `Debug`,
  zeroized on drop), and a redaction pass scrubs known credential patterns from log messages.
- No telemetry leaves the device in Z0.

## 9. Feature flags

`FeatureFlags` is computed natively from the build channel (`stable`, `beta`, `development`)
and returned in `AppInfo`. Each surface has a state: `available`, `preview`, or `gated`.
Gated surfaces are hidden on `stable`; on `development` they appear in an "In development"
navigation group and open an honest status page. The channel is set at build time via
`KALCODE_CHANNEL` (default `development` until the first release).

## 10. Design system

`packages/ui` owns tokens (CSS custom properties for color, type, spacing, radius, elevation,
motion, z-index, layout) with separately designed light and dark themes, and accessible React
primitives built on Radix UI. See `docs/DESIGN_SYSTEM.md`.

## 11. Website

`apps/website` is an Astro static site served by a Cloudflare Worker with static assets. The
Worker handles `/api/*` (early-access registration → D1), redirects `www.kalcoded.com` to the
apex, and sets security headers. See `docs/WEBSITE.md`.

## 12. Testing & CI

See `docs/TESTING.md`. Summary: Rust unit + integration tests, Vitest unit/component tests,
Playwright UI tests against the desktop frontend, a Playwright end-to-end test that drives the
**real** packaged desktop app over the WebView2 DevTools protocol (Windows), Playwright + axe
tests for the website, and GitHub Actions running format, lint, typecheck, tests and builds on
Windows, macOS and Linux.

## 13. Decision records

- `docs/adr/0001-monorepo-and-toolchain.md`
- `docs/adr/0002-rust-owned-protocol-types.md`
- `docs/adr/0003-website-on-cloudflare-workers.md`
