//! The governor's pure core: turns probe samples into snapshots, smooths, applies hysteresis,
//! detects transitions and chooses the cadence. No threads, no OS calls, no clock reads — time
//! is passed in, so every decision is reproducible in tests.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::MIB;
use crate::cadence::{Activity, CadenceConfig, TierClock};
use crate::mode::{ModeError, ModeKind, ModeLimits, ResourceMode, SignalThresholds};
use crate::model::{
    CadenceReason, CommitReading, CommitUsed, CpuReading, GpuReading, IoRate, MemoryReading,
    NetRate, PressureEntry, PressureLevel, PressureSummary, PressureTransition, ProcessTreeReading,
    Reading, ResourceKind, ResourceSnapshot, SamplingInfo, Signal, Tiers, VolumeReading,
};
use crate::pressure::{Ema, HysteresisTracker};
use crate::probe::{Counters, ProbePlan, RawSample, WorkspaceRoot};
use crate::tree::TrackedRoot;

/// Smoothing time constants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmoothingConfig {
    /// CPU is spiky: 10 s.
    pub cpu_tau: Duration,
    /// Memory exhaustion is dangerous, so memory reacts faster: 3 s.
    pub memory_tau: Duration,
}

impl Default for SmoothingConfig {
    fn default() -> Self {
        Self {
            cpu_tau: Duration::from_secs(10),
            memory_tau: Duration::from_secs(3),
        }
    }
}

/// Everything the governor needs to start.
#[derive(Debug, Clone, PartialEq)]
pub struct GovernorConfig {
    pub mode: ResourceMode,
    pub cadence: CadenceConfig,
    pub smoothing: SmoothingConfig,
    /// History ring size (default 360 points: 6 min at 1 Hz, 90 min at the idle rate).
    pub history_capacity: usize,
    /// The KalCode process (root of the owned tree). Defaults to the current process.
    pub self_pid: u32,
}

impl Default for GovernorConfig {
    fn default() -> Self {
        Self {
            mode: ResourceMode::default(),
            cadence: CadenceConfig::default(),
            smoothing: SmoothingConfig::default(),
            history_capacity: 360,
            self_pid: std::process::id(),
        }
    }
}

/// A mode change, reported so the host can emit the proposed `resource.mode_changed` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeChange {
    pub from: ModeKind,
    pub to: ModeKind,
}

/// The result of ingesting one sample.
#[derive(Debug, Clone, PartialEq)]
pub struct Ingested {
    pub snapshot: Arc<ResourceSnapshot>,
    pub transitions: Vec<PressureTransition>,
}

const NOT_SAMPLED: &str = "not sampled yet";
const WARMING_UP: &str = "warming up: needs a second measurement";

#[derive(Debug, Clone)]
struct Carried {
    commit: Reading<CommitReading>,
    network: Reading<NetRate>,
    volumes: Reading<Vec<VolumeReading>>,
    process_count: Reading<u32>,
    tree: Reading<ProcessTreeReading>,
    gpu: Reading<GpuReading>,
}

impl Default for Carried {
    fn default() -> Self {
        Self {
            commit: Reading::unknown(NOT_SAMPLED),
            network: Reading::unknown(NOT_SAMPLED),
            volumes: Reading::unknown(NOT_SAMPLED),
            process_count: Reading::unknown(NOT_SAMPLED),
            tree: Reading::unknown(NOT_SAMPLED),
            gpu: Reading::unknown(NOT_SAMPLED),
        }
    }
}

/// A rate over two counter readings taken with the governor's clock.
#[derive(Debug, Clone, Copy)]
struct RateBase {
    counters: Counters,
    at: Duration,
}

fn rate(
    base: &mut Option<RateBase>,
    reading: Reading<Counters>,
    now: Duration,
) -> Reading<(u64, u64)> {
    let counters = match reading {
        Reading::Value(counters) => counters,
        Reading::Unavailable(reason) => {
            *base = None;
            return Reading::Unavailable(reason);
        }
        Reading::Unknown(reason) => {
            *base = None;
            return Reading::Unknown(reason);
        }
    };
    let previous = base.replace(RateBase { counters, at: now });
    let Some(previous) = previous else {
        return Reading::unknown(WARMING_UP);
    };
    let dt = now.saturating_sub(previous.at).as_secs_f64();
    let comparable = previous.counters.generation == counters.generation
        && counters.a_bytes >= previous.counters.a_bytes
        && counters.b_bytes >= previous.counters.b_bytes;
    if !comparable || dt <= 0.0 {
        return Reading::unknown("devices changed; measuring again");
    }
    let per_sec = |delta: u64| (delta as f64 / dt).round() as u64;
    Reading::Value((
        per_sec(counters.a_bytes - previous.counters.a_bytes),
        per_sec(counters.b_bytes - previous.counters.b_bytes),
    ))
}

/// The pure governor core.
#[derive(Debug)]
pub struct Engine {
    cadence: CadenceConfig,
    mode: ResourceMode,
    limits: ModeLimits,
    activity: Activity,
    self_pid: u32,
    roots: Vec<TrackedRoot>,
    workspaces: Vec<WorkspaceRoot>,
    tier_clock: TierClock,
    cpu_ema: Ema,
    memory_used_ema: Ema,
    memory_available_ema: Ema,
    trackers: BTreeMap<Signal, HysteresisTracker>,
    last_levels: BTreeMap<ResourceKind, PressureLevel>,
    disk_base: Option<RateBase>,
    net_base: Option<RateBase>,
    carried: Carried,
    seq: u64,
    failures: u32,
    /// The last sample's CPU reading was the probe's first-measurement warm-up.
    cpu_warming_up: bool,
    pressure: PressureSummary,
}

impl Engine {
    pub fn new(config: &GovernorConfig) -> Result<Self, ModeError> {
        let limits = config.mode.limits()?;
        Ok(Self {
            cadence: config.cadence.sanitized(),
            mode: config.mode.clone(),
            limits,
            activity: Activity::default(),
            self_pid: config.self_pid,
            roots: Vec::new(),
            workspaces: Vec::new(),
            tier_clock: TierClock::default(),
            cpu_ema: Ema::new(config.smoothing.cpu_tau),
            memory_used_ema: Ema::new(config.smoothing.memory_tau),
            memory_available_ema: Ema::new(config.smoothing.memory_tau),
            trackers: BTreeMap::new(),
            last_levels: BTreeMap::new(),
            disk_base: None,
            net_base: None,
            carried: Carried::default(),
            seq: 0,
            failures: 0,
            cpu_warming_up: false,
            pressure: PressureSummary::default(),
        })
    }

    pub fn limits(&self) -> &ModeLimits {
        &self.limits
    }

    pub fn mode(&self) -> &ResourceMode {
        &self.mode
    }

    pub fn activity(&self) -> Activity {
        self.activity
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.failures
    }

    pub fn tracked_roots(&self) -> &[TrackedRoot] {
        &self.roots
    }

    /// Returns `true` when the activity changed.
    pub fn set_activity(&mut self, activity: Activity) -> bool {
        let changed = self.activity != activity;
        self.activity = activity;
        changed
    }

    /// Switches mode. Pressure is re-derived from the current smoothed values at the next
    /// sample (trackers restart, so a stricter or looser mode applies at once).
    pub fn set_mode(&mut self, mode: ResourceMode) -> Result<Option<ModeChange>, ModeError> {
        let limits = mode.limits()?;
        if mode == self.mode {
            return Ok(None);
        }
        let change = ModeChange {
            from: self.mode.kind(),
            to: mode.kind(),
        };
        self.mode = mode;
        self.limits = limits;
        self.trackers.clear();
        Ok(Some(change))
    }

    pub fn set_workspaces(&mut self, workspaces: Vec<WorkspaceRoot>) {
        if workspaces != self.workspaces {
            self.workspaces = workspaces;
            self.tier_clock.force_inventory();
        }
    }

    /// Registers a process KalCode started. Re-registering a pid replaces its role.
    pub fn track(&mut self, root: TrackedRoot) {
        self.roots.retain(|r| r.pid != root.pid);
        self.roots.push(root);
        self.tier_clock.force_processes();
    }

    pub fn untrack(&mut self, pid: u32) {
        self.roots.retain(|r| r.pid != pid);
    }

    /// The tiers due at `now`.
    pub fn plan_tiers(&self, now: Duration) -> Tiers {
        self.tier_clock.due(&self.cadence, now)
    }

    pub fn probe_plan(&self, tiers: Tiers) -> ProbePlan<'_> {
        ProbePlan {
            tiers,
            self_pid: self.self_pid,
            roots: &self.roots,
            workspace_roots: &self.workspaces,
        }
    }

    /// The delay until the next sample, from activity, the last pressure and failures.
    ///
    /// The one exception: after the probe's CPU warm-up sample (no CPU reading until a second
    /// measurement), the second measurement is taken at the active cadence rather than a full
    /// idle interval later, since governed work is held until it exists. Thresholds, admission
    /// and every later interval are unchanged.
    pub fn next_delay(&self) -> (Duration, CadenceReason) {
        let (delay, reason) = self
            .cadence
            .next_delay(self.activity, &self.pressure, self.failures);
        if self.cpu_warming_up && self.failures == 0 && self.cadence.active < delay {
            return (self.cadence.active, CadenceReason::WarmingUp);
        }
        (delay, reason)
    }

    /// Ingests a probe sample taken at `now` (monotonic) / `unix_ms` (wall clock).
    pub fn ingest(
        &mut self,
        tiers: Tiers,
        raw: RawSample,
        now: Duration,
        unix_ms: i64,
    ) -> Ingested {
        self.tier_clock.ran(tiers, now);
        self.seq += 1;

        let cpu = match raw.cpu {
            Reading::Value(raw_cpu) => {
                let smoothed = self.cpu_ema.update(f64::from(raw_cpu.total_percent), now);
                Reading::Value(CpuReading {
                    total_percent: raw_cpu.total_percent,
                    smoothed_percent: smoothed as f32,
                    logical_cores: raw_cpu.logical_cores,
                })
            }
            other => without_value(other),
        };

        if let Some(commit) = raw.commit {
            self.carried.commit = commit;
        }
        let memory = match raw.memory {
            Reading::Value(raw_memory) => {
                let total = raw_memory.total_bytes.max(1);
                let available = raw_memory.available_bytes.min(total);
                let used = total - available;
                let used_percent = used as f64 * 100.0 / total as f64;
                let smoothed_used = self.memory_used_ema.update(used_percent, now);
                let smoothed_available = self.memory_available_ema.update(available as f64, now);
                Reading::Value(MemoryReading {
                    total_bytes: total,
                    available_bytes: available,
                    used_bytes: used,
                    used_percent: used_percent as f32,
                    smoothed_used_percent: smoothed_used as f32,
                    smoothed_available_bytes: smoothed_available.max(0.0) as u64,
                    commit: self.carried.commit.clone(),
                })
            }
            other => without_value(other),
        };

        let disk_io = rate(&mut self.disk_base, raw.disk_io, now).map(|(read, write)| IoRate {
            read_bytes_per_sec: read,
            write_bytes_per_sec: write,
        });
        if let Some(network) = raw.network {
            self.carried.network = rate(&mut self.net_base, network, now).map(|(rx, tx)| NetRate {
                rx_bytes_per_sec: rx,
                tx_bytes_per_sec: tx,
            });
        }
        if let Some(volumes) = raw.volumes {
            self.carried.volumes = volumes;
        }
        if let Some(processes) = raw.processes {
            match processes {
                Reading::Value(processes) => {
                    self.roots
                        .retain(|r| !processes.vanished_roots.contains(&r.pid));
                    self.carried.process_count = Reading::Value(processes.count);
                    self.carried.tree = Reading::Value(processes.tree);
                }
                other => {
                    self.carried.process_count = without_value(other.clone());
                    self.carried.tree = without_value(other);
                }
            }
        }
        if let Some(gpu) = raw.gpu {
            self.carried.gpu = gpu;
        }

        self.cpu_warming_up = matches!(&cpu, Reading::Unknown(reason) if reason == WARMING_UP);
        let hard_failure = !cpu.is_value()
            && !memory.is_value()
            && !matches!(&cpu, Reading::Unknown(reason) if reason == WARMING_UP);
        self.failures = if hard_failure {
            self.failures.saturating_add(1)
        } else {
            0
        };

        let pressure = self.evaluate(now, &cpu, &memory);
        let transitions = self.transitions(&pressure, unix_ms);
        self.pressure = pressure.clone();
        let (next, reason) = self.next_delay();

        let snapshot = ResourceSnapshot {
            seq: self.seq,
            sampled_at_unix_ms: unix_ms,
            mode: self.limits.kind,
            cpu,
            memory,
            volumes: self.carried.volumes.clone(),
            disk_io,
            network: self.carried.network.clone(),
            process_count: self.carried.process_count.clone(),
            kalcode_tree: self.carried.tree.clone(),
            gpu: self.carried.gpu.clone(),
            pressure,
            sampling: SamplingInfo {
                refreshed: tiers,
                next_interval_ms: u64::try_from(next.as_millis()).unwrap_or(u64::MAX),
                reason,
                consecutive_failures: self.failures,
            },
        };
        Ingested {
            snapshot: Arc::new(snapshot),
            transitions,
        }
    }

    /// Records a sample that failed outright (the probe panicked). Everything is reported
    /// `Unknown`, rates restart, and the cadence backs off. No transition is emitted: pressure is
    /// unknown, not normal.
    pub fn ingest_failure(&mut self, unix_ms: i64, reason: &str) -> Ingested {
        self.seq += 1;
        self.failures = self.failures.saturating_add(1);
        self.cpu_warming_up = false;
        self.disk_base = None;
        self.net_base = None;
        let mut snapshot = ResourceSnapshot::unknown(reason, self.limits.kind);
        snapshot.seq = self.seq;
        snapshot.sampled_at_unix_ms = unix_ms;
        self.pressure = snapshot.pressure.clone();
        let (next, cadence_reason) = self.next_delay();
        snapshot.sampling = SamplingInfo {
            refreshed: Tiers::default(),
            next_interval_ms: u64::try_from(next.as_millis()).unwrap_or(u64::MAX),
            reason: cadence_reason,
            consecutive_failures: self.failures,
        };
        Ingested {
            snapshot: Arc::new(snapshot),
            transitions: Vec::new(),
        }
    }

    fn track_signal(
        &mut self,
        signal: Signal,
        value: f64,
        thresholds: SignalThresholds,
        now: Duration,
    ) -> PressureEntry {
        let dwell = self.limits.min_dwell;
        let level =
            self.trackers
                .entry(signal.clone())
                .or_default()
                .update(value, &thresholds, dwell, now);
        PressureEntry {
            resource: signal.resource(),
            level,
            threshold: thresholds.threshold(level),
            approaching: thresholds.approaching(value, level),
            signal,
            value,
        }
    }

    fn evaluate(
        &mut self,
        now: Duration,
        cpu: &Reading<CpuReading>,
        memory: &Reading<MemoryReading>,
    ) -> PressureSummary {
        let limits = self.limits.clone();
        let mut entries = Vec::new();
        let mut unknown = Vec::new();

        match cpu.value() {
            Some(cpu) => {
                entries.push(self.track_signal(
                    Signal::CpuPercent,
                    f64::from(cpu.smoothed_percent),
                    limits.cpu,
                    now,
                ));
            }
            None => unknown.push(ResourceKind::Cpu),
        }

        match memory.value() {
            Some(memory) => {
                let mut signals = vec![
                    self.track_signal(
                        Signal::MemoryUsedPercent,
                        f64::from(memory.smoothed_used_percent),
                        limits.memory_used_percent,
                        now,
                    ),
                    self.track_signal(
                        Signal::MemoryAvailableMb,
                        memory.smoothed_available_bytes as f64 / MIB as f64,
                        limits.memory_available_mb,
                        now,
                    ),
                ];
                if let Some(CommitReading {
                    limit_bytes,
                    used: CommitUsed::Exact(used),
                }) = memory.commit.value()
                    && *limit_bytes > 0
                {
                    let percent = *used as f64 * 100.0 / *limit_bytes as f64;
                    signals.push(self.track_signal(
                        Signal::CommitPercent,
                        percent,
                        limits.commit_percent,
                        now,
                    ));
                }
                entries.extend(worst(signals));
            }
            None => unknown.push(ResourceKind::Memory),
        }

        let volumes = self.carried.volumes.clone();
        match volumes.value() {
            Some(volumes) => {
                let mounts: Vec<&str> = volumes.iter().map(|v| v.mount.as_str()).collect();
                self.trackers.retain(|signal, _| match signal {
                    Signal::DiskFreeMb { mount } => mounts.contains(&mount.as_str()),
                    _ => true,
                });
                let signals: Vec<PressureEntry> = volumes
                    .iter()
                    .map(|v| {
                        self.track_signal(
                            Signal::DiskFreeMb {
                                mount: v.mount.clone(),
                            },
                            v.free_bytes as f64 / MIB as f64,
                            limits.disk_free_mb,
                            now,
                        )
                    })
                    .collect();
                entries.extend(worst(signals));
            }
            None => unknown.push(ResourceKind::DiskSpace),
        }

        PressureSummary { entries, unknown }
    }

    fn transitions(&mut self, pressure: &PressureSummary, unix_ms: i64) -> Vec<PressureTransition> {
        let mut out = Vec::new();
        for entry in &pressure.entries {
            let previous = self
                .last_levels
                .insert(entry.resource, entry.level)
                .unwrap_or(PressureLevel::Normal);
            if previous != entry.level {
                out.push(PressureTransition {
                    resource: entry.resource,
                    from: previous,
                    to: entry.level,
                    mode: self.limits.kind,
                    signal: entry.signal.clone(),
                    value: entry.value,
                    threshold: entry.threshold,
                    seq: self.seq,
                    at_unix_ms: unix_ms,
                });
            }
        }
        out
    }
}

/// The worst entry of one resource (first wins on ties); `approaching` if any signal is.
fn worst(signals: Vec<PressureEntry>) -> Option<PressureEntry> {
    let approaching = signals.iter().any(|s| s.approaching);
    let mut best: Option<PressureEntry> = None;
    for signal in signals {
        if best.as_ref().is_none_or(|b| signal.level > b.level) {
            best = Some(signal);
        }
    }
    best.map(|mut entry| {
        entry.approaching = approaching;
        entry
    })
}

/// Carries an `Unavailable`/`Unknown` reading over to another value type.
fn without_value<T, U>(reading: Reading<T>) -> Reading<U> {
    match reading {
        Reading::Unavailable(reason) => Reading::Unavailable(reason),
        Reading::Unknown(reason) => Reading::Unknown(reason),
        Reading::Value(_) => Reading::unknown("internal: value not carried"),
    }
}

#[cfg(test)]
mod tests;
