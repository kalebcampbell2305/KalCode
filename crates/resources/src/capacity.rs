//! The advisory capacity API the Scheduler (P4) will consume.
//!
//! [`capacity`] is a pure, deterministic function of a snapshot, the resolved mode limits and
//! what is running. It answers "how many more agent tasks could start now, and what would hold
//! the next one". It never starts, holds, kills or suspends anything: before the Scheduler exists
//! the host shows the answer as a warning and never blocks (RG-05).
//!
//! Unknown data never produces a resource hold. When a metric is unknown the matching constraint
//! is skipped and the advice says so (`DataQuality`, `CapacityNote::MetricUnknown`); count limits
//! (the mode's maximum simultaneous agents and per-provider limits) still apply because they do
//! not depend on sampling.

use std::collections::BTreeMap;

use kalcode_contracts::agent::ProviderId;
use serde::{Deserialize, Serialize};

pub use kalcode_contracts::resources::{
    CapacityAdvice, CapacityNote, Constraint, DataQuality, GpuMetric, ProviderCapacity,
    ResourceHoldReason as HoldReason,
};

use crate::MIB;
use crate::mode::ModeLimits;
use crate::model::{PressureLevel, ResourceKind, ResourceSnapshot};

/// What is running now, as the host (thread runtime, later the Scheduler) counts it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningWork {
    /// Agent tasks running now, over all providers.
    pub agents: u32,
    /// Running tasks per provider.
    pub per_provider: BTreeMap<ProviderId, u32>,
}

/// The question asked. `provider` narrows the answer to tasks for that provider.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityRequest {
    pub provider: Option<ProviderId>,
}

/// The per-agent memory estimate: the larger of the mode's default and the observed average of
/// live provider sessions (resident memory of each session's whole subtree).
pub fn per_agent_memory_mb(snapshot: &ResourceSnapshot, limits: &ModeLimits) -> (u64, Option<u32>) {
    let default = limits.agent_estimate.memory_mb;
    let Some(tree) = snapshot.kalcode_tree.value() else {
        return (default, None);
    };
    let sessions = u32::try_from(tree.provider_sessions.len()).unwrap_or(u32::MAX);
    if sessions == 0 {
        return (default, None);
    }
    let total: u64 = tree.provider_sessions.iter().map(|s| s.rss_bytes).sum();
    let observed = total / u64::from(sessions) / MIB;
    if observed > default {
        (observed, Some(sessions))
    } else {
        (default, None)
    }
}

fn floor_div(headroom: f64, per: f64) -> u32 {
    if headroom <= 0.0 || per <= 0.0 || !headroom.is_finite() {
        return 0;
    }
    let n = (headroom / per).floor();
    if n >= f64::from(u32::MAX) {
        u32::MAX
    } else {
        n as u32
    }
}

/// Computes advisory capacity. Pure and deterministic.
pub fn capacity(
    snapshot: &ResourceSnapshot,
    limits: &ModeLimits,
    running: &RunningWork,
    request: &CapacityRequest,
) -> CapacityAdvice {
    let mode = limits.kind;
    let mut constraints = Vec::new();
    let mut notes = Vec::new();

    // 1. Count limits (always known).
    constraints.push(Constraint {
        reason: HoldReason::UserLimit {
            running: running.agents,
            limit: limits.max_agents,
            mode,
        },
        allows: limits.max_agents.saturating_sub(running.agents),
    });
    let running_for =
        |provider: &ProviderId| running.per_provider.get(provider).copied().unwrap_or(0);
    if let Some(provider) = &request.provider
        && let Some(limit) = limits.per_provider.get(provider)
    {
        let used = running_for(provider);
        constraints.push(Constraint {
            reason: HoldReason::ProviderLimit {
                provider: provider.clone(),
                running: used,
                limit: *limit,
            },
            allows: limit.saturating_sub(used),
        });
    }
    let per_provider = limits
        .per_provider
        .iter()
        .map(|(provider, limit)| {
            let used = running_for(provider);
            ProviderCapacity {
                provider: provider.clone(),
                running: used,
                limit: *limit,
                remaining: limit.saturating_sub(used),
            }
        })
        .collect();

    if snapshot.mode != mode && snapshot.seq > 0 {
        notes.push(CapacityNote::PressureFromOtherMode {
            snapshot_mode: snapshot.mode,
        });
    }

    // 2. Pressure levels (hysteresis already applied by the governor).
    for entry in &snapshot.pressure.entries {
        let allows = match entry.level {
            PressureLevel::Normal => continue,
            PressureLevel::Elevated => match limits.elevated_allowance {
                Some(allowance) => allowance,
                None => continue,
            },
            PressureLevel::High | PressureLevel::Critical => 0,
        };
        constraints.push(Constraint {
            reason: HoldReason::Pressure {
                resource: entry.resource,
                level: entry.level,
                mode,
                signal: entry.signal.clone(),
                value: entry.value,
                threshold: entry.threshold,
            },
            allows,
        });
    }

    // 3. Headroom projections.
    let mut unknown: Vec<ResourceKind> = Vec::new();
    match snapshot.cpu.value() {
        Some(cpu) if cpu.logical_cores > 0 => {
            let per_agent = limits.agent_estimate.cpu_cores * 100.0 / f64::from(cpu.logical_cores);
            let current = f64::from(cpu.smoothed_percent);
            constraints.push(Constraint {
                reason: HoldReason::CpuHeadroom {
                    cpu_percent: current,
                    target_percent: limits.cpu_target_percent,
                    per_agent_percent: per_agent,
                    mode,
                },
                allows: floor_div(limits.cpu_target_percent - current, per_agent),
            });
        }
        _ => unknown.push(ResourceKind::Cpu),
    }
    let (per_agent_mb, observed) = per_agent_memory_mb(snapshot, limits);
    if let Some(sessions) = observed {
        notes.push(CapacityNote::ObservedAgentMemory {
            per_agent_mb,
            sessions,
        });
    }
    match snapshot.memory.value() {
        Some(memory) => {
            let available_mb = memory.smoothed_available_bytes / MIB;
            constraints.push(Constraint {
                reason: HoldReason::MemoryHeadroom {
                    available_mb,
                    reserve_mb: limits.memory_reserve_mb,
                    per_agent_mb,
                    mode,
                },
                allows: floor_div(
                    available_mb as f64 - limits.memory_reserve_mb as f64,
                    per_agent_mb as f64,
                ),
            });
            if let (Some(cap), Some(tree)) = (
                limits.kalcode_memory_cap.bytes(memory.total_bytes),
                snapshot.kalcode_tree.value(),
            ) {
                let used_mb = tree.total_rss_bytes / MIB;
                let cap_mb = cap / MIB;
                constraints.push(Constraint {
                    reason: HoldReason::KalCodeMemoryCap {
                        used_mb,
                        cap_mb,
                        per_agent_mb,
                        mode,
                    },
                    allows: floor_div(cap_mb as f64 - used_mb as f64, per_agent_mb as f64),
                });
            }
        }
        None => unknown.push(ResourceKind::Memory),
    }
    if !snapshot.volumes.is_value() {
        unknown.push(ResourceKind::DiskSpace);
    }

    // 4. GPU limits: applied only where measured.
    if limits.gpu.is_set() {
        let gpu = snapshot.gpu.value();
        let utilization = gpu.and_then(|g| g.utilization_percent.value().copied());
        let vram = gpu.and_then(|g| g.vram_used_bytes.value().copied());
        let mut applied = false;
        if let (Some(max), Some(value)) = (limits.gpu.max_utilization_percent, utilization) {
            applied = true;
            constraints.push(Constraint {
                reason: HoldReason::GpuLimit {
                    metric: GpuMetric::UtilizationPercent,
                    value: f64::from(value),
                    limit: f64::from(max),
                },
                allows: if value >= f32::from(max) { 0 } else { u32::MAX },
            });
        }
        if let (Some(max), Some(used)) = (limits.gpu.max_vram_mb, vram) {
            applied = true;
            let used_mb = used / MIB;
            constraints.push(Constraint {
                reason: HoldReason::GpuLimit {
                    metric: GpuMetric::VramMb,
                    value: used_mb as f64,
                    limit: max as f64,
                },
                allows: if used_mb >= max { 0 } else { u32::MAX },
            });
        }
        if !applied {
            let reason = match &snapshot.gpu {
                crate::Reading::Unavailable(reason) | crate::Reading::Unknown(reason) => {
                    reason.clone()
                }
                crate::Reading::Value(_) => "the configured GPU metric is not measured".to_string(),
            };
            notes.push(CapacityNote::GpuLimitsNotApplied { reason });
        }
    }

    let data = if unknown.len() == 3 {
        DataQuality::NoData
    } else if unknown.is_empty() {
        DataQuality::Complete
    } else {
        DataQuality::Partial {
            unknown: unknown.clone(),
        }
    };
    notes.extend(
        unknown
            .into_iter()
            .map(|resource| CapacityNote::MetricUnknown { resource }),
    );

    let additional = constraints.iter().map(|c| c.allows).min().unwrap_or(0);
    let holds = constraints
        .iter()
        .filter(|c| c.allows == additional)
        .map(|c| c.reason.clone())
        .collect();
    CapacityAdvice {
        mode,
        additional,
        holds,
        constraints,
        per_provider,
        data,
        notes,
    }
}
