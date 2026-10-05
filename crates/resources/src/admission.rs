//! Admission decisions for work that consumes meaningful machine resources.
//!
//! Two policies, by priority (owner directive 2026-10-04: throttle from the bottom):
//!
//! - **User-requested coding agents** ([`evaluate_user_agent_admission`]) start immediately
//!   whenever the OS can reasonably run them. CPU utilisation, soft memory reserves, elevated
//!   pressure levels and missing or late telemetry never delay them. Only genuine hard pressure
//!   ([`crate::hard`]) or an explicit Custom-mode count limit the person set may hold one, and
//!   the person can always choose Start Anyway.
//! - **Optional background work** ([`evaluate_admission`]: local model acquisition and inference,
//!   heavy maintenance) is fail-closed and yields first: it waits for CPU and memory headroom,
//!   calm pressure levels and current telemetry.
//!
//! This module is pure. It never starts, stops, suspends, or reprioritises work. Local UI,
//! account/auth, and recovery paths must not call it.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use kalcode_contracts::resources::{LaunchHold, LaunchHoldKind};

use crate::cadence::CadenceConfig;
use crate::capacity::{
    CapacityAdvice, CapacityRequest, HoldReason, RunningWork, count_constraints,
};
use crate::governor::GovernorStatus;
use crate::hard::{HardPressure, hard_pressure};
use crate::mode::{ModeKind, ModeLimits};
use crate::model::{
    CpuReading, GpuReading, MemoryReading, Reading, ResourceKind, ResourceSnapshot, VolumeReading,
};

/// The shortest and longest interval for which a successful sample remains usable for admission.
pub const MIN_ADMISSION_SAMPLE_AGE: Duration = Duration::from_secs(5);
pub const MAX_ADMISSION_SAMPLE_AGE: Duration = Duration::from_secs(45);
const FRESHNESS_INTERVALS: u64 = 3;

/// A held launch is re-checked no faster than the sampler's active floor: admission reads only
/// the latest sample, so a faster poll would re-read the same evidence.
pub const ADMISSION_RETRY_MIN: Duration = CadenceConfig::ACTIVE_FLOOR;
/// ...and no slower than the default watch cadence, so a waiting launch notices a freed slot or
/// a recovered sampler within one watch interval even while the sampler idles at 15 s.
pub const ADMISSION_RETRY_MAX: Duration = Duration::from_secs(5);
/// How long a held user-requested launch waits in total (only genuine hard pressure or an
/// explicit Custom count limit holds one) before it ends as "resources unavailable" and can be
/// resumed: two full freshness windows, long enough for memory or disk to be freed, without
/// leaving a thread waiting indefinitely. Start Anyway skips the wait at any time.
pub const ADMISSION_WAIT_LIMIT: Duration =
    Duration::from_secs(MAX_ADMISSION_SAMPLE_AGE.as_secs() * 2);

/// Sensors a class of newly-started work requires.
///
/// Ordinary provider CLIs require CPU and memory only. A background indexer can additionally
/// require workspace disk telemetry; a GPU workload can explicitly require GPU telemetry.
/// Unsupported optional GPU data therefore never blocks an ordinary provider launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionRequirements {
    pub cpu: bool,
    pub memory: bool,
    pub disk_space: bool,
    pub gpu: bool,
}

impl AdmissionRequirements {
    pub const fn provider_task() -> Self {
        Self {
            cpu: true,
            memory: true,
            disk_space: false,
            gpu: false,
        }
    }

    pub const fn background_heavy() -> Self {
        Self {
            cpu: true,
            memory: true,
            disk_space: true,
            gpu: false,
        }
    }

    pub const fn gpu_heavy() -> Self {
        Self {
            cpu: true,
            memory: true,
            disk_space: true,
            gpu: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionState {
    Allowed,
    Held,
}

/// Why new governed work is held. Reasons are deterministic and safe to show to the owner.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AdmissionReason {
    GovernorNotReady {
        status: GovernorStatus,
    },
    SnapshotMissing,
    SnapshotFromFuture {
        sampled_at_unix_ms: i64,
    },
    SnapshotStale {
        age_ms: u64,
        max_age_ms: u64,
    },
    SnapshotModeMismatch {
        snapshot_mode: ModeKind,
        active_mode: ModeKind,
    },
    RequiredTelemetryUnknown {
        resource: ResourceKind,
        detail: String,
    },
    RequiredTelemetryUnavailable {
        resource: ResourceKind,
        detail: String,
    },
    CapacityUnavailable,
    Capacity {
        holds: Vec<HoldReason>,
    },
    /// Genuine hard pressure: the only machine condition that holds a user-requested agent.
    HardPressure {
        pressure: HardPressure,
    },
}

/// A scheduler/provider-facing answer. It has no side effects and does not alter running work.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionDecision {
    pub state: AdmissionState,
    pub mode: Option<ModeKind>,
    pub additional: u32,
    pub reasons: Vec<AdmissionReason>,
    pub snapshot_seq: Option<u64>,
    pub sampled_at_unix_ms: Option<i64>,
}

/// Derives freshness from the sampler's current cadence. Three missed intervals are tolerated,
/// bounded so an active view detects a stopped sampler quickly and an idle sampler is not called
/// stale before its documented 15-second interval.
pub fn admission_max_age(snapshot: &ResourceSnapshot) -> Duration {
    let minimum = duration_ms(MIN_ADMISSION_SAMPLE_AGE);
    let maximum = duration_ms(MAX_ADMISSION_SAMPLE_AGE);
    let milliseconds = snapshot
        .sampling
        .next_interval_ms
        .saturating_mul(FRESHNESS_INTERVALS)
        .clamp(minimum, maximum);
    Duration::from_millis(milliseconds)
}

/// Evaluates whether a new governed workload may start from one coherent sample and capacity
/// result. Callers must compute `advice` from the same `snapshot` supplied here.
pub fn evaluate_admission(
    status: &GovernorStatus,
    snapshot: Option<&ResourceSnapshot>,
    advice: Option<CapacityAdvice>,
    requirements: AdmissionRequirements,
    now_unix_ms: i64,
    max_age: Duration,
) -> AdmissionDecision {
    let mut reasons = Vec::new();
    if !matches!(status, GovernorStatus::Running) {
        reasons.push(AdmissionReason::GovernorNotReady {
            status: status.clone(),
        });
    }

    let valid_snapshot = snapshot.filter(|snapshot| snapshot.seq > 0);
    if let Some(snapshot) = valid_snapshot {
        let max_age_ms = duration_ms(max_age);
        match now_unix_ms.checked_sub(snapshot.sampled_at_unix_ms) {
            None | Some(..=-1) => reasons.push(AdmissionReason::SnapshotFromFuture {
                sampled_at_unix_ms: snapshot.sampled_at_unix_ms,
            }),
            Some(age) if u64::try_from(age).unwrap_or(u64::MAX) > max_age_ms => {
                reasons.push(AdmissionReason::SnapshotStale {
                    age_ms: u64::try_from(age).unwrap_or(u64::MAX),
                    max_age_ms,
                });
            }
            Some(_) => {}
        }
        if requirements.cpu {
            require_cpu(&snapshot.cpu, &mut reasons);
        }
        if requirements.memory {
            require_memory(&snapshot.memory, &mut reasons);
        }
        if requirements.disk_space {
            require_volumes(&snapshot.volumes, &mut reasons);
        }
        if requirements.gpu {
            require_gpu(&snapshot.gpu, &mut reasons);
        }
    } else {
        reasons.push(AdmissionReason::SnapshotMissing);
    }

    if let (Some(snapshot), Some(advice)) = (valid_snapshot, advice.as_ref())
        && snapshot.mode != advice.mode
    {
        reasons.push(AdmissionReason::SnapshotModeMismatch {
            snapshot_mode: snapshot.mode,
            active_mode: advice.mode,
        });
    }

    let (mode, additional) = match advice {
        Some(advice) => {
            let additional = advice.additional;
            if additional == 0 {
                reasons.push(AdmissionReason::Capacity {
                    holds: advice.holds,
                });
            }
            (Some(advice.mode), additional)
        }
        None => {
            reasons.push(AdmissionReason::CapacityUnavailable);
            (valid_snapshot.map(|snapshot| snapshot.mode), 0)
        }
    };

    AdmissionDecision {
        state: if reasons.is_empty() {
            AdmissionState::Allowed
        } else {
            AdmissionState::Held
        },
        mode,
        additional,
        reasons,
        snapshot_seq: valid_snapshot.map(|snapshot| snapshot.seq),
        sampled_at_unix_ms: valid_snapshot.map(|snapshot| snapshot.sampled_at_unix_ms),
    }
}

/// Admission for a coding agent the person asked for (a pane, New agent, a KalVoice-launched
/// agent, a user-initiated Squad or Handoff). Provider-agnostic.
///
/// The agent is admitted unless:
/// - a current, valid sample shows genuine hard pressure ([`hard_pressure`]) for `workspace_id`,
///   or
/// - an explicit Custom-mode count limit the person set is reached.
///
/// CPU utilisation, soft memory headroom, pressure levels, KalCode's own memory share and
/// missing, stale or invalid telemetry never hold it. `override_holds` (Start Anyway) admits it
/// regardless; the decision still lists what would have held it, for the log.
#[allow(clippy::too_many_arguments)]
pub fn evaluate_user_agent_admission(
    snapshot: Option<&ResourceSnapshot>,
    limits: &ModeLimits,
    running: &RunningWork,
    request: &CapacityRequest,
    workspace_id: Option<&str>,
    now_unix_ms: i64,
    max_age: Duration,
    override_holds: bool,
) -> AdmissionDecision {
    let mut reasons = Vec::new();
    let counts = count_constraints(limits, running, request);
    let mut additional = counts
        .iter()
        .map(|constraint| constraint.allows)
        .min()
        .unwrap_or(u32::MAX);
    if additional == 0 {
        reasons.push(AdmissionReason::Capacity {
            holds: counts
                .into_iter()
                .filter(|constraint| constraint.allows == 0)
                .map(|constraint| constraint.reason)
                .collect(),
        });
    }

    let sampled = snapshot.filter(|snapshot| snapshot.seq > 0);
    let current = sampled.filter(|snapshot| {
        now_unix_ms
            .checked_sub(snapshot.sampled_at_unix_ms)
            .and_then(|age| u64::try_from(age).ok())
            .is_some_and(|age| age <= duration_ms(max_age))
    });
    if let Some(snapshot) = current {
        let pressure = hard_pressure(snapshot, workspace_id);
        if !pressure.is_empty() {
            additional = 0;
        }
        reasons.extend(
            pressure
                .into_iter()
                .map(|pressure| AdmissionReason::HardPressure { pressure }),
        );
    }

    let held = !reasons.is_empty() && !override_holds;
    AdmissionDecision {
        state: if held {
            AdmissionState::Held
        } else {
            AdmissionState::Allowed
        },
        mode: Some(limits.kind),
        additional: if held { 0 } else { additional.max(1) },
        reasons,
        snapshot_seq: sampled.map(|snapshot| snapshot.seq),
        sampled_at_unix_ms: sampled.map(|snapshot| snapshot.sampled_at_unix_ms),
    }
}

fn require_reading<'a, T>(
    resource: ResourceKind,
    reading: &'a Reading<T>,
    reasons: &mut Vec<AdmissionReason>,
) -> Option<&'a T> {
    match reading {
        Reading::Value(value) => Some(value),
        Reading::Unknown(detail) => {
            reasons.push(AdmissionReason::RequiredTelemetryUnknown {
                resource,
                detail: detail.clone(),
            });
            None
        }
        Reading::Unavailable(detail) => {
            reasons.push(AdmissionReason::RequiredTelemetryUnavailable {
                resource,
                detail: detail.clone(),
            });
            None
        }
    }
}

fn require_cpu(reading: &Reading<CpuReading>, reasons: &mut Vec<AdmissionReason>) {
    let Some(cpu) = require_reading(ResourceKind::Cpu, reading, reasons) else {
        return;
    };
    if cpu.logical_cores == 0
        || !valid_percent(cpu.total_percent)
        || !valid_percent(cpu.smoothed_percent)
    {
        invalid_reading(
            ResourceKind::Cpu,
            "the CPU reading failed validation",
            reasons,
        );
    }
}

fn require_memory(reading: &Reading<MemoryReading>, reasons: &mut Vec<AdmissionReason>) {
    let Some(memory) = require_reading(ResourceKind::Memory, reading, reasons) else {
        return;
    };
    if memory.total_bytes == 0
        || memory.available_bytes > memory.total_bytes
        || memory.used_bytes > memory.total_bytes
        || memory.smoothed_available_bytes > memory.total_bytes
        || !valid_percent(memory.used_percent)
        || !valid_percent(memory.smoothed_used_percent)
    {
        invalid_reading(
            ResourceKind::Memory,
            "the memory reading failed validation",
            reasons,
        );
    }
}

fn require_volumes(reading: &Reading<Vec<VolumeReading>>, reasons: &mut Vec<AdmissionReason>) {
    let Some(volumes) = require_reading(ResourceKind::DiskSpace, reading, reasons) else {
        return;
    };
    if volumes.is_empty()
        || volumes
            .iter()
            .any(|volume| volume.total_bytes == 0 || volume.free_bytes > volume.total_bytes)
    {
        invalid_reading(
            ResourceKind::DiskSpace,
            "no valid governed volume was measured",
            reasons,
        );
    }
}

fn require_gpu(reading: &Reading<GpuReading>, reasons: &mut Vec<AdmissionReason>) {
    let Some(gpu) = require_reading(ResourceKind::Gpu, reading, reasons) else {
        return;
    };
    if let Some(utilization) = require_reading(ResourceKind::Gpu, &gpu.utilization_percent, reasons)
        && !valid_percent(*utilization)
    {
        invalid_reading(
            ResourceKind::Gpu,
            "the GPU utilization reading failed validation",
            reasons,
        );
    }

    let used = require_reading(ResourceKind::Vram, &gpu.vram_used_bytes, reasons);
    let total = require_reading(ResourceKind::Vram, &gpu.vram_total_bytes, reasons);
    if let (Some(used), Some(total)) = (used, total)
        && (*total == 0 || *used > *total)
    {
        invalid_reading(
            ResourceKind::Vram,
            "the VRAM reading failed validation",
            reasons,
        );
    }
}

fn valid_percent(value: f32) -> bool {
    value.is_finite() && (0.0..=100.0).contains(&value)
}

fn invalid_reading(
    resource: ResourceKind,
    detail: &'static str,
    reasons: &mut Vec<AdmissionReason>,
) {
    reasons.push(AdmissionReason::RequiredTelemetryUnknown {
        resource,
        detail: detail.into(),
    });
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// How soon a held launch should look again: the sampler's own next interval, bounded to
/// [`ADMISSION_RETRY_MIN`]..=[`ADMISSION_RETRY_MAX`]. Without a sample, the longest bound.
pub fn admission_retry_interval(snapshot: Option<&ResourceSnapshot>) -> Duration {
    let Some(snapshot) = snapshot.filter(|snapshot| snapshot.seq > 0) else {
        return ADMISSION_RETRY_MAX;
    };
    Duration::from_millis(snapshot.sampling.next_interval_ms)
        .clamp(ADMISSION_RETRY_MIN, ADMISSION_RETRY_MAX)
}

impl AdmissionReason {
    /// A stable, log-friendly code for this reason (never contains values or text).
    pub fn code(&self) -> &'static str {
        match self {
            Self::GovernorNotReady { .. } | Self::SnapshotMissing => "sampler_unavailable",
            Self::SnapshotFromFuture { .. }
            | Self::SnapshotStale { .. }
            | Self::SnapshotModeMismatch { .. } => "stale_snapshot",
            Self::RequiredTelemetryUnknown { .. } => "telemetry_unknown",
            Self::RequiredTelemetryUnavailable { .. } => "telemetry_unavailable",
            Self::CapacityUnavailable => "slot_unavailable",
            Self::Capacity { .. } => "capacity",
            Self::HardPressure { pressure } => pressure.code(),
        }
    }
}

/// A stable, log-friendly code for one capacity hold.
pub fn hold_reason_code(reason: &HoldReason) -> &'static str {
    match reason {
        HoldReason::UserLimit { .. } => "concurrency_limit",
        HoldReason::ProviderLimit { .. } => "provider_limit",
        HoldReason::Pressure { .. } => "pressure",
        HoldReason::CpuHeadroom { .. } => "cpu_headroom",
        HoldReason::MemoryHeadroom { .. } => "memory_headroom",
        HoldReason::KalCodeMemoryCap { .. } => "memory_cap",
        HoldReason::GpuLimit { .. } => "gpu_limit",
    }
}

/// The user-facing hold kinds of one reason. Only hard pressure and explicit Custom count limits
/// can hold a user-requested agent; any other reason (background-only) maps to nothing.
fn reason_kinds(reason: &AdmissionReason) -> Vec<LaunchHoldKind> {
    match reason {
        AdmissionReason::HardPressure { pressure } => vec![match pressure {
            HardPressure::MemoryCritical { .. } | HardPressure::CommitExhausted { .. } => {
                LaunchHoldKind::MemoryCritical
            }
            HardPressure::DiskFull { .. } => LaunchHoldKind::DiskFull,
        }],
        AdmissionReason::Capacity { holds } => holds
            .iter()
            .filter_map(|hold| match hold {
                HoldReason::UserLimit { .. } => Some(LaunchHoldKind::ConcurrencyLimit),
                HoldReason::ProviderLimit { .. } => Some(LaunchHoldKind::ProviderLimit),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Every log code of a held decision, with capacity holds expanded (`cpu_headroom`,
/// `concurrency_limit`, ...), in decision order without duplicates.
pub fn decision_codes(decision: &AdmissionDecision) -> Vec<&'static str> {
    let mut codes = Vec::new();
    for reason in &decision.reasons {
        let expanded: Vec<&'static str> = match reason {
            AdmissionReason::Capacity { holds } => holds.iter().map(hold_reason_code).collect(),
            other => vec![other.code()],
        };
        for code in expanded {
            if !codes.contains(&code) {
                codes.push(code);
            }
        }
    }
    codes
}

/// The owner-facing summary of a held user-requested launch: the real reason by
/// [`LaunchHoldKind::PRECEDENCE`], the numbers behind it, and the wait policy. `None` when the
/// decision has no reason that may hold a user-requested agent (the launch then proceeds).
pub fn launch_hold(
    decision: &AdmissionDecision,
    retry_after: Duration,
    wait_limit: Duration,
) -> Option<LaunchHold> {
    let kinds: Vec<LaunchHoldKind> = decision.reasons.iter().flat_map(reason_kinds).collect();
    let kind = LaunchHoldKind::PRECEDENCE
        .into_iter()
        .find(|kind| kinds.contains(kind))?;
    let mut hold = LaunchHold::new(kind, retry_after, wait_limit);
    for reason in &decision.reasons {
        match reason {
            AdmissionReason::Capacity { holds } => {
                for limit in holds {
                    match limit {
                        HoldReason::UserLimit { running, limit, .. }
                            if kind == LaunchHoldKind::ConcurrencyLimit =>
                        {
                            (hold.running, hold.limit) = (Some(*running), Some(*limit));
                        }
                        HoldReason::ProviderLimit { running, limit, .. }
                            if kind == LaunchHoldKind::ProviderLimit =>
                        {
                            (hold.running, hold.limit) = (Some(*running), Some(*limit));
                        }
                        _ => {}
                    }
                }
            }
            AdmissionReason::HardPressure { pressure }
                if hold.free_mb.is_none() && reason_kinds(reason).contains(&kind) =>
            {
                let (free, floor) = pressure.evidence_mb();
                (hold.free_mb, hold.floor_mb) = (Some(free), Some(floor));
            }
            _ => {}
        }
    }
    Some(hold)
}
