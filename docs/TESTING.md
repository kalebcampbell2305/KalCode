# KalCode Testing

Status: Z0 test architecture

## 1. Layers

| Layer | Tooling | Location | What it proves |
| --- | --- | --- | --- |
| Rust unit | `cargo test` | `crates/*/src/**` | migrations, event serialization, settings validation, error mapping, redaction, secret wrappers |
| Rust integration | `cargo test` | `crates/*/tests/` | database upgrades from previous schema versions, event store ordering & pagination, OS keychain round-trip |
| TS unit / component | Vitest + Testing Library (jsdom) | `apps/desktop/src/**/*.test.ts(x)`, `packages/*/src/**/*.test.ts` | event store merge/dedup, IPC error normalization, plans config, primitives' behaviour |
| Desktop UI | Playwright (Chromium) + axe | `apps/desktop/tests/ui/` | shell navigation, keyboard flows, theme switching, visual snapshots, accessibility — against the frontend with the in-memory test transport (`VITE_KALCODE_TRANSPORT=memory`, never shipped) |
| Desktop E2E (real app) | Playwright over WebView2 DevTools protocol | `apps/desktop/tests/e2e/` | launches the **built** `kalcode.exe` with an isolated `KALCODE_DATA_DIR`, drives the UI, changes settings, quits, relaunches, verifies persistence and event history |
| Website | Playwright + axe; Vitest for Worker | `apps/website/tests/` | pages render, navigation (desktop & mobile), no dead links, form validation, API validation/rate-limit paths, accessibility |

The in-memory transport exists only for UI tests; it is excluded from production builds by a
build-time flag and the app refuses to start without a native runtime otherwise.

## 2. Commands

```bash
pnpm check            # format check, lint (biome + clippy), typecheck, unit tests, branding check
pnpm test             # TS + Rust tests
pnpm --filter @kalcode/desktop test:ui      # Playwright UI tests (desktop frontend)
pnpm --filter @kalcode/desktop test:e2e     # real-app E2E (Windows; requires a built app)
pnpm --filter @kalcode/website test:e2e     # website E2E
```

## 3. Rules

- Never weaken a valid test to make CI green; fix the defect.
- Every migration ships with an upgrade test.
- Every bug fix ships with a regression test where practical.
- Visual review uses real screenshots of the running interface in light and dark themes at
  1440×900, 1280×800 and 1024×700.
