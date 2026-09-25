//! Snapshot and reading types.
//!
//! These are crate-local shapes. The proposed contract types (`docs/CONTRACTS_ADVANCED.md` §6.8,
//! `ResourceSnapshot`, `ResourcePressure`, …) are produced from them by the host once the lead
//! lands them in `crates/contracts` (CA-0); this crate never edits contracts.

use std::collections::BTreeMap;

use kalcode_contracts::agent::ProviderId;
use serde::{Deserialize, Serialize};

/// One mebibyte, the unit used by every `*_mb` field and threshold.
pub const MIB: u64 = 1024 * 1024;

/// Converts bytes to whole mebibytes (rounded down).
pub const fn bytes_to_mib(bytes: u64) -> u64 {
    bytes / MIB
}

/// A value that may not be known. Nothing in this crate guesses: a metric is either measured,
/// permanently not exposed by the platform, or temporarily unknown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", content = "detail", rename_all = "snake_case")]
pub enum Reading<T> {
    /// Measured.
    Value(T),
    /// The platform (or this build) does not expose the metric at an acceptable cost. Permanent
    /// for the lifetime of the process; the string explains why, in user-safe words.
    Unavailable(String),
    /// Not measured right now: not sampled yet, warming up (rates need two samples), or the
    /// sample failed. The string says which.
    Unknown(String),
}

impl<T> Reading<T> {
    pub fn value(&self) -> Option<&T> {
        match self {
            Reading::Value(value) => Some(value),
            Reading::Unavailable(_) | Reading::Unknown(_) => None,
        }
    }

    pub fn is_value(&self) -> bool {
        matches!(self, Reading::Value(_))
    }

    pub fn map<U>(self, f: impl FnOnce(T) -> U) -> Reading<U> {
        match self {
            Reading::Value(value) => Reading::Value(f(value)),
            Reading::Unavailable(reason) => Reading::Unavailable(reason),
            Reading::Unknown(reason) => Reading::Unknown(reason),
        }
    }

    pub fn as_ref(&self) -> Reading<&T> {
        match self {
            Reading::Value(value) => Reading::Value(value),
            Reading::Unavailable(reason) => Reading::Unavailable(reason.clone()),
            Reading::Unknown(reason) => Reading::Unknown(reason.clone()),
        }
    }

    pub fn unknown(reason: impl Into<String>) -> Self {
        Reading::Unknown(reason.into())
    }

    pub fn unavailable(reason: impl Into<String>) -> Self {
        Reading::Unavailable(reason.into())
    }
}

/// Resources the governor reports on. Mirrors the proposed contract `ResourceKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Cpu,
    Memory,
    Gpu,
    Vram,
    DiskIo,
    DiskSpace,
    Network,
    ProcessCount,
}

/// Pressure levels, ordered: `Normal < Elevated < High < Critical`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PressureLevel {
    Normal,
    Elevated,
    High,
    Critical,
}

impl PressureLevel {
    pub const ALL: [PressureLevel; 4] = [
        PressureLevel::Normal,
        PressureLevel::Elevated,
        PressureLevel::High,
        PressureLevel::Critical,
    ];
}

/// The signal behind a pressure level, so every hold can name its metric and threshold.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(
    tag = "signal",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Signal {
    /// Smoothed total CPU use of the machine, percent.
    CpuPercent,
    /// Smoothed physical memory in use, percent of total.
    MemoryUsedPercent,
    /// Smoothed available physical memory, MiB (lower is worse).
    MemoryAvailableMb,
    /// Committed memory, percent of the commit limit (Windows only).
    CommitPercent,
    /// Free space on a workspace volume, MiB (lower is worse).
    DiskFreeMb { mount: String },
}

impl Signal {
    pub fn resource(&self) -> ResourceKind {
        match self {
            Signal::CpuPercent => ResourceKind::Cpu,
            Signal::MemoryUsedPercent | Signal::MemoryAvailableMb | Signal::CommitPercent => {
                ResourceKind::Memory
            }
            Signal::DiskFreeMb { .. } => ResourceKind::DiskSpace,
        }
    }
}

/// The current level of one governed resource and the signal that decided it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PressureEntry {
    pub resource: ResourceKind,
    pub level: PressureLevel,
    /// The signal that holds the resource at `level` (the worst of its signals).
    pub signal: Signal,
    /// The signal's current (smoothed) value.
    pub value: f64,
    /// The threshold that was crossed to reach `level`; `None` at `Normal`.
    pub threshold: Option<f64>,
    /// True when the value is within the approach margin of the next level up: the sampler
    /// speeds up while pressure develops.
    pub approaching: bool,
}

/// Pressure across the governed resources (CPU, memory, disk space). Disk IO, network, process
/// count and GPU are reported but not governed in P0: they have no meaningful capacity limit, or
/// (GPU) no low-cost measurement.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PressureSummary {
    /// Known levels, one entry per governed resource with data, in `ResourceKind` order.
    pub entries: Vec<PressureEntry>,
    /// Governed resources without data right now (their level is unknown, not `Normal`).
    pub unknown: Vec<ResourceKind>,
}

impl PressureSummary {
    /// The worst known level, or `None` when nothing is known.
    pub fn overall(&self) -> Option<PressureLevel> {
        self.entries.iter().map(|entry| entry.level).max()
    }

    pub fn level(&self, resource: ResourceKind) -> Option<PressureLevel> {
        self.entry(resource).map(|entry| entry.level)
    }

    pub fn entry(&self, resource: ResourceKind) -> Option<&PressureEntry> {
        self.entries.iter().find(|entry| entry.resource == resource)
    }

    /// Pressure is developing: some resource is above `Normal` or approaching `Elevated`.
    pub fn developing(&self) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.level > PressureLevel::Normal || entry.approaching)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuReading {
    /// Total CPU use of the machine over the last sampling interval, percent (0–100).
    pub total_percent: f32,
    /// Exponentially smoothed `total_percent` (time constant in `SmoothingConfig`).
    pub smoothed_percent: f32,
    pub logical_cores: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReading {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
    pub used_percent: f32,
    pub smoothed_used_percent: f32,
    pub smoothed_available_bytes: u64,
    /// Committed memory (Windows). `Unavailable` elsewhere.
    pub commit: Reading<CommitReading>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitReading {
    pub limit_bytes: u64,
    /// Exact commit charge when the platform numbers allow it to be derived exactly.
    pub used: CommitUsed,
}

/// Windows exposes commit through counters that clamp at the size of physical memory, so the
/// commit charge is exact only once it exceeds physical memory; below that only an upper bound
/// is known. Pressure uses exact values only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "bytes", rename_all = "snake_case")]
pub enum CommitUsed {
    Exact(u64),
    AtMost(u64),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeReading {
    /// Mount point of the volume (for example `C:\`).
    pub mount: String,
    /// Workspaces whose root lives on this volume (`None` = a registered non-workspace root,
    /// such as KalCode's data folder).
    pub workspace_ids: Vec<Option<String>>,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

/// A throughput rate measured between two samples.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IoRate {
    pub read_bytes_per_sec: u64,
    pub write_bytes_per_sec: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetRate {
    pub rx_bytes_per_sec: u64,
    pub tx_bytes_per_sec: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuReading {
    pub utilization_percent: Reading<f32>,
    pub vram_used_bytes: Reading<u64>,
    pub vram_total_bytes: Reading<u64>,
}

/// What a KalCode-owned process is. Roles are assigned by the host when it registers a process
/// it started (`GovernorHandle::track_process`); descendants inherit the nearest registered
/// ancestor's role.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ProcessRole {
    /// The KalCode process itself.
    KalCodeSelf,
    /// A provider CLI session (and everything it started).
    Provider {
        provider: ProviderId,
        thread_id: Option<String>,
    },
    /// A terminal shell (and everything it started).
    Terminal { terminal_id: String },
    /// A descendant of KalCode that no registered root claims (for example the WebView runtime).
    Descendant,
}

impl ProcessRole {
    pub fn provider(&self) -> Option<&ProviderId> {
        match self {
            ProcessRole::Provider { provider, .. } => Some(provider),
            _ => None,
        }
    }
}

/// One process of the KalCode-owned tree. Only the executable name is collected — never the
/// command line or environment, which can carry secrets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedProcess {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub role: ProcessRole,
    /// CPU use over the last process refresh as percent of the whole machine (0–100). `None`
    /// the first time a process is seen (CPU use needs two measurements).
    pub cpu_percent: Option<f32>,
    /// Resident set (working set on Windows), bytes.
    pub rss_bytes: u64,
    /// The pid of the registered root this process belongs to (itself for a root).
    pub root_pid: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessTreeReading {
    /// Sorted by pid. Capped at `MAX_TREE_PROCESSES`; see `truncated`.
    pub processes: Vec<TrackedProcess>,
    pub truncated: bool,
    /// Sum over the tree, percent of the whole machine.
    pub total_cpu_percent: f32,
    pub total_rss_bytes: u64,
    /// Registered provider sessions that are alive, with their subtree totals.
    pub provider_sessions: Vec<SessionUsage>,
}

/// Aggregate usage of one registered root and its descendants.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub root_pid: u32,
    pub role: ProcessRole,
    pub processes: u32,
    pub cpu_percent: f32,
    pub rss_bytes: u64,
}

/// At most this many processes are listed in a tree reading.
pub const MAX_TREE_PROCESSES: usize = 512;

/// Why the sampler ran at its current rate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CadenceReason {
    /// Nothing is running and no pressure is developing.
    Idle,
    /// A resource is above `Normal` or approaching `Elevated`.
    PressureDeveloping,
    /// KalCode has active agent work.
    ActiveWork,
    /// A resource view (Settings → Resources, Command Center panel, process monitor) is open.
    ResourceViewOpen,
    /// Samples are failing; the interval backs off.
    Backoff,
}

/// Which tiers a sample refreshed. Slow tiers are carried forward between refreshes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tiers {
    /// CPU total, physical memory, disk IO counters.
    pub fast: bool,
    /// Commit, network, workspace volume free space.
    pub slow: bool,
    /// Process count and the KalCode process tree (the costliest measurement).
    pub processes: bool,
    /// Re-enumerating volumes and network interfaces.
    pub inventory: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplingInfo {
    pub refreshed: Tiers,
    /// Delay chosen until the next sample, milliseconds.
    pub next_interval_ms: u64,
    pub reason: CadenceReason,
    /// Consecutive failed samples (0 when healthy).
    pub consecutive_failures: u32,
}

/// One sample, with slow tiers carried forward and pressure evaluated under the current mode.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    /// Monotonic sample number (starts at 1).
    pub seq: u64,
    /// Wall-clock time of the sample, Unix milliseconds (UTC).
    pub sampled_at_unix_ms: i64,
    pub mode: crate::mode::ModeKind,
    pub cpu: Reading<CpuReading>,
    pub memory: Reading<MemoryReading>,
    /// Volumes holding registered workspace roots. `Value(vec![])` when no root is registered.
    pub volumes: Reading<Vec<VolumeReading>>,
    pub disk_io: Reading<IoRate>,
    pub network: Reading<NetRate>,
    pub process_count: Reading<u32>,
    pub kalcode_tree: Reading<ProcessTreeReading>,
    pub gpu: Reading<GpuReading>,
    pub pressure: PressureSummary,
    pub sampling: SamplingInfo,
}

impl ResourceSnapshot {
    /// A snapshot that knows nothing: what callers get before the first sample or when the
    /// sampler is not running. Capacity decisions over it apply count limits only.
    pub fn unknown(reason: &str, mode: crate::mode::ModeKind) -> Self {
        Self {
            seq: 0,
            sampled_at_unix_ms: 0,
            mode,
            cpu: Reading::unknown(reason),
            memory: Reading::unknown(reason),
            volumes: Reading::unknown(reason),
            disk_io: Reading::unknown(reason),
            network: Reading::unknown(reason),
            process_count: Reading::unknown(reason),
            kalcode_tree: Reading::unknown(reason),
            gpu: Reading::unknown(reason),
            pressure: PressureSummary {
                entries: Vec::new(),
                unknown: vec![
                    ResourceKind::Cpu,
                    ResourceKind::Memory,
                    ResourceKind::DiskSpace,
                ],
            },
            sampling: SamplingInfo {
                refreshed: Tiers::default(),
                next_interval_ms: 0,
                reason: CadenceReason::Idle,
                consecutive_failures: 0,
            },
        }
    }

    /// Registered provider sessions per provider, from the tree reading (empty when unknown).
    pub fn provider_session_counts(&self) -> BTreeMap<ProviderId, u32> {
        let mut counts = BTreeMap::new();
        if let Some(tree) = self.kalcode_tree.value() {
            for session in &tree.provider_sessions {
                if let Some(provider) = session.role.provider() {
                    *counts.entry(provider.clone()).or_insert(0) += 1;
                }
            }
        }
        counts
    }
}

/// A pressure level change. The host maps it to the proposed `resource.pressure_changed` event
/// (transitions only; samples are never events).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PressureTransition {
    pub resource: ResourceKind,
    pub from: PressureLevel,
    pub to: PressureLevel,
    pub mode: crate::mode::ModeKind,
    pub signal: Signal,
    pub value: f64,
    pub threshold: Option<f64>,
    pub seq: u64,
    pub at_unix_ms: i64,
}
