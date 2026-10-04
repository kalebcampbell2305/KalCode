# Workspace Resource Governor
Status: **P0 built — crate only (`crates/resources`, `kalcode_resources`), not wired into the app.**
No IPC, settings UI, events or Scheduler holds exist yet. Plan and acceptance criteria:
`docs/campaigns/ADVANCED.md` §7.19; campaign record, overhead evidence and open items:
`docs/campaigns/RG.md`; proposed types, events, IPC and tables: `docs/CONTRACTS_ADVANCED.md` §6.8
(PROPOSED, pending lead approval).

System code **RG** · Phase **P0 (sampler) — built** · P2 (settings UI) · P4 (scheduler holds)

Low-overhead monitoring of CPU, RAM, disk space and IO, network, process count, and KalCode's own
process tree (provider CLIs and terminals), with pressure levels and an advisory capacity answer
for the future Scheduler. It is **advisory only**: it never kills, suspends or re-prioritises a
process, and nothing in the crate could.

## What exists (P0)

| Piece | Where | What it does |
| --- | --- | --- |
| Probe seam | `probe.rs` (`SystemProbe`, `SysinfoProbe`) | The only code that touches the OS. Built on `sysinfo` 0.37 (`system`, `disk`, `network` features; no `multithread` pool, no WMI sensors). Collects executable names, parent ids, CPU and resident memory — never command lines or environments. |
| Process tree | `tree.rs` (`build_tree`, pure) | KalCode's pid and its descendants plus registered roots (`track_process(pid, role)`); a process takes the role of its nearest registered ancestor (`Provider`, `Terminal`, else `Descendant`). Stale parent links after pid reuse are rejected by start time; exited roots are untracked automatically. Capped at 512 listed processes (totals cover all). |
| Engine | `engine.rs` (`Engine`, pure) | Turns samples into `ResourceSnapshot`s: time-based smoothing, hysteresis, pressure transitions, carried-forward slow tiers, rates from counters with the governor's clock. Time is always passed in. |
| Cadence | `cadence.rs` (pure) | Adaptive interval and tier scheduling. |
| Modes | `mode.rs` | Conservative / Balanced / Performance / Custom, resolved to `ModeLimits` (thresholds below). The mode is a setting, not a permission. |
| Capacity | `capacity.rs` (`capacity()`, pure) | How many more agent tasks could start now, and the typed reasons that would hold the next one. |
| Proposals | `intervene.rs` (`propose()`, pure) | Explanations only ("this provider session uses 3 GB; closing it would free memory — KalCode will not close it for you"). |
| Governor | `governor.rs` (`Governor`, `GovernorHandle`) | One background thread `kalcode-resources`; non-blocking handle; subscriber stream; bounded in-memory history. |

Readings are `Reading::Value`, `Unavailable` (the platform or build does not expose it — permanent)
or `Unknown` (not sampled yet, warming up, or failed). Nothing is guessed.

| Metric | Windows | Notes |
| --- | --- | --- |
| CPU total | PDH `% Idle Time` via sysinfo | Average over the sampling interval; the first sample is `Unknown` (warming up). |
| Physical memory | `GlobalMemoryStatusEx` | Used / available / total, smoothed. |
| Commit | `GetPerformanceInfo` via sysinfo swap counters | Exact only once commit exceeds physical memory (the counters clamp below that); otherwise reported as an upper bound and not used for pressure. `Unavailable` on macOS/Linux. |
| Disk free per workspace volume | `GetDiskFreeSpaceEx` | Longest mount-point match for each registered root (`set_workspaces`); a root on no fixed local volume is `Unknown`. |
| Disk IO rate | `IOCTL_DISK_PERFORMANCE` per fixed volume | Summed; a device-set change restarts the measurement instead of reporting a burst. |
| Network rate | `GetIfTable2` via sysinfo | Loopback skipped; filter-driver interfaces that mirror a physical interface's counters are counted once. |
| Process count, KalCode tree CPU/RSS | Toolhelp snapshot + per-process times/working set | The costliest call (see cadence). Per-process CPU is `None` on first sight. sysinfo keeps one query handle per process open between refreshes (~+410 handles on a 450-process machine). |
| GPU / VRAM | — | **`Unavailable`**: there is no documented, low-cost, vendor-neutral API this crate can call without new unsafe code (Windows' PDH "GPU Engine"/"GPU Adapter Memory" counters need an audited FFI site). GPU limits in Custom mode are therefore not applied, and capacity says so. |

## Cadence (RG-02)

| State | Interval | Why |
| --- | --- | --- |
| Idle (no active tasks, no view open, no pressure developing) | **15 s** (floor 10 s) | Lead brief: ≥ 10–15 s when idle. |
| Pressure developing (a governed resource above Normal, or within its approach margin of Elevated) | **5 s** (0.2 Hz, floor 2 s) | Watch without polling. |
| Agent work running, or a resource view open | **1 s** (1 Hz, floor 1 s) | RG-02. Hosts must report hidden views as closed. |
| Samples failing | base × 2ⁿ, capped at 60 s | Backoff; reason `Backoff`. |

Tiers: the **fast tier** (CPU, physical memory, disk IO counters) runs every sample; the **slow
tier** (commit, network, volume free space) at most every **5 s**; the **process tier** (process
snapshot: count and KalCode tree) at most every **10 s** (floor 5 s) — it is the costliest call,
and registering a process makes it due at the next sample; volumes and interfaces are
re-enumerated every 5 min or when workspace roots change. Activity and
mode changes wake the sampler at once; floors are enforced by `CadenceConfig::sanitized()`.

Smoothing is time-based (`α = 1 − e^(−Δt/τ)`), so it is independent of the sampling rate: CPU
τ = 10 s, memory τ = 3 s. Disk free space and commit are not smoothed.

## Pressure thresholds

Levels: NORMAL < ELEVATED < HIGH < CRITICAL. A level is entered as soon as the smoothed value
crosses its enter threshold; it is left only when the value is back past the threshold by the
exit margin **and** the level has been held for **20 s**. A mode change re-derives levels at an
immediate re-sample. Governed resources: CPU, Memory (worst of used %, available MiB, exact
commit %), Disk space (worst workspace volume). Disk IO, network, process count and GPU are
reported, not governed.

| Signal (enter thresholds Elevated / High / Critical) | Conservative | Balanced | Performance | Custom | Exit margin | Approach margin |
| --- | --- | --- | --- | --- | --- | --- |
| CPU, smoothed % | 50 / 70 / 90 | 65 / 85 / 95 | 80 / 92 / 98 | from target T: max(T−10, 10) / min(T+10, 97) / min(max(High+5, 90), 99) | 7 pts | 10 pts |
| Memory used, smoothed % | 70 / 80 / 90 | 80 / 88 / 94 | 85 / 92 / 96 | Balanced's | 3 pts | 5 pts |
| Memory available, smoothed MiB (lower is worse) | 4096 / 2048 / 1024 | 2048 / 1024 / 512 | 1536 / 768 / 384 | from reserve R: 2R / R / R/2 | 256 (Custom: max(R/8, 128)) | 1024 (Custom: R) |
| Commit, % of limit (exact only) | 85 / 92 / 97 | same | same | same | 3 pts | 5 pts |
| Workspace volume free, MiB (lower is worse) | 20 480 / 10 240 / 4096 | 10 240 / 5120 / 2048 | 5120 / 2048 / 1024 | from D: 2D / D / D/2 | 512 (Custom: max(D/10, 256)) | 5120 / 5120 / 2560 (Custom: D) |

## Capacity (advisory API for the Scheduler)

`capacity(snapshot, limits, running, request) -> CapacityAdvice` is pure and deterministic. It
evaluates, in a fixed order, and returns `additional` = the minimum over:

| Constraint | Allows | Mode values (C / B / P) |
| --- | --- | --- |
| `UserLimit` — max simultaneous agents | `max_agents − running` | No preset count ceiling; explicit Custom 1–64 |
| `ProviderLimit` — per provider (Custom) | `limit − running(provider)` | Custom only, 0–64 |
| `Pressure` — any governed resource at High/Critical | 0 | all modes |
| `Pressure` — at Elevated | the elevated allowance | 0 / 1 / no extra limit; Custom 1 |
| `CpuHeadroom` | ⌊(target − smoothed CPU) / per-agent CPU⌋ | target 60 / 75 / 90 %; Custom = max CPU %. Per agent 0.5 core. |
| `MemoryHeadroom` | ⌊(smoothed available − reserve) / per-agent MiB⌋ | reserve 4096 / 2048 / 1024 MiB; Custom = min available. Per agent max(512 MiB, observed average of live provider sessions). |
| `KalCodeMemoryCap` | ⌊(cap − tree RSS) / per-agent MiB⌋ | 25 / 50 / 75 % of physical; Custom optional MiB |
| `GpuLimit` | 0 when reached | Custom only, **applied only where GPU is measured** (never in this build; a note says so) |

`holds` lists every constraint that allows exactly `additional` — what would hold task
`additional + 1` — each with its metric, threshold and mode (SCH-08). **Unknown data never
produces a resource hold**: the matching constraint is skipped, `data` is `Partial`/`NoData` and a
`MetricUnknown` note is added; count limits still apply. `GovernorHandle::capacity()` uses the
latest snapshot, or an all-unknown one before the first sample.

## Admission by priority (owner directive 2026-10-04)

The governor protects system responsiveness without becoming an artificial agent limit.
Priority, throttled from the bottom: KalCode UI, user-requested coding agents, builds/tests the
user started, important active services, optional background work, indexing/maintenance.

| Work | Function | Held by |
| --- | --- | --- |
| User-requested coding agent — any provider, any launch path (pane, New agent, KalVoice, user-initiated Squad or Handoff); its launch and each turn | `evaluate_user_agent_admission` (`admission.rs`), desktop `ResourceGovernorState::reserve_provider_task` | **Only** genuine hard pressure on a current sample (`hard.rs`) or an explicit Custom count limit. Never CPU utilisation, CPU/memory headroom, pressure levels, KalCode's memory share, or missing/stale telemetry. |
| Optional background work (local model inference and acquisition) | `evaluate_admission` + capacity projection, `reserve_local_task` | Fail-closed: every capacity constraint above, current telemetry, and the unmeasured budgets of agents that just started. It yields first. |

Hard pressure (`hard.rs`), the only machine condition that delays a user-requested agent:

| Condition | Threshold |
| --- | --- |
| Memory critically low | latest **and** smoothed available memory below max(512 MiB, 2 % of physical), capped at 1536 MiB (`memory_floor_mib`) |
| Commit exhausted (Windows, exact commit only) | commit limit − exact commit charge below the same floor |
| Disk effectively full | KalCode's data volume or the launching workspace's volume below 1024 MiB free |
| OS refused to create the process | spawn failed with an exhaustion OS error (Windows 8, 14, 1450, 1455; Unix EAGAIN/ENOMEM), detected at spawn by the desktop admission wrapper |

A held launch is `waiting_for_dependency` (display WAITING, never IDLE) with the real reason
("Waiting to start: memory is critically low (412 MB free)"), re-checked on the sampler's
cadence for up to `ADMISSION_WAIT_LIMIT`, and offers **Run KalTidy** and **Start Anyway**.
Start Anyway (`thread_start_anyway`) grants that one thread a 120 s override in the governor and
re-checks its launch immediately (or resumes it if the wait already ran out).

## Failure isolation (§11)

- The probe runs on the governor thread only; handle methods take one short lock (no I/O under
  it). A slow probe never delays a caller (tested with a 1.5 s probe: 100 calls < 200 ms).
- A probe panic is caught (`catch_unwind`), the sample is reported `Unknown`, the cadence backs
  off; after 5 consecutive panics the governor stops sampling (`Failed`) and readers keep getting
  `Unknown` with count-only capacity. **Release builds use `panic = "abort"`**, where
  `catch_unwind` cannot help: there, isolation relies on panic-free code (the crate denies
  `unwrap`/`expect` outside tests). See `docs/campaigns/RG.md` open items.
- If the thread cannot start, the handle is `Failed` and behaves as above.
- Subscribers get a bounded `sync_channel`; a full buffer drops updates (counted) instead of
  slowing the sampler; `recent_transitions()` keeps the last 64 transitions for catch-up.
- History is an in-memory ring (default 360 points); nothing is persisted, no table, no migration.

## Boundaries

User-requested coding agents are held only as described in "Admission by priority"; optional
background work is fail-closed. It **never** terminates or suspends user processes;
suggestions go through the Utility Dock's process control (explain, ask, Trust Kernel). A test
(`tests/never_acts.rs`) fails if the crate's source ever calls a process-control API.

## Events

Planned, not emitted yet (the crate reports; the host emits once CA-0 lands):
`resource.pressure_changed` and `resource.mode_changed` on transitions only; samples stream on a
channel and are never events. Task hold/release events belong to the Scheduler (P4). Placement:
Settings → Resources (P2), plus a Command Center panel (P5).

## Measured overhead

See `docs/campaigns/RG.md` § Overhead for the method and numbers on the reference machine.
