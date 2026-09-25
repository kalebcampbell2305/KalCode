//! Proposed interventions — explanations only (RG-06).
//!
//! The governor never terminates, suspends or re-prioritises a process; this crate has no API
//! that could. Under pressure it can *propose* an action with an explanation. The host shows the
//! proposal; acting on it is the user's choice, through the Utility Dock's process control
//! (explain → ask → Trust Kernel), never through this crate.

use serde::{Deserialize, Serialize};

use crate::MIB;
use crate::capacity::RunningWork;
use crate::model::{PressureLevel, ProcessRole, ResourceKind, ResourceSnapshot};

/// Processes smaller than this are never proposed for review.
pub const REVIEW_MIN_RSS_MB: u64 = 512;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ProposedAction {
    /// Suggest the user review (and perhaps close) a process KalCode started.
    ReviewProcess {
        pid: u32,
        name: String,
        role: ProcessRole,
        rss_mb: u64,
    },
    /// Suggest running fewer agent tasks at once.
    ReduceParallelism { running: u32, suggested: u32 },
    /// Suggest freeing space on a workspace volume.
    FreeDiskSpace { mount: String, free_mb: u64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedIntervention {
    pub resource: ResourceKind,
    pub level: PressureLevel,
    pub action: ProposedAction,
    /// Plain-language explanation for the user.
    pub explanation: String,
    /// Always `true`: nothing is done without the user.
    pub requires_user: bool,
}

/// Proposals for the current snapshot (empty unless something is at `High` or worse).
pub fn propose(snapshot: &ResourceSnapshot, running: &RunningWork) -> Vec<ProposedIntervention> {
    let mut out = Vec::new();

    if let Some(level) = snapshot
        .pressure
        .level(ResourceKind::Memory)
        .filter(|l| *l >= PressureLevel::High)
        && let Some(tree) = snapshot.kalcode_tree.value()
    {
        let largest = tree
            .processes
            .iter()
            .filter(|p| {
                matches!(
                    p.role,
                    ProcessRole::Provider { .. } | ProcessRole::Terminal { .. }
                )
            })
            .filter(|p| p.rss_bytes / MIB >= REVIEW_MIN_RSS_MB)
            .max_by_key(|p| (p.rss_bytes, std::cmp::Reverse(p.pid)));
        if let Some(process) = largest {
            let rss_mb = process.rss_bytes / MIB;
            out.push(ProposedIntervention {
                resource: ResourceKind::Memory,
                level,
                action: ProposedAction::ReviewProcess {
                    pid: process.pid,
                    name: process.name.clone(),
                    role: process.role.clone(),
                    rss_mb,
                },
                explanation: format!(
                    "Memory is under {} pressure. {} (process {}) was started by KalCode and uses \
                     {rss_mb} MB. Closing it would free memory; KalCode will not close it for you.",
                    level_word(level),
                    process.name,
                    process.pid
                ),
                requires_user: true,
            });
        }
    }

    if let Some(level) = snapshot
        .pressure
        .level(ResourceKind::Cpu)
        .filter(|l| *l >= PressureLevel::High)
        && running.agents >= 2
    {
        let suggested = running.agents - 1;
        out.push(ProposedIntervention {
            resource: ResourceKind::Cpu,
            level,
            action: ProposedAction::ReduceParallelism {
                running: running.agents,
                suggested,
            },
            explanation: format!(
                "CPU is under {} pressure with {} agent tasks running. Running {suggested} at a \
                 time would leave more room for everything else.",
                level_word(level),
                running.agents
            ),
            requires_user: true,
        });
    }

    if let Some(entry) = snapshot
        .pressure
        .entry(ResourceKind::DiskSpace)
        .filter(|e| e.level >= PressureLevel::High)
        && let crate::Signal::DiskFreeMb { mount } = &entry.signal
    {
        let free_mb = entry.value.max(0.0) as u64;
        out.push(ProposedIntervention {
            resource: ResourceKind::DiskSpace,
            level: entry.level,
            action: ProposedAction::FreeDiskSpace {
                mount: mount.clone(),
                free_mb,
            },
            explanation: format!(
                "Only {free_mb} MB are free on {mount}, where a workspace lives. Builds and \
                 checkpoints may fail when it fills up."
            ),
            requires_user: true,
        });
    }

    out
}

fn level_word(level: PressureLevel) -> &'static str {
    match level {
        PressureLevel::Normal => "normal",
        PressureLevel::Elevated => "elevated",
        PressureLevel::High => "high",
        PressureLevel::Critical => "critical",
    }
}
