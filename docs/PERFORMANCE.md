# KalCode Performance

Status: harness, first baseline and budgets (Windows). Measure first (directive §39): every
optimisation starts from a number produced by this harness, and every budget below is checked
against the real release binary, not a dev build.

## 1. What is measured

`apps/desktop/tests/perf/run.ts` drives the real binary built with the `e2e` feature
(`pnpm --filter @kalcode/desktop build:e2e` → `target/e2e/release/kalcode.exe`: release
profile, LTO, the shipping frontend; the feature only keeps `KALCODE_DATA_DIR` and the WebView2
environment overrides, such as the DevTools port, that normal builds strip). Every launch gets a fresh temp data folder and WebView2 profile; the
run aborts if the binary does not create its database there, or if the DevTools port is taken.

| Metric | Method |
| --- | --- |
| `startup.{cold,warm}.windowVisibleMs` | Process spawn → the KalCode window is visible to the user. An OS-side watcher (Win32 `EnumWindows`, 2 ms polling, started before the app) waits for a visible, unowned, uncloaked, titled window ≥ 100×100 owned by the process. The app keeps its window hidden until its first themed render (`window_ready`), so this is "first real paint on screen". |
| `startup.*.windowReadyIpcMs` | Spawn → completion of the frontend's `window_ready` IPC call, from the page's own Resource Timing (recorded by the page, read after the fact: no observer effect). |
| `startup.*.webviewNavigationStartMs`, `…domContentLoadedMs` | Spawn → WebView2 navigation start / `DOMContentLoaded`, from Navigation Timing. |
| cold vs. warm | **Cold** = first launch in a fresh data folder (new database + migrations + new WebView2 profile). **Warm** = relaunch on an existing folder (first launch discarded). Neither is an OS cold boot: the binary and WebView2 runtime are in the OS file cache. |
| `shutdown.gracefulMs` | `WM_CLOSE` (as the window's close button) → process exit, over every launch. |
| `ipc.*.roundTripMs` | 300 sequential `invoke` round trips per command, timed in the page with `performance.now()` after 20 warm-ups: `boot` (sync command, main thread), `settings_get`, `events_recent` (limit 50), `diagnostics_get` (async commands with SQLite reads). |
| `events.append.*` | 500 sequential `settings_update` calls toggling `sidebarCollapsed`. Each commits the setting **and** a `settings.changed` event in one SQLite transaction and broadcasts it to the UI (which re-renders). The harness verifies the persisted event count grew by exactly 500. Uses only existing commands. |
| `memory.idle.*` | After the shell is up, DevTools is detached and the app settles 10 s; then working set and private bytes of `kalcode.exe` and of the whole process tree (WebView2 browser, GPU, renderer, utility processes). |
| `cpu.idle.*` | CPU time of the same tree over 30 s of idle (DevTools detached), as % of one core; per-process-role breakdown in the run's `context.idleByRole`. |
| `memory.afterEvents.workingSetMB` | Tree working set 2 s after the event burst. |
| `db.*.bytes` | `kalcode.db` + `-wal` + `-shm`: after the first launch, before the burst, and after the burst and a clean shutdown (WAL checkpointed). |
| `binary.exeBytes` | Size of the e2e release executable (same profile as shipping). |

Every run also records the machine (CPU, cores, RAM, OS, WebView2 and Node versions) and the
machine-wide CPU load during the idle window (`context.machineCpuBusyPercentDuringIdle`) so
noisy runs are recognisable.

## 2. Running it

```bash
pnpm --filter @kalcode/desktop build:e2e      # once per code change
pnpm perf                                     # ~3 min; writes target/perf/<platform>-<time>/{results.json,summary.md}
pnpm perf --quick                             # smoke run (1 cold, 1 warm, short idle)
pnpm perf:check target/perf/<run>/results.json            # budgets + regression vs. baseline
pnpm perf:check target/perf/<run>/results.json --no-baseline  # budgets only (other machines, CI)
```

Options: `--cold N --warm N --ipc N --events N --idle-seconds N --settle-seconds N --exe path
--port N --out dir`. The DevTools port defaults to `KALCODE_E2E_CDP_PORT` or 9437 (this
thread's port; see `docs/DEVELOPMENT.md`).

For comparable numbers: close other heavy work (builds, test suites, other worktrees), keep
the machine on AC power, and do not interact with the KalCode window during the run. The
window stays on screen during idle measurements; if it is fully covered by other windows,
Chromium may throttle rendering and idle CPU reads lower.

Platform support: Windows only for now. OS-specific probes (process tree, window visibility,
close request) live behind `ProcessProbe` in `tests/perf/lib/platform.ts`; macOS/Linux need
an implementation there (e.g. `ps`/procfs and the window server) and their own baseline file.

## 3. Baseline (windows-x64)

Committed as `apps/desktop/tests/perf/baselines/windows-x64.json` (full results; only the
`exe` path fields were rewritten to be repository-relative).

- **Machine:** AMD Ryzen 9 9900X 12-core (24 logical), 31.2 GB RAM, Windows 11 Home
  10.0.26200, WebView2 153.0.4234.48, Node 24.16.0.
- **Build:** KalCode 0.1.0, `infra/testing` branch at the "Shared contracts v1" merge
  (`04999c0`) plus test infrastructure only; e2e release build, 7,015,424-byte executable.
- **Conditions:** recorded 2026-09-24 22:47 UTC while other development worktrees were building
  and testing on the same machine: machine-wide CPU was **85.6 % busy** during the idle window.
  These numbers are therefore pessimistic; re-baseline on a quiet machine (§5) before tightening
  budgets.

| Metric | Median | p95 | Range (n) |
| --- | ---: | ---: | --- |
| Cold start → window visible | 937 ms | 1,135 ms | 711–1,155 ms (5) |
| Cold start → `window_ready` IPC | 943 ms | 1,166 ms | 710–1,191 ms (5) |
| Cold start → `DOMContentLoaded` | 883 ms | 1,085 ms | 661–1,106 ms (5) |
| Cold start → WebView navigation start | 689 ms | 944 ms | 557–992 ms (5) |
| Warm start → window visible | 877 ms | 994 ms | 702–997 ms (5) |
| Warm start → `window_ready` IPC | 904 ms | 1,007 ms | 742–1,007 ms (5) |
| Graceful shutdown | 376 ms | 559 ms | 272–615 ms (11) |
| IPC `boot` round trip | 1.6 ms | 2.1 ms | 1.2–3.4 ms (300) |
| IPC `settings_get` round trip | 2.0 ms | 4.8 ms | 1.5–78.6 ms (300) |
| IPC `events_recent` (50) round trip | 1.9 ms | 6.3 ms | 1.3–94.1 ms (300) |
| IPC `diagnostics_get` round trip | 2.3 ms | 3.8 ms | 1.4–100.9 ms (300) |
| Event append (`settings_update` + event) | 4.1 ms | 7.2 ms | 1.8–139 ms (500) |
| Event append throughput (sequential) | 185 events/s | | |
| Idle working set, app + WebView2 (7 processes) | 389 MB | | |
| Idle private bytes, app + WebView2 | 198 MB | | |
| Idle working set, `kalcode.exe` only | 31.4 MB | | |
| Idle private bytes, `kalcode.exe` only | 11.4 MB | | |
| Working set after 500 events | 453 MB | | |
| Idle CPU, app + WebView2 (30 s) | 28.7 % of one core (1.2 % of the machine) | | |
| Idle CPU, `kalcode.exe` only | 0.45 % of one core | | |
| Database after first launch | 92 KB | | |
| Database before / after 500 events (after clean shutdown) | 148 KB / 216 KB | | |

Idle breakdown by process role (same run): GPU process 20.8 % of a core / 78.8 MB, renderer
7.0 % / 84.9 MB, WebView2 browser 0.4 % / 126.5 MB, `kalcode.exe` 0.45 % / 31.3 MB, network
service 41.1 MB, storage service 18.5 MB, crashpad 18.6 MB.

Run-to-run spread on the same machine and build (three full runs within ten minutes; machine
44.5 %, 79.6 % and 85.6 % busy): cold window-visible medians 927 / 848 / 937 ms, warm 622 /
1,028 / 877 ms, event throughput 215 / 145 / 185 events/s, idle tree working set 391 / 388 /
389 MB, `settings_get` median 1.4 / 1.6 / 2.0 ms. (The first run predates detaching DevTools
during the idle window, so its idle CPU figure is not comparable.) Startup and throughput are
load-sensitive; memory and database size are stable.

### Findings from the first baseline

- **Idle rendering.** At idle the WebView2 GPU process uses ~20 % of a core and the renderer
  ~7 % while the Dashboard is visible, although the native core is idle (0.45 %). The
  Dashboard runs an infinite CSS animation — the pulsing live dot of
  `StatusIndicator pulse` in `surfaces/dashboard/RuntimeHealth.tsx` — which keeps the compositor
  producing frames. A quick experiment switching the app to reduced motion did not show a clear
  drop under the machine load at the time, so the cause is not yet confirmed. Next step: measure
  on a quiet machine with the pulse disabled. `cpu.idle.percentOfOneCore` has a 50 % budget
  until then.
- **Main-thread IPC tail.** `boot` (a synchronous command on the UI thread) and the async
  commands have ~1.5–2 ms medians but occasional 80–140 ms outliers, all under heavy machine
  load; recheck on a quiet machine before acting.
- **WebView2 dominates memory.** `kalcode.exe` is ~31 MB of the ~389 MB tree; the rest is the
  WebView2 runtime's browser, GPU, renderer and utility processes.

### Interaction latency (2026-10-02 responsiveness pass)

`apps/desktop/tests/perf/interactions.ts` (`pnpm perf:interactions [--runs 20]`) drives real
clicks and key presses over the DevTools protocol against the same e2e binary. The setup opens a
throwaway project, starts three terminals and prints about 200 KB of history into each. It
records two figures per interaction:

- **input → next paint:** the first frame after every handler ran, i.e. the acknowledgement.
- **input → visible:** the first frame in which the target state is on screen: the page
  heading, the menu, or the terminal showing its history again.

Before = `main` at `fced50d5`; after = the responsiveness pass. Both were measured on the same
machine, alternating runs, 20 samples per interaction per run, values in ms.

| Interaction (input → visible) | Before p50 / p95 | After p50 / p95 |
| --- | ---: | ---: |
| Return to Code (terminals and history back on screen) | 63 / 76–80 | 13 / 14 |
| Switch terminal tab | 47 / 51–63 | 13 / 14 |
| New terminal tab (bounded by the shell starting) | 47–105 / 115–494 | 47–130 / 97–484 |
| Open Dashboard, Settings, Threads | 12–13 / 13–16 | 12–13 / 13–14 |
| Open Account Hub, shell chooser menus | 13 / 14 | 13 / 14–21 |
| Open command palette, type in it | 8–14 / 16–28 | 8–11 / 16–21 |

The two big wins are structural:

- Code stays mounted once opened.
- Terminal tabs stay mounted once shown.

Returning to Code and switching tabs therefore no longer rebuild xterm or replay scrollback. Both
now complete within one frame (~13 ms at 75 Hz).

Many improvements in the same pass don't show in this fixture because it has no providers,
threads or agent traffic. These are covered by unit tests:

- terminals appear before the refresh
- the palette no longer re-renders the shell
- Operations polls no longer disable Refresh
- the Dashboard reuses loaded data
- slow native commands moved off the main thread

Windows only for now, like the rest of the harness. macOS needs a WebKit driver.

## 4. Budgets

`apps/desktop/tests/perf/budgets.json`. A metric fails `pnpm perf:check` when it breaks its
absolute budget, or — against the baseline for the platform — when it is worse by more than
its percentage **and** by more than its minimum delta (so tiny absolute changes on small
numbers are not failures).

| Metric | Budget | Regression limit |
| --- | --- | --- |
| Cold start → window visible / `window_ready` | ≤ 3,000 ms | +30 % and +150 ms |
| Warm start → window visible / `window_ready` | ≤ 2,000 ms | +30 % and +150 ms |
| Graceful shutdown | ≤ 3,000 ms | +50 % and +200 ms |
| IPC `boot`, `settings_get` (median) | ≤ 10 ms | +50 % and +1 ms |
| IPC `events_recent` (50), `diagnostics_get` (median) | ≤ 15 ms | +50 % and +1 ms |
| Event append round trip (median) | ≤ 20 ms | +50 % and +2 ms |
| Event append throughput | ≥ 50 events/s | −40 % and −25 events/s |
| Idle working set, app + WebView2 | ≤ 600 MB | +15 % and +30 MB |
| Idle private bytes, app + WebView2 | ≤ 350 MB | +15 % and +25 MB |
| Idle working set, `kalcode.exe` | ≤ 80 MB | +20 % and +8 MB |
| Working set after 500 events | ≤ 700 MB | +15 % and +30 MB |
| Idle CPU, app + WebView2 | ≤ 50 % of one core | +50 % and +10 points |
| Idle CPU, `kalcode.exe` | ≤ 5 % of one core | +100 % and +1 point |
| Database after first launch | ≤ 512 KB | +25 % and +16 KB |
| Executable size | ≤ 20 MB | +10 % and +256 KB |

Absolute budgets are deliberately generous so they hold on CI runners and slower machines; the
regression limits are the sensitive check, and they apply only on the machine that produced the
baseline. Tighten budgets after a quiet-machine baseline, never loosen them to pass a run —
a budget change needs a reason in the commit message.

## 5. Keeping the baseline honest

- **Refresh** after an intended performance change, a WebView2 major update or a machine
  change: build `build:e2e`, run `pnpm perf` on a quiet machine, check it with
  `pnpm perf:check`, then copy `results.json` to `apps/desktop/tests/perf/baselines/<platform>.json`
  (make the `exe` fields repository-relative) and update §3 with the machine and conditions.
- **Never** edit measured values by hand, and never baseline a run with a failed check without
  explaining why in the commit.
- **CI:** the nightly workflow (`.github/workflows/nightly.yml`) runs the harness on
  `windows-latest` after the real-app E2E suite, checks absolute budgets (`--no-baseline`:
  hosted runners are not the reference machine), writes the summary to the job page and keeps
  `results.json` as an artifact for 90 days for trend comparison.
