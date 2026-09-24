# KalCode Testing

Status: test architecture with shared fixtures, a performance harness and a flake policy

## 1. Layers

| Layer | Tooling | Location | What it proves |
| --- | --- | --- | --- |
| Rust unit | `cargo test` | `crates/*/src/**` | migrations, event serialization, settings validation, error mapping, redaction, secret wrappers |
| Rust integration | `cargo test` | `crates/*/tests/` | database upgrades from previous schema versions, event store ordering & pagination, OS keychain round-trip |
| Rust dependency policy | `cargo deny check` | `deny.toml` | licenses allowed for a proprietary app, no known advisories, crates.io-only sources, no duplicate SQLite/Tauri/tokio/serde/uuid |
| TS unit / component | Vitest + Testing Library (jsdom) | `apps/desktop/src/**/*.test.ts(x)`, `packages/*/src/**/*.test.ts` | event store merge/dedup, IPC error normalization, plans config, primitives' behaviour, fixture builders |
| Tooling unit | `node --test` | `apps/desktop/tests/perf/**/*.test.ts` (run by the `tooling` package) | perf statistics and the budget/regression check |
| Desktop UI | Playwright (Chromium) + axe | `apps/desktop/tests/ui/` | shell navigation, keyboard flows, theme switching, visual snapshots, accessibility — against the frontend with the in-memory test transport, compiled only into the `vite --mode ui-test` build (never shipped) |
| Desktop E2E (real app) | Playwright over WebView2 DevTools protocol | `apps/desktop/tests/e2e/` | launches a release binary built with the `e2e` feature (`pnpm build:e2e` → `target/e2e/`) with an isolated `KALCODE_DATA_DIR`; refuses to run if the binary ignores it. Covers persistence across restart, the real credential store, crash detection, newer-schema refusal |
| Performance | Node + Playwright over CDP + OS probes | `apps/desktop/tests/perf/` | startup, shutdown, IPC latency, event append throughput, idle memory/CPU, database size of the real binary; budgets and regression check (see `docs/PERFORMANCE.md`) |
| Website | Playwright + axe; Vitest for Worker | `apps/website/tests/` | pages render, navigation (desktop & mobile), no dead links, form validation, API validation/rate-limit paths, accessibility |
| API (entitlements, KalVoice ledger) | Vitest; local D1 via `wrangler d1 migrations apply --local` + `getPlatformProxy`; real workerd via `wrangler dev` | `apps/api/tests/` | resolution precedence, OWNER constraints in the database, audit triggers, operator tools against local D1, Ed25519 signing in workerd, 401 without sign-in, no tier-changing routes, idempotent/atomic usage ledger, zero outbound calls |
| Cross-language entitlement vectors | Vitest + `cargo test` | `apps/api/tests/unit/vectors.test.ts`, `crates/entitlements/tests/vectors.rs` | documents and usage receipts signed in TypeScript verify (or fail) identically in Rust; RFC 8032 known answers on both sides |

The in-memory transport exists only for UI tests; it is excluded from production builds by a
build-time flag and the app refuses to start without a native runtime otherwise.

## 2. Commands

```bash
pnpm check            # format check, lint (biome + clippy), typecheck, unit tests, branding + capability checks
pnpm test             # TS + tooling + Rust tests
pnpm deny             # cargo-deny: licenses, advisories, bans, sources
pnpm --filter @kalcode/desktop test:ui      # Playwright UI tests (desktop frontend)
pnpm --filter @kalcode/desktop build:e2e    # test binary with hooks enabled (never shipped) → target/e2e/release/kalcode.exe
pnpm --filter @kalcode/desktop test:e2e     # real-app E2E (Windows)
pnpm --filter @kalcode/website test:e2e     # website E2E
pnpm perf                                   # performance harness against target/e2e (Windows)
pnpm perf:check <results.json>              # fail on budget breaks / regressions vs. the baseline
pnpm test:repeat <spec> --times 50          # rerun one spec N times to detect flakiness
pnpm --filter @kalcode/api test             # API unit + integration (local D1, wrangler dev on 18433/18434)
```

## 3. Ports and isolation

Every worktree uses its own ports and never touches the owner's data (full table in
`docs/DEVELOPMENT.md`):

| Variable | Used by | main | infra (this thread) |
| --- | --- | --- | --- |
| `KALCODE_UI_TEST_PORT` | desktop UI tests (Vite `ui-test` server) | 1421 | 1437 |
| `KALCODE_E2E_CDP_PORT` | real-app E2E and the perf harness (WebView2 DevTools) | 9333 | 9437 |
| — | website E2E (`wrangler dev`) | 8788 | 8788 (fixed; see §7) |

- Real-app E2E and perf runs create a fresh temp `KALCODE_DATA_DIR` and WebView2 profile per
  launch and abort if the binary does not create its database there. Never run them against the
  default data folder, and never `pnpm tauri dev` from a worktree.
- The perf harness also refuses to start if its DevTools port is already in use, so it can never
  attach to another worktree's WebView.

## 4. Shared fixtures: `@kalcode/testing`

Typed, deterministic builders and scenarios for the shared contracts (`ThreadSummary`,
`ApprovalRequest`, `NormalizedAction`, `EventEnvelope`, `ProviderDetection`, …). Use them instead
of hand-written objects in Vitest, UI-test transports and previews:

```ts
import { busyWorkspace, createFixtures } from "@kalcode/testing";

const fx = createFixtures({ seed: 1 });
const thread = fx.buildThreadSummary({ status: "waiting_for_permission" });
const { threads, approvals, events } = busyWorkspace(fx); // one thread per ThreadStatus
```

- Same seed → identical data (no `Date.now()`/`Math.random()`), so snapshots are stable.
- Enum lists and event samples are checked for exhaustiveness at compile time: a new contract
  variant fails `pnpm typecheck` until fixtures cover it.
- API reference: `packages/testing/README.md`.

## 5. Performance harness

`pnpm perf` builds nothing; build the binary first with `pnpm --filter @kalcode/desktop build:e2e`.
It measures cold and warm startup, graceful shutdown, IPC round trips, event append throughput,
idle memory and CPU, and database size, then writes `results.json` and `summary.md` under
`target/perf/`. `pnpm perf:check` compares a run with `apps/desktop/tests/perf/budgets.json`
and the committed baseline for the platform. Method, baseline and budgets:
`docs/PERFORMANCE.md`. The nightly workflow runs E2E + perf on Windows.

## 6. Rules

- Never weaken a valid test to make CI green; fix the defect.
- Every migration ships with an upgrade test.
- Every bug fix ships with a regression test where practical.
- Visual review uses real screenshots of the running interface in light and dark themes at
  1440×900, 1280×800 and 1024×700.
- Tests that measure layout must first assert the stylesheet they depend on is applied, so a
  missing asset fails with its real cause.

## 7. Flaky tests

A test that fails and then passes on rerun is a defect, in the test or in the product.

1. **Reproduce.** `pnpm test:repeat <spec> --times 50 [--grep "<title>"]` reruns a spec with
   retries off and prints a pass/fail tally per test (exit 1 if any run failed). Use `--times
   200` for rare flakes; for Vitest files the whole file is rerun.
2. **Keep the evidence.** Playwright keeps a trace for every failure (`test-results/`); CI uploads
   `test-results/` and `playwright-report/` as artifacts on failure.
3. **Fix the cause, not the symptom.** No blanket retries, longer timeouts or skipped
   assertions. If a wait is needed, wait for the condition the assertion depends on.
4. **Quarantine only with an owner and a date.** `test.fixme()` with a comment naming the
   tracking note; never delete the assertion.
5. CI retries (UI: 1, website: 1, real-app E2E: 0) exist to keep unrelated PRs moving; a test
   that needed a retry is reported by Playwright as flaky and must be investigated.

### Investigated: website "honeypot is hidden" (2026-09-24)

`apps/website/tests/e2e/forms.spec.ts` › "the honeypot is hidden from people and assistive
technology" failed once in a full run and passed on reruns.

- Not reproduced: 100/100 isolated runs and 5 full-suite runs (310/310 tests) passed. In 200
  runs with `apps/website/dist` rebuilt four times mid-run, 2 failed — both at the earlier
  `tabindex` step (the page was briefly missing), none at the box assertion.
- Mechanism (verified with a probe that blocked or delayed the stylesheet): the trap is hidden
  only by `site.css` (`.form__trap { position: absolute; left: -10000px }`). With the stylesheet
  delayed, `page.goto` still waits for it and the check passes; with the stylesheet **missing**,
  the trap renders in the page flow at x ≈ 155 and exactly this assertion fails. No other test
  in the suite depends on CSS, so a missing stylesheet shows up only here.
- Most likely cause: the site's stylesheet was unavailable from the local `wrangler dev` server
  for that page load — e.g. `apps/website/dist` being rebuilt by another command during the run
  (the E2E server serves that folder live; rebuilding it mid-run was shown to fail tests), or a
  transient asset error.
- Change: the test now asserts that no stylesheet request failed and that `site.css` positions
  the trap before measuring, and checks that the whole trap box (not only its left edge) is off
  screen. A recurrence now reports its cause instead of `expected true, received false`.
- Rules that follow: do not build the website (`pnpm build`, `astro build`) while its E2E suite
  runs; website E2E uses the fixed port 8788 in every worktree, so run it in one worktree at a
  time (a per-worktree port needs a change to `apps/website/playwright.config.ts`, which is
  outside this thread).
