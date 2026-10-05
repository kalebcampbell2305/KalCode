//! Workspace Resource Governor (RG) wire types. Adopted in CA-1 from
//! `docs/CONTRACTS_ADVANCED.md` §6.8 as amended by `docs/campaigns/RG.md`: users set targets
//! (`CustomResourceLimits`), metrics are tagged readings that distinguish "not exposed" from
//! "failed", and every hold names its metric and threshold. `kalcode_resources` re-exports these.
//!
//! Float fields: these types derive `PartialEq` without `Eq`. Samples stream on channels and are
//! never events; only transitions are (`resource.*`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::ProviderId;

/// The selected resource mode, without its custom limits (events, snapshots, hold reasons).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum GovernorMode {
    Conservative,
    Balanced,
    Performance,
    Custom,
}

/// User-set targets for `Custom` mode (replaces the proposal's `GovernorThresholds`; thresholds
/// derive from these, see `docs/RESOURCE_GOVERNOR.md`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CustomResourceLimits {
    /// Machine CPU use (percent) above which new agent work is held. 20–100.
    pub max_cpu_percent: u8,
    /// Most memory the KalCode process tree (agents included) should use, MiB. `None` = no cap.
    pub max_kalcode_memory_mb: Option<u64>,
    /// Physical memory to keep available for everything else, MiB. 256–262,144.
    pub min_available_memory_mb: u64,
    /// Free space to keep on workspace volumes, MiB. 256–1,048,576.
    pub min_disk_free_mb: u64,
    /// Most simultaneous agent tasks. 1–64.
    pub max_agents: u32,
    /// Most simultaneous tasks per provider (0 = do not start tasks for that provider). ≤ 64.
    pub per_provider: BTreeMap<ProviderId, u32>,
    pub gpu: GpuLimits,
}

impl Default for CustomResourceLimits {
    /// Balanced's values, as a starting point for the settings UI.
    fn default() -> Self {
        Self {
            max_cpu_percent: 75,
            max_kalcode_memory_mb: None,
            min_available_memory_mb: 2048,
            min_disk_free_mb: 5120,
            max_agents: 4,
            per_provider: BTreeMap::new(),
            gpu: GpuLimits::default(),
        }
    }
}

/// An out-of-range custom limit.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ResourceLimitError {
    #[error("invalid custom resource limit {field}: {reason}")]
    Invalid { field: &'static str, reason: String },
}

fn range(field: &'static str, value: u64, min: u64, max: u64) -> Result<(), ResourceLimitError> {
    if (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(ResourceLimitError::Invalid {
            field,
            reason: format!("{value} is outside {min}–{max}"),
        })
    }
}

impl CustomResourceLimits {
    pub fn validate(&self) -> Result<(), ResourceLimitError> {
        range("maxCpuPercent", u64::from(self.max_cpu_percent), 20, 100)?;
        range("maxAgents", u64::from(self.max_agents), 1, 64)?;
        range(
            "minAvailableMemoryMb",
            self.min_available_memory_mb,
            256,
            262_144,
        )?;
        range("minDiskFreeMb", self.min_disk_free_mb, 256, 1_048_576)?;
        if let Some(cap) = self.max_kalcode_memory_mb {
            range("maxKalcodeMemoryMb", cap, 512, 4_194_304)?;
        }
        for limit in self.per_provider.values() {
            range("perProvider", u64::from(*limit), 0, 64)?;
        }
        if self
            .per_provider
            .keys()
            .any(|provider| provider.as_str().is_empty())
        {
            return Err(ResourceLimitError::Invalid {
                field: "perProvider",
                reason: "provider ids must not be empty".into(),
            });
        }
        if let Some(percent) = self.gpu.max_utilization_percent {
            range("gpu.maxUtilizationPercent", u64::from(percent), 1, 100)?;
        }
        if let Some(vram) = self.gpu.max_vram_mb {
            range("gpu.maxVramMb", vram, 256, 1_048_576)?;
        }
        Ok(())
    }
}

/// GPU limits. Applied only where GPU metrics are measured; otherwise capacity says so in a note
/// instead of pretending to enforce them.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GpuLimits {
    pub max_utilization_percent: Option<u8>,
    pub max_vram_mb: Option<u64>,
}

impl GpuLimits {
    pub fn is_set(&self) -> bool {
        self.max_utilization_percent.is_some() || self.max_vram_mb.is_some()
    }
}

/// A value that may not be known. Nothing guesses: a metric is measured, permanently not exposed
/// by the platform, or temporarily unknown. Wire: `{ "state": "value" | "unavailable" |
/// "unknown", "detail": … }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "state", content = "detail", rename_all = "snake_case")]
#[ts(export)]
pub enum Reading<T> {
    /// Measured.
    Value(T),
    /// The platform (or this build) does not expose the metric at an acceptable cost. Permanent
    /// for the lifetime of the process; the string explains why, in user-safe words.
    Unavailable(String),
    /// Not measured right now: not sampled yet, warming up, or the sample failed.
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

/// Resources the governor reports on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
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
/// Exported to TypeScript as `PressureSignal`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(
    tag = "signal",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export, rename = "PressureSignal")]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ResourcePressure {
    pub resource: ResourceKind,
    pub level: PressureLevel,
    /// The signal that holds the resource at `level` (the worst of its signals).
    pub signal: Signal,
    /// The signal's current (smoothed) value.
    pub value: f64,
    /// The threshold that was crossed to reach `level`; `None` at `Normal`.
    pub threshold: Option<f64>,
    /// Within the approach margin of the next level up: the sampler speeds up.
    pub approaching: bool,
}

/// Pressure across the governed resources (CPU, memory, disk space).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PressureSummary {
    /// Known levels, one entry per governed resource with data, in `ResourceKind` order.
    pub entries: Vec<ResourcePressure>,
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

    pub fn entry(&self, resource: ResourceKind) -> Option<&ResourcePressure> {
        self.entries.iter().find(|entry| entry.resource == resource)
    }

    /// Pressure is developing: some resource is above `Normal` or approaching `Elevated`.
    pub fn developing(&self) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.level > PressureLevel::Normal || entry.approaching)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CpuReading {
    /// Total CPU use of the machine over the last sampling interval, percent (0–100).
    pub total_percent: f32,
    /// Exponentially smoothed `total_percent`.
    pub smoothed_percent: f32,
    pub logical_cores: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommitReading {
    pub limit_bytes: u64,
    pub used: CommitUsed,
}

/// The commit charge is exact only once it exceeds physical memory; below that only an upper
/// bound is known. Pressure uses exact values only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "bytes", rename_all = "snake_case")]
#[ts(export)]
pub enum CommitUsed {
    Exact(u64),
    AtMost(u64),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IoRate {
    pub read_bytes_per_sec: u64,
    pub write_bytes_per_sec: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NetRate {
    pub rx_bytes_per_sec: u64,
    pub tx_bytes_per_sec: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GpuReading {
    pub utilization_percent: Reading<f32>,
    pub vram_used_bytes: Reading<u64>,
    pub vram_total_bytes: Reading<u64>,
}

/// What a KalCode-owned process is. Descendants inherit the nearest registered ancestor's role.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ProcessRole {
    /// The KalCode process itself.
    #[serde(rename = "kalcode_self")]
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrackedProcess {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub role: ProcessRole,
    /// CPU use over the last process refresh as percent of the whole machine (0–100).
    pub cpu_percent: Option<f32>,
    /// Resident set (working set on Windows), bytes.
    pub rss_bytes: u64,
    /// The pid of the registered root this process belongs to (itself for a root).
    pub root_pid: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProcessTreeReading {
    /// Sorted by pid, capped; see `truncated`.
    pub processes: Vec<TrackedProcess>,
    pub truncated: bool,
    /// Sum over the tree, percent of the whole machine.
    pub total_cpu_percent: f32,
    pub total_rss_bytes: u64,
    /// Registered provider sessions that are alive, with their subtree totals.
    pub provider_sessions: Vec<SessionUsage>,
}

/// Aggregate usage of one registered root and its descendants.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionUsage {
    pub root_pid: u32,
    pub role: ProcessRole,
    pub processes: u32,
    pub cpu_percent: f32,
    pub rss_bytes: u64,
}

/// Why the sampler ran at its current rate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CadenceReason {
    Idle,
    PressureDeveloping,
    ActiveWork,
    ResourceViewOpen,
    Backoff,
    /// The CPU needs a second measurement before it has a reading; it is taken promptly.
    WarmingUp,
}

/// Which tiers a sample refreshed. Slow tiers are carried forward between refreshes.
/// Exported to TypeScript as `SamplingTiers`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "SamplingTiers")]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SamplingInfo {
    pub refreshed: Tiers,
    /// Delay chosen until the next sample, milliseconds.
    pub next_interval_ms: u64,
    pub reason: CadenceReason,
    /// Consecutive failed samples (0 when healthy).
    pub consecutive_failures: u32,
}

/// One sample, with slow tiers carried forward and pressure evaluated under the current mode.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ResourceSnapshot {
    /// Monotonic sample number (starts at 1).
    pub seq: u64,
    /// Wall-clock time of the sample, Unix milliseconds (UTC).
    pub sampled_at_unix_ms: i64,
    pub mode: GovernorMode,
    pub cpu: Reading<CpuReading>,
    pub memory: Reading<MemoryReading>,
    /// Volumes holding registered workspace roots. `Value([])` when no root is registered.
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
    pub fn unknown(reason: &str, mode: GovernorMode) -> Self {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum GpuMetric {
    UtilizationPercent,
    VramMb,
}

/// Why a task would be held. Every variant carries the metric, the limit and the mode, so a held
/// task can show exactly what holds it (SCH-08).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ResourceHoldReason {
    /// The mode's maximum simultaneous agents.
    UserLimit {
        running: u32,
        limit: u32,
        mode: GovernorMode,
    },
    /// The per-provider limit (Custom mode).
    ProviderLimit {
        provider: ProviderId,
        running: u32,
        limit: u32,
    },
    /// A governed resource is under pressure.
    Pressure {
        resource: ResourceKind,
        level: PressureLevel,
        mode: GovernorMode,
        signal: Signal,
        value: f64,
        threshold: Option<f64>,
    },
    /// Starting more would push projected machine CPU past the mode's target.
    CpuHeadroom {
        cpu_percent: f64,
        target_percent: f64,
        per_agent_percent: f64,
        mode: GovernorMode,
    },
    /// Starting more would eat into the memory the mode keeps free.
    MemoryHeadroom {
        available_mb: u64,
        reserve_mb: u64,
        per_agent_mb: u64,
        mode: GovernorMode,
    },
    /// Starting more would take KalCode's process tree past its memory cap.
    #[serde(rename = "kalcode_memory_cap")]
    KalCodeMemoryCap {
        used_mb: u64,
        cap_mb: u64,
        per_agent_mb: u64,
        mode: GovernorMode,
    },
    /// A configured GPU limit is reached (only where GPU metrics are measured).
    GpuLimit {
        metric: GpuMetric,
        value: f64,
        limit: f64,
    },
}

/// One evaluated constraint and how many more tasks it allows. Exported to TypeScript as
/// `CapacityConstraint`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "CapacityConstraint")]
pub struct Constraint {
    pub reason: ResourceHoldReason,
    pub allows: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderCapacity {
    pub provider: ProviderId,
    pub running: u32,
    pub limit: u32,
    /// `limit − running`, before other constraints.
    pub remaining: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum DataQuality {
    /// CPU, memory and disk space are all measured.
    Complete,
    /// Some governed resources are unknown; their constraints were skipped.
    Partial { unknown: Vec<ResourceKind> },
    /// Nothing is measured: only count limits apply.
    NoData,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum CapacityNote {
    /// The resource's metric is unknown right now; no hold was derived from it.
    MetricUnknown { resource: ResourceKind },
    /// GPU limits are configured but GPU metrics are not measured here: they are not applied.
    GpuLimitsNotApplied { reason: String },
    /// The per-agent memory estimate came from live provider sessions instead of the default.
    ObservedAgentMemory { per_agent_mb: u64, sessions: u32 },
    /// The snapshot's pressure levels were computed under another mode.
    PressureFromOtherMode { snapshot_mode: GovernorMode },
}

/// The advisory answer to "how many more agent tasks could start now". Never blocks by itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CapacityAdvice {
    pub mode: GovernorMode,
    /// How many more agent tasks could start now (for the requested provider, when given).
    pub additional: u32,
    /// The constraints that bind (they allow exactly `additional`). Never empty.
    pub holds: Vec<ResourceHoldReason>,
    /// Every constraint evaluated, in a fixed order.
    pub constraints: Vec<Constraint>,
    /// Remaining room under each configured per-provider limit.
    pub per_provider: Vec<ProviderCapacity>,
    pub data: DataQuality,
    pub notes: Vec<CapacityNote>,
}

/// Why a held task was released (`resource.task_released`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ResourceReleaseCause {
    PressureCleared,
    LimitFreed,
    Override,
}

/// Why the Resource Governor is holding one **user-requested** coding-agent launch, as the thread
/// runtime explains it.
///
/// Owner directive (2026-10-04): the governor protects system responsiveness without becoming an
/// artificial agent limit. A user-requested agent is never held because CPU is busy, because a
/// soft memory reserve is reached, or because resource telemetry is late; optional background
/// work is throttled for those instead. Only genuine hard pressure (critically low memory, a full
/// disk, the OS refusing another process) or a count limit the person set explicitly in Custom
/// mode may hold one, and every hold offers Start Anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LaunchHoldKind {
    /// Available memory (or the Windows commit limit) is below the hard floor: starting another
    /// process risks the system running out of memory.
    MemoryCritical,
    /// The KalCode data volume or the workspace's volume is effectively full.
    DiskFull,
    /// The operating system refused to create another process.
    ProcessLimit,
    /// The explicit Custom-mode maximum of simultaneously running agents is reached.
    ConcurrencyLimit,
    /// The explicit Custom-mode limit for this provider is reached.
    ProviderLimit,
}

impl LaunchHoldKind {
    /// Precedence when a decision has several reasons: genuine hard pressure first (it is what
    /// actually stops the launch), then the person's own count limits.
    pub const PRECEDENCE: [LaunchHoldKind; 5] = [
        Self::MemoryCritical,
        Self::DiskFull,
        Self::ProcessLimit,
        Self::ConcurrencyLimit,
        Self::ProviderLimit,
    ];

    /// A stable, log-friendly code.
    pub fn code(self) -> &'static str {
        match self {
            Self::MemoryCritical => "memory_critical",
            Self::DiskFull => "disk_full",
            Self::ProcessLimit => "process_limit",
            Self::ConcurrencyLimit => "concurrency_limit",
            Self::ProviderLimit => "provider_limit",
        }
    }

    /// The real reason as a short sentence-case phrase, e.g. "memory is critically low".
    pub fn phrase(self) -> &'static str {
        match self {
            Self::MemoryCritical => "memory is critically low",
            Self::DiskFull => "the disk is almost full",
            Self::ProcessLimit => "the system couldn't create another process",
            Self::ConcurrencyLimit => "your Custom agent limit is reached",
            Self::ProviderLimit => "your Custom limit for this provider is reached",
        }
    }

    /// Stopping another running thread would free this hold.
    pub fn freed_by_stopping_a_thread(self) -> bool {
        matches!(self, Self::ConcurrencyLimit | Self::ProviderLimit)
    }

    /// Genuine machine pressure that KalTidy (closing idle processes, freeing space) can relieve.
    pub fn is_hard_pressure(self) -> bool {
        matches!(
            self,
            Self::MemoryCritical | Self::DiskFull | Self::ProcessLimit
        )
    }
}

/// A user-requested provider launch the Resource Governor held before any provider process
/// started.
///
/// `retry_after` follows the governor's own sampling cadence (a new decision needs a new sample)
/// and `wait_limit` bounds how long a launch may wait in total. Both are chosen by the governor
/// owner, never by the thread runtime. The person can always skip the wait with Start Anyway.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchHold {
    pub kind: LaunchHoldKind,
    /// For count limits: the work running now and the limit (for "4 of 4 agents").
    pub running: Option<u32>,
    pub limit: Option<u32>,
    /// For memory and disk holds: MiB free now and the hard floor it fell under.
    pub free_mb: Option<u64>,
    pub floor_mb: Option<u64>,
    pub retry_after: std::time::Duration,
    pub wait_limit: std::time::Duration,
}

impl LaunchHold {
    /// A hold without numeric evidence (a refused process creation).
    pub fn new(
        kind: LaunchHoldKind,
        retry_after: std::time::Duration,
        wait_limit: std::time::Duration,
    ) -> Self {
        Self {
            kind,
            running: None,
            limit: None,
            free_mb: None,
            floor_mb: None,
            retry_after,
            wait_limit,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readings_are_tagged_values() {
        assert_eq!(
            serde_json::to_value(Reading::Value(3_u32)).expect("json"),
            serde_json::json!({"state": "value", "detail": 3})
        );
        assert_eq!(
            serde_json::to_value(Reading::<u32>::unavailable("no gpu")).expect("json"),
            serde_json::json!({"state": "unavailable", "detail": "no gpu"})
        );
        assert_eq!(Reading::Value(2).map(|v| v * 2).value(), Some(&4));
    }

    #[test]
    fn hold_reasons_use_the_documented_wire_names() {
        let hold = ResourceHoldReason::KalCodeMemoryCap {
            used_mb: 1,
            cap_mb: 2,
            per_agent_mb: 3,
            mode: GovernorMode::Balanced,
        };
        let json = serde_json::to_value(&hold).expect("json");
        assert_eq!(json["kind"], "kalcode_memory_cap");
        assert_eq!(json["perAgentMb"], 3);
        let role = serde_json::to_value(ProcessRole::KalCodeSelf).expect("json");
        assert_eq!(role, serde_json::json!({"kind": "kalcode_self"}));
    }

    #[test]
    fn custom_limits_validate_ranges() {
        let mut limits = CustomResourceLimits::default();
        assert!(limits.validate().is_ok());
        limits.max_cpu_percent = 10;
        assert!(limits.validate().is_err());
        limits.max_cpu_percent = 80;
        limits.per_provider.insert(ProviderId::new(""), 1);
        assert!(limits.validate().is_err());
    }

    #[test]
    fn unknown_snapshot_knows_nothing() {
        let snapshot = ResourceSnapshot::unknown("not sampled yet", GovernorMode::Balanced);
        assert!(!snapshot.cpu.is_value());
        assert_eq!(snapshot.pressure.overall(), None);
        assert!(snapshot.provider_session_counts().is_empty());
    }
}
