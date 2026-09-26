//! Fail-closed admission decisions for work that consumes meaningful machine resources.
//!
//! This module is a pure bridge between the sampler's evidence and a future scheduler/provider
//! launch site. It never starts, stops, suspends, or reprioritises work. Local UI, account/auth,
//! and recovery paths must not call it; they remain available while resource telemetry recovers.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::capacity::{CapacityAdvice, HoldReason};
use crate::governor::GovernorStatus;
use crate::mode::ModeKind;
use crate::model::{
    CpuReading, GpuReading, MemoryReading, Reading, ResourceKind, ResourceSnapshot, VolumeReading,
};

/// The shortest and longest interval for which a successful sample remains usable for admission.
pub const MIN_ADMISSION_SAMPLE_AGE: Duration = Duration::from_secs(5);
pub const MAX_ADMISSION_SAMPLE_AGE: Duration = Duration::from_secs(45);
const FRESHNESS_INTERVALS: u64 = 3;

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
