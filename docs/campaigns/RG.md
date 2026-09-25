# Campaign RG — Workspace Resource Governor, P0 (sampler)

Branch `adv/resources` (from main `47aee0e`), worktree `.worktrees/adv-resources`. Scope: a new
crate `crates/resources` (`kalcode_resources`) — sampling, pressure, the advisory capacity API.
Crate only: no IPC, UI, settings, events, tables or migration. Design and thresholds:
`docs/RESOURCE_GOVERNOR.md`. Plan rows: `docs/campaigns/ADVANCED.md` §7.19, §10, §11.

Criteria are PASS only when executed. **PENDING-INTEGRATION** means the crate side is done and
tested, and the row needs host wiring (P2 IPC/settings, P4 Scheduler) to be verified end to end.

## Acceptance matrix

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| RG-01 | Samples CPU, RAM, GPU/VRAM (where exposed, else "not available"), disk IO and free space per workspace volume, network throughput, process count, provider/terminal process trees | PASS (crate) | `tests/real_probe.rs` on this machine: memory, commit, volume, process count, own tree (role `KalCodeSelf`, RSS > 0, CPU `None` on first sight then measured), CPU after warm-up; GPU = `Unavailable` with a reason. Tree roles/sessions/pid-reuse/cycles/truncation: `tree.rs` tests. Rates, device changes, counter resets: `engine::tests::rates_need_two_samples_and_restart_when_devices_change`. |
| RG-02 | Adaptive sampling: slow when idle, 1 Hz while tasks run or a resource view is open; ≤ 1 % of one core at 1 Hz | PASS | Cadence with an injected clock: `engine::tests::adaptive_interval_follows_activity_pressure_and_failures`, `cadence::tests::*`, `slow_tier_runs_at_most_every_five_seconds_at_1_hz`; wake-up on activity: `governor::tests::activity_change_wakes_an_idle_sampler`. Overhead: § Overhead — **0.29 % of one core at 1 Hz**, ≤ 0.37 % in every phase. **Deviation, by the lead's brief:** idle is 15 s (RG-02 says 0.2 Hz); 0.2 Hz is used while pressure develops. |
| RG-03 | Modes Conservative / Balanced / Performance / Custom set pressure thresholds and max concurrent sessions; the mode is a setting | PASS (crate) · PENDING-INTEGRATION (setting + UI, P2) | `mode::tests::*` (ordering, formulas, validation); capacity across all four modes: `tests/advisory.rs`; mode change re-derives levels: `engine::tests::mode_change_re_evaluates_thresholds_at_the_next_sample`, `governor::tests::mode_change_resamples_at_once_and_notifies_subscribers`. |
| RG-04 | Pressure transitions emit `resource.pressure_changed`; samples stream on channels, never events | PASS (crate: transitions only, one per level change, no flapping) · PENDING-INTEGRATION (event variant, CA-0) | `engine::tests::hysteresis_through_the_engine_rises_and_falls_without_flapping` (exact path N→E→H→C→H→E→N under a scripted load with a 50/70 % oscillation), `startup_under_pressure_reports_a_transition_from_normal`, `unknown_readings_are_listed_and_never_emit_transitions`; subscriber stream: `governor::tests::*`. |
| RG-05 | Feeds SCH hold reasons (P4); before that warns and never blocks | PASS (crate: typed `HoldReason`s with metric, threshold, mode) · PENDING-INTEGRATION (thread-creation warning, P2; SCH, P4) | `tests/advisory.rs` (12 tests: exact numbers per mode, pressure levels, headroom, per-provider, unknown data, observed agent memory, GPU, determinism); callers never wait: `governor::tests::callers_never_wait_for_a_slow_probe`. |
| RG-06 | Never terminates or suspends user processes; suggestions only | PASS | `tests/never_acts.rs` (source scan for process-control APIs); `intervene` proposals carry `requires_user: true` and an explanation: `tests/advisory.rs::proposals_explain_and_never_act`. |
| X-05 | Failure isolation: a failing subsystem leaves callers working | PASS (crate) · see open item 1 | Probe panic → `Unknown` + backoff → `Failed` after 5, callers unaffected: `governor::tests::a_panicking_probe_degrades_then_stops_without_affecting_callers`, `a_transient_panic_recovers`; unknown → count-only capacity: `tests/advisory.rs::unknown_data_falls_back_to_count_limits_only`; engine: `failed_samples_report_unknown_back_off_and_recover`; prompt shutdown: `shutdown_is_prompt_during_an_idle_wait`. |
| X-08 | §10 budget on the reference machine | PASS (CPU, memory) · **FAIL** (process list at 1,000 processes: 86.6 ms mean on a loaded machine) | § Overhead; open item 2 |
| X-10 | Branding, zero-cost, capability checks; review | PASS (checks) · review pending | § Verification; open item 7. |

## Overhead

Method: `crates/resources/examples/overhead.rs` runs the **real** governor (real probe, real
clock, Balanced mode, one workspace root registered) in a separate release-built process and
prints the sampler's own statistics. CPU time (`TotalProcessorTime`), working set, private bytes
and handle count of that process were read **from outside** with PowerShell after a 20 s warm-up,
over 180 s per phase, so the measurement itself adds nothing:

```powershell
$p = Start-Process overhead.exe -ArgumentList $phase, 210 -PassThru -NoNewWindow
Start-Sleep 20; $p.Refresh(); $t0 = $p.TotalProcessorTime; $w0 = Get-Date
# every 10 s for 180 s: $p.Refresh(); record WorkingSet64, PrivateMemorySize64, HandleCount
$cpu = ($p.TotalProcessorTime - $t0).TotalMilliseconds / ((Get-Date) - $w0).TotalMilliseconds * 100
```

Machine: the performance baseline machine (`docs/PERFORMANCE.md` §3: Ryzen 9 9900X, 24 logical,
31.2 GB, Windows 11 26200). **Not quiet:** other worktrees were building and testing throughout;
machine-wide CPU (the governor's own smoothed reading) averaged 41–73 % per phase. Numbers are
therefore pessimistic, like the §3 baseline. Measured 2026-09-24.

Final build (process tier ≤ every 10 s, slow tier ≤ every 5 s):

| Phase | Cadence actually used | Samples (process-tier) in 210 s | CPU, % of one core | Working set | Private bytes | Handles |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Baseline (same binary, no governor) | — | — | 0.000 | 8.0 MB | 1.2 MB | 120 |
| `idle` — no activity | 15 s, 5 s while the busy machine read as "pressure developing" (Idle 18 / Developing 24 of 42 checks) | 30 (18) | **0.32** | 14.4 MB | 6.1 MB | 542 |
| `idle15` — watch rate pinned to 15 s | 15 s | 15 (15) | **0.37** | 13.5 MB | 6.0 MB | 559 |
| `active` — one agent task, 1 Hz | 1 s | 208 (21) | **0.29** | 13.5 MB | 6.1 MB | 508 |

Sampler cost, therefore: **≤ 0.37 % of one core** in every phase (≈ 0.015 % of this 24-thread
machine), **+5.5 MB working set / +4.9 MB private bytes**, and **+~420 handles** (sysinfo keeps
a query handle per process). Per sample that ran the process tier, CPU was ≈ 40–50 ms on this
loaded machine (≈ 16 ms measured on the same machine when it was calmer), the rest of a sample
well under 1 ms (CPU counter, memory, disk IO) plus ≈ 3 ms for network enumeration.

First build, for the record (process snapshot in the 5 s slow tier): `idle` 0.73 % (the busy
machine kept it at the 5 s watch rate), `active` 0.95 % of one core — inside the 1 % budget but
with no margin, which is why the process snapshot got its own 10 s tier.

| §10 budget | Result | Verdict |
| --- | --- | --- |
| RG: ≤ 1 % of one core at 1 Hz | 0.29 % (active, 1 Hz, busy machine) | **PASS** |
| Global: idle `kalcode.exe` ≤ 5 % of one core; background samplers pause with hidden views | Adds ≤ 0.37 % to the 0.45 % baseline; cadence falls to 15 s when nothing runs and no view is open | **PASS** |
| Global: idle working set within `docs/PERFORMANCE.md` §4 (`kalcode.exe` ≤ 80 MB, baseline 31.4 MB) | +5.5 MB → ≈ 37 MB | **PASS** (to re-measure in the app at P2 wiring) |
| RG: process list ≤ 50 ms for 1,000 processes | 1,013 processes (570 sleeper children added): **mean 86.6 ms, max 134.6 ms** wall per process-tier sample; first sample 605 ms (opens a handle per new process); tree capped at 512 listed | **FAIL on this loaded machine** — off the UI thread and at most every 10 s, but over budget; see open item 2 |

No sample failed in any run (`failedSamples: 0`); status stayed `Running`.

## Verification

Run on this worktree, 2026-09-24:

| Gate | Result |
| --- | --- |
| `cargo fmt --all -- --check` | pass (inside `pnpm check`) |
| `cargo clippy --workspace --all-targets -- -D warnings` | pass (inside `pnpm check`; also `-p kalcode-resources`) |
| `cargo test --workspace` | pass; `kalcode-resources`: 53 unit + 12 advisory + 1 never-acts + 2 real-probe tests |
| `pnpm check` (format, lint, typecheck, all JS and Rust tests, branding, capabilities, zero-cost) | **exit 0** |
| `cargo deny check` | advisories ok, bans ok, licenses ok, sources ok (duplicate-version warnings pre-existing; this crate adds no duplicate) |
| Branding / zero-cost | pass (502 files / 170 product files) |

## Decisions

- **`sysinfo` 0.37.2**, features `system`, `disk`, `network` only. Justification: MIT, widely used,
  maintained; 0.37 is the newest line whose MSRV (1.88) fits the workspace's 1.89 and whose
  `windows` range unifies with the 0.61 copy Tauri already brings — it adds only `sysinfo`,
  `ntapi` (Windows) and `objc2-io-kit` (macOS) to the lock file and no second `windows` crate.
  `multithread` (a rayon pool) and `component` (WMI/COM sensors) are off. `cargo deny check`:
  advisories, bans, licenses and sources ok. Bump to 0.39 when the workspace MSRV reaches 1.95.
- **GPU is `Unavailable`**, not estimated: no low-cost, vendor-neutral API is reachable without
  a new audited `unsafe` site (the workspace allows exactly one). The seam (`SystemProbe`,
  `GpuReading`) and the capacity logic for GPU limits are ready for a future probe.
- **Tiered sampling.** Measured on this machine, one process snapshot (all processes, CPU +
  memory) costs ~16 ms of CPU when calm and 40–50 ms when busy; network interface enumeration
  ~3 ms; the CPU counter, memory and disk IO well under 1 ms. So commit, network and free space
  form a slow tier (≤ every 5 s) and the process snapshot its own tier (≤ every 10 s), even at
  1 Hz. The first build put the snapshot in the 5 s tier and measured 0.95 % of one core at
  1 Hz; the split brought it to 0.29 %.
- **Hysteresis** is margin + 20 s dwell for falling, immediate for rising; smoothing is
  time-based so the same thresholds behave alike at 15 s and 1 s intervals.
- **No persistence.** History is a 360-point in-memory ring; no table, no migration.

## Contract and event requests (for the lead, CA-0)

These are needed before the host can wire RG; the crate keeps its own types until then and the
host maps them (the crate never edits `crates/contracts`).

1. **`resources.rs` types** (`CONTRACTS_ADVANCED.md` §6.8), amended from what was built:
   - `GovernorMode { Conservative, Balanced, Performance, Custom }` plus
     `CustomResourceLimits { maxCpuPercent: u8, maxKalcodeMemoryMb: Option<u64>,
     minAvailableMemoryMb: u64, minDiskFreeMb: u64, maxAgents: u32,
     perProvider: BTreeMap<ProviderId, u32>, gpu: { maxUtilizationPercent: Option<u8>,
     maxVramMb: Option<u64> } }` — replaces the proposed `GovernorThresholds` (users set targets;
     thresholds derive from them, see `RESOURCE_GOVERNOR.md`).
   - `ResourceSnapshot`: metrics as a tagged reading `{ state: value | unavailable | unknown,
     detail }` instead of bare numbers/`Option` (an `Option` cannot distinguish "not exposed"
     from "failed"); add `memoryCommit { limitMb, used: exact | at_most }`, per-volume
     `{ mount, workspaceIds, totalMb, freeMb }`, the KalCode tree (`ProcessInfo`-like rows with a
     role and root pid, plus per-provider-session totals), `processCount`, and
     `sampling { refreshed tiers, nextIntervalMs, reason, consecutiveFailures }`.
   - `ResourcePressure { resource, level, signal, value, threshold, approaching }`.
   - `CapacityAdvice { mode, additional, holds, constraints, perProvider, data, notes }` and
     `ResourceHoldReason` (`user_limit`, `provider_limit`, `pressure`, `cpu_headroom`,
     `memory_headroom`, `kalcode_memory_cap`, `gpu_limit`). SCH's
     `SchedulerReason::ResourcePressure` should carry a `ResourceHoldReason` rather than only
     `{ resource, level, mode }`, so a held task shows the metric and threshold (SCH-08);
     `ProviderConcurrency` already covers `provider_limit`.
2. **Events** (all `version: 1`, transitions only, short facts):
   - `resource.pressure_changed { resource, from, to, mode, signal, value, threshold }` —
     proposed payload plus the last three optional facts (numbers only, no content).
   - `resource.mode_changed { from, to }` — as proposed.
   - `resource.task_held { taskId, reasons: ResourceHoldReason[], mode }` and
     `resource.task_released { taskId, heldMs, cause: pressure_cleared | limit_freed | override }`
     — emitted by the Scheduler in P4 (source `core`) when a task is held or released for
     resource reasons. Before P4 nothing is held; the thread-creation warning (RG-05) is UI
     state, not an event, so no per-thread warning floods the log.
3. **IPC** (P2): `resource_snapshot`, `resource_subscribe` (channel), `resource_mode_get` /
   `resource_mode_set` (as proposed), plus `resource_capacity { provider? } → CapacityAdvice` and
   `resource_history { limit ≤ 500 } → HistoryPoint[]`.
4. **Settings**: `resources.mode` + custom limits in the settings store (a setting, not a
   permission); feature flag `ResourceGovernor` (already in the proposed flag list).
5. **Host wiring notes** (P2): start with `Governor::start(config)` behind the
   `Option<Arc<…>>` seam; call `set_workspaces` with workspace roots and the data folder,
   `track_process` when provider CLIs and shells start, `set_activity` from the thread runtime
   and from resource-view visibility; map `GovernorUpdate::PressureChanged` / `ModeChanged` to
   events (persist, then publish).
6. **Architecture doc**: add `crates/resources/` — `kalcode_resources`: resource sampling,
   pressure and advisory capacity — to `docs/ARCHITECTURE.md` §2 at merge (left to the lead to
   avoid layout conflicts with other P0 crates).

## Open items

1. **`panic = "abort"` in release.** The workspace's release profile aborts on panic, so the
   governor's `catch_unwind` guard protects debug/test builds only. In the shipped binary a
   panic inside `sysinfo` (its Windows CPU code has an `expect`) would take the app down. Our own
   code has no `unwrap`/`expect`/`panic` outside tests (clippy `-D warnings`). Options for the
   lead: accept (sysinfo's panics are on invariant paths), run the probe in a helper process, or
   use `panic = "unwind"` for release. Security/QA should include this in the X-05 fault review.
2. **Process list over budget at 1,000 processes (86.6 ms mean, loaded machine).** The cost is
   sysinfo's Toolhelp snapshot plus one open handle and three calls per process. A native
   enumerator (one `NtQuerySystemInformation(SystemProcessInformation)` call: pids, parents,
   CPU times and working sets without per-process handles) behind the existing `SystemProbe`
   seam would fix both the time and the ~420 held handles, but needs a new audited `unsafe`
   site (the workspace allows one). Lead decision; re-measure on a quiet machine first.
3. **GPU/VRAM** stay `Unavailable` until a probe is approved (same audited-FFI question: PDH
   "GPU Engine"/"GPU Adapter Memory" counters on Windows).
4. **RG-02 wording**: the plan row says 0.2 Hz idle; the lead's brief asked for ≥ 10–15 s idle.
   Built: 15 s idle, 0.2 Hz while pressure develops, 1 Hz with work or an open view. Update
   the plan row at merge.
5. **Commit below physical memory** is an upper bound only (sysinfo clamps the counters); exact
   commit would come with item 2's native call.
6. **Quiet-machine re-measurement** of all overhead numbers before P2 wiring, then add an RG
   metric to `apps/desktop/tests/perf` when the governor runs inside the app.
7. **Review**: independent code and security review not yet done (X-10).
