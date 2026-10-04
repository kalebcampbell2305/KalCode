//! Capacity and proposal decisions from synthetic snapshots, across every mode.
//! Pure functions: no sampler, no clock, no OS.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;

use kalcode_contracts::agent::ProviderId;
use kalcode_resources::capacity::{CapacityNote, DataQuality, GpuMetric, HoldReason};
use kalcode_resources::intervene::{ProposedAction, propose};
use kalcode_resources::model::{
    CadenceReason, CpuReading, GpuReading, MemoryReading, ProcessTreeReading, SamplingInfo,
    SessionUsage, Tiers, TrackedProcess, VolumeReading,
};
use kalcode_resources::{
    CapacityRequest, CustomLimits, GpuLimits, MIB, ModeKind, ModeLimits, PressureEntry,
    PressureLevel, PressureSummary, ProcessRole, Reading, ResourceKind, ResourceMode,
    ResourceSnapshot, RunningWork, Signal, capacity,
};

const GIB: u64 = 1024 * MIB;

/// A calm 16-core, 32 GiB machine: CPU 20 %, 20 GiB available, KalCode tree 1 GiB.
struct Machine {
    mode: ModeKind,
    cpu: Option<f32>,
    cores: u32,
    total: u64,
    available: u64,
    tree_rss: Option<u64>,
    sessions: Vec<(u32, &'static str, u64)>,
    pressure: Vec<(ResourceKind, PressureLevel)>,
    volumes_known: bool,
}

impl Default for Machine {
    fn default() -> Self {
        Self {
            mode: ModeKind::Balanced,
            cpu: Some(20.0),
            cores: 16,
            total: 32 * GIB,
            available: 20 * GIB,
            tree_rss: Some(GIB),
            sessions: Vec::new(),
            pressure: Vec::new(),
            volumes_known: true,
        }
    }
}

fn provider(id: &str) -> ProcessRole {
    ProcessRole::Provider {
        provider: ProviderId::new(id),
        thread_id: None,
    }
}

impl Machine {
    fn snapshot(&self) -> ResourceSnapshot {
        let mut s = ResourceSnapshot::unknown("synthetic", self.mode);
        s.seq = 1;
        s.cpu = match self.cpu {
            Some(cpu) => Reading::Value(CpuReading {
                total_percent: cpu,
                smoothed_percent: cpu,
                logical_cores: self.cores,
            }),
            None => Reading::unknown("synthetic"),
        };
        s.memory = Reading::Value(MemoryReading {
            total_bytes: self.total,
            available_bytes: self.available,
            used_bytes: self.total - self.available,
            used_percent: 0.0,
            smoothed_used_percent: 0.0,
            smoothed_available_bytes: self.available,
            commit: Reading::unavailable("synthetic"),
        });
        if self.volumes_known {
            s.volumes = Reading::Value(vec![VolumeReading {
                mount: "C:\\".into(),
                workspace_ids: vec![Some("ws".into())],
                total_bytes: 500 * GIB,
                free_bytes: 200 * GIB,
            }]);
        }
        if let Some(rss) = self.tree_rss {
            let sessions: Vec<SessionUsage> = self
                .sessions
                .iter()
                .map(|(pid, id, rss)| SessionUsage {
                    root_pid: *pid,
                    role: provider(id),
                    processes: 1,
                    cpu_percent: 1.0,
                    rss_bytes: *rss,
                })
                .collect();
            let mut processes = vec![TrackedProcess {
                pid: 1,
                parent_pid: None,
                name: "kalcode".into(),
                role: ProcessRole::KalCodeSelf,
                cpu_percent: Some(0.1),
                rss_bytes: rss,
                root_pid: 1,
            }];
            processes.extend(self.sessions.iter().map(|(pid, id, rss)| TrackedProcess {
                pid: *pid,
                parent_pid: Some(1),
                name: "node".into(),
                role: provider(id),
                cpu_percent: Some(1.0),
                rss_bytes: *rss,
                root_pid: *pid,
            }));
            s.kalcode_tree = Reading::Value(ProcessTreeReading {
                total_rss_bytes: rss + self.sessions.iter().map(|x| x.2).sum::<u64>(),
                total_cpu_percent: 1.0,
                processes,
                truncated: false,
                provider_sessions: sessions,
            });
        }
        let mut entries = vec![];
        for kind in [
            ResourceKind::Cpu,
            ResourceKind::Memory,
            ResourceKind::DiskSpace,
        ] {
            let level = self
                .pressure
                .iter()
                .find(|(k, _)| *k == kind)
                .map_or(PressureLevel::Normal, |(_, l)| *l);
            let (signal, value) = match kind {
                ResourceKind::Cpu => (Signal::CpuPercent, 20.0),
                ResourceKind::Memory => (Signal::MemoryUsedPercent, 40.0),
                _ => (
                    Signal::DiskFreeMb {
                        mount: "C:\\".into(),
                    },
                    1000.0,
                ),
            };
            entries.push(PressureEntry {
                resource: kind,
                level,
                signal,
                value,
                threshold: None,
                approaching: false,
            });
        }
        s.pressure = PressureSummary {
            entries,
            unknown: vec![],
        };
        s.sampling = SamplingInfo {
            refreshed: Tiers {
                fast: true,
                slow: true,
                processes: true,
                inventory: false,
            },
            next_interval_ms: 15_000,
            reason: CadenceReason::Idle,
            consecutive_failures: 0,
        };
        s
    }
}

fn custom() -> CustomLimits {
    CustomLimits {
        max_cpu_percent: 50,
        max_kalcode_memory_mb: Some(2048),
        min_available_memory_mb: 4096,
        min_disk_free_mb: 5120,
        max_agents: 10,
        per_provider: BTreeMap::from([(ProviderId::new("codex"), 1)]),
        gpu: GpuLimits::default(),
    }
}

fn all_modes() -> Vec<ResourceMode> {
    vec![
        ResourceMode::Conservative,
        ResourceMode::Balanced,
        ResourceMode::Performance,
        ResourceMode::Custom(custom()),
    ]
}

fn kind_of(reason: &HoldReason) -> &'static str {
    match reason {
        HoldReason::UserLimit { .. } => "user",
        HoldReason::ProviderLimit { .. } => "provider",
        HoldReason::Pressure { .. } => "pressure",
        HoldReason::CpuHeadroom { .. } => "cpu",
        HoldReason::MemoryHeadroom { .. } => "memory",
        HoldReason::KalCodeMemoryCap { .. } => "cap",
        HoldReason::GpuLimit { .. } => "gpu",
    }
}

fn advise(
    mode: &ResourceMode,
    machine: &Machine,
    running: &RunningWork,
    provider: Option<&str>,
) -> kalcode_resources::CapacityAdvice {
    let limits = mode.limits().unwrap();
    let machine = Machine {
        mode: limits.kind,
        ..clone_machine(machine)
    };
    let request = CapacityRequest {
        provider: provider.map(ProviderId::new),
    };
    capacity(&machine.snapshot(), &limits, running, &request)
}

fn clone_machine(m: &Machine) -> Machine {
    Machine {
        mode: m.mode,
        cpu: m.cpu,
        cores: m.cores,
        total: m.total,
        available: m.available,
        tree_rss: m.tree_rss,
        sessions: m.sessions.clone(),
        pressure: m.pressure.clone(),
        volumes_known: m.volumes_known,
    }
}

#[test]
fn calm_machine_every_mode_exact_numbers() {
    // Per agent: 0.5 core of 16 = 3.125 % CPU, 512 MiB.
    let expected = [
        // (additional, binding, cpu allows, memory allows, cap allows)
        // Conservative: target 60 → (60−20)/3.125 = 12; (20 480−4 096)/512 = 32;
        // cap 25 % of 32 GiB = 8 192 − 1 024 → 14; no agent count ceiling.
        (12, vec!["cpu"], 12, 32, 14),
        // Balanced: 17; (20 480−2 048)/512 = 36; cap 16 384 − 1 024 → 30; no agent count ceiling.
        (17, vec!["cpu"], 17, 36, 30),
        // Performance: 22; 38; cap 24 576 − 1 024 → 46; no agent count ceiling.
        (22, vec!["cpu"], 22, 38, 46),
        // Custom: target 50 → 9; reserve 4 096 → 32; cap 2 048 − 1 024 → 2; agents 10.
        (2, vec!["cap"], 9, 32, 2),
    ];
    for (mode, (additional, binding, cpu, memory, cap)) in all_modes().iter().zip(expected) {
        let advice = advise(mode, &Machine::default(), &RunningWork::default(), None);
        assert_eq!(advice.additional, additional, "{mode:?}");
        assert_eq!(
            advice.holds.iter().map(kind_of).collect::<Vec<_>>(),
            binding,
            "{mode:?}"
        );
        let allows = |k: &str| {
            advice
                .constraints
                .iter()
                .find(|c| kind_of(&c.reason) == k)
                .unwrap()
                .allows
        };
        assert_eq!(
            (allows("cpu"), allows("memory"), allows("cap")),
            (cpu, memory, cap),
            "{mode:?}"
        );
        assert_eq!(advice.data, DataQuality::Complete);
        assert_eq!(advice.mode, mode.kind());
    }
}

#[test]
fn running_agents_consume_the_user_limit() {
    let machine = Machine::default();
    let three = RunningWork {
        agents: 3,
        ..Default::default()
    };
    assert_eq!(
        advise(&ResourceMode::Balanced, &machine, &three, None).additional,
        17
    );
    let over = RunningWork {
        agents: 12,
        ..Default::default()
    };
    for mode in all_modes() {
        let advice = advise(&mode, &machine, &over, None);
        if matches!(mode, ResourceMode::Custom(_)) {
            assert_eq!(advice.additional, 0);
            assert!(
                advice
                    .holds
                    .iter()
                    .any(|h| matches!(h, HoldReason::UserLimit { running: 12, .. }))
            );
        } else {
            assert!(advice.additional > 0, "presets never count-cap {mode:?}");
            assert!(
                !advice
                    .constraints
                    .iter()
                    .any(|c| matches!(c.reason, HoldReason::UserLimit { .. }))
            );
        }
    }
}

#[test]
fn high_and_critical_pressure_hold_everything_in_every_mode() {
    for level in [PressureLevel::High, PressureLevel::Critical] {
        for resource in [
            ResourceKind::Cpu,
            ResourceKind::Memory,
            ResourceKind::DiskSpace,
        ] {
            let machine = Machine {
                pressure: vec![(resource, level)],
                ..Machine::default()
            };
            for mode in all_modes() {
                let advice = advise(&mode, &machine, &RunningWork::default(), None);
                assert_eq!(advice.additional, 0, "{mode:?} {resource:?} {level:?}");
                let held_by: Vec<_> = advice
                    .holds
                    .iter()
                    .filter_map(|h| match h {
                        HoldReason::Pressure {
                            resource,
                            level,
                            mode,
                            ..
                        } => Some((*resource, *level, *mode)),
                        _ => None,
                    })
                    .collect();
                assert_eq!(held_by, vec![(resource, level, mode.kind())]);
            }
        }
    }
}

#[test]
fn elevated_pressure_uses_each_modes_allowance() {
    let machine = Machine {
        pressure: vec![(ResourceKind::Memory, PressureLevel::Elevated)],
        ..Machine::default()
    };
    let got: Vec<(ModeKind, u32)> = all_modes()
        .iter()
        .map(|mode| {
            (
                mode.kind(),
                advise(mode, &machine, &RunningWork::default(), None).additional,
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (ModeKind::Conservative, 0),
            (ModeKind::Balanced, 1),
            (ModeKind::Performance, 22), // real headroom decides
            (ModeKind::Custom, 1),
        ]
    );
}

#[test]
fn cpu_and_memory_headroom_bind_before_levels_do() {
    // CPU at 74 % (Balanced target 75): no room for even one 3.125 % agent... 0.
    let busy = Machine {
        cpu: Some(74.0),
        ..Machine::default()
    };
    let advice = advise(
        &ResourceMode::Balanced,
        &busy,
        &RunningWork::default(),
        None,
    );
    assert_eq!(advice.additional, 0);
    assert_eq!(
        advice.holds.iter().map(kind_of).collect::<Vec<_>>(),
        vec!["cpu"]
    );
    if let HoldReason::CpuHeadroom {
        cpu_percent,
        target_percent,
        per_agent_percent,
        mode,
    } = &advice.holds[0]
    {
        assert_eq!(
            (*cpu_percent, *target_percent, *per_agent_percent, *mode),
            (74.0, 75.0, 3.125, ModeKind::Balanced)
        );
    }

    // 3 GiB available, Balanced reserve 2 GiB → 1 024 / 512 = 2 more.
    let tight = Machine {
        available: 3 * GIB,
        ..Machine::default()
    };
    let advice = advise(
        &ResourceMode::Balanced,
        &tight,
        &RunningWork::default(),
        None,
    );
    assert_eq!(advice.additional, 2);
    assert_eq!(
        advice.holds.iter().map(kind_of).collect::<Vec<_>>(),
        vec!["memory"]
    );
    // Conservative keeps 4 GiB free: nothing starts.
    assert_eq!(
        advise(
            &ResourceMode::Conservative,
            &tight,
            &RunningWork::default(),
            None
        )
        .additional,
        0
    );
}

#[test]
fn per_provider_limits_apply_to_their_provider_only() {
    let mode = ResourceMode::Custom(CustomLimits {
        max_kalcode_memory_mb: None,
        ..custom()
    });
    let running = RunningWork {
        agents: 1,
        per_provider: BTreeMap::from([(ProviderId::new("codex"), 1)]),
    };
    let codex = advise(&mode, &Machine::default(), &running, Some("codex"));
    assert_eq!(codex.additional, 0);
    assert_eq!(
        codex.holds,
        vec![HoldReason::ProviderLimit {
            provider: ProviderId::new("codex"),
            running: 1,
            limit: 1
        }]
    );
    let other = advise(&mode, &Machine::default(), &running, Some("claude-code"));
    assert_eq!(
        other.additional, 9,
        "CPU headroom (50−20)/3.125 = 9 binds, not the codex limit"
    );
    assert_eq!(other.per_provider.len(), 1);
    assert_eq!(other.per_provider[0].remaining, 0);
    // Presets have no per-provider limits.
    let preset = advise(
        &ResourceMode::Balanced,
        &Machine::default(),
        &running,
        Some("codex"),
    );
    assert!(
        preset
            .constraints
            .iter()
            .all(|c| kind_of(&c.reason) != "provider")
    );
}

#[test]
fn unknown_data_falls_back_to_count_limits_only() {
    for mode in all_modes() {
        let limits = mode.limits().unwrap();
        let snapshot = ResourceSnapshot::unknown("sampler stopped", limits.kind);
        let running = RunningWork {
            agents: 1,
            ..Default::default()
        };
        let advice = capacity(&snapshot, &limits, &running, &CapacityRequest::default());
        assert_eq!(advice.data, DataQuality::NoData, "{mode:?}");
        assert_eq!(
            advice.additional,
            if limits.max_agents == u32::MAX {
                u32::MAX
            } else {
                limits.max_agents - 1
            }
        );
        assert_eq!(
            advice.holds.iter().map(kind_of).collect::<Vec<_>>(),
            if limits.max_agents == u32::MAX {
                vec![]
            } else {
                vec!["user"]
            }
        );
        let unknown: Vec<_> = advice
            .notes
            .iter()
            .filter_map(|n| match n {
                CapacityNote::MetricUnknown { resource } => Some(*resource),
                _ => None,
            })
            .collect();
        assert_eq!(
            unknown,
            vec![
                ResourceKind::Cpu,
                ResourceKind::Memory,
                ResourceKind::DiskSpace
            ]
        );
    }
    // Partial: only CPU unknown.
    let machine = Machine {
        cpu: None,
        ..Machine::default()
    };
    let advice = advise(
        &ResourceMode::Balanced,
        &machine,
        &RunningWork::default(),
        None,
    );
    assert_eq!(
        advice.data,
        DataQuality::Partial {
            unknown: vec![ResourceKind::Cpu]
        }
    );
    assert!(
        advice
            .constraints
            .iter()
            .all(|c| kind_of(&c.reason) != "cpu")
    );
    // Unknown tree: the memory cap is skipped, headroom still applies.
    let machine = Machine {
        tree_rss: None,
        volumes_known: false,
        ..Machine::default()
    };
    let advice = advise(
        &ResourceMode::Balanced,
        &machine,
        &RunningWork::default(),
        None,
    );
    assert!(
        advice
            .constraints
            .iter()
            .all(|c| kind_of(&c.reason) != "cap")
    );
    assert_eq!(
        advice.data,
        DataQuality::Partial {
            unknown: vec![ResourceKind::DiskSpace]
        }
    );
}

#[test]
fn observed_provider_sessions_raise_the_per_agent_memory_estimate() {
    // Two live sessions averaging 1.5 GiB: estimate 1 536 MiB instead of 512.
    let machine = Machine {
        sessions: vec![(10, "claude-code", GIB), (11, "codex", 2 * GIB)],
        available: 8 * GIB,
        ..Machine::default()
    };
    let advice = advise(
        &ResourceMode::Performance,
        &machine,
        &RunningWork {
            agents: 2,
            ..Default::default()
        },
        None,
    );
    // (8 192 − 1 024) / 1 536 = 4.67 → 4.
    let memory = advice
        .constraints
        .iter()
        .find(|c| kind_of(&c.reason) == "memory")
        .unwrap();
    assert_eq!(memory.allows, 4);
    assert!(advice.notes.contains(&CapacityNote::ObservedAgentMemory {
        per_agent_mb: 1536,
        sessions: 2
    }));
    // Small sessions never lower the estimate below the default.
    let light = Machine {
        sessions: vec![(10, "codex", 100 * MIB)],
        ..Machine::default()
    };
    let advice = advise(
        &ResourceMode::Performance,
        &light,
        &RunningWork::default(),
        None,
    );
    assert!(
        advice
            .notes
            .iter()
            .all(|n| !matches!(n, CapacityNote::ObservedAgentMemory { .. }))
    );
}

#[test]
fn gpu_limits_are_applied_only_where_measured() {
    let mode = ResourceMode::Custom(CustomLimits {
        gpu: GpuLimits {
            max_utilization_percent: Some(80),
            max_vram_mb: Some(4096),
        },
        max_kalcode_memory_mb: None,
        ..custom()
    });
    let limits = mode.limits().unwrap();
    // Not measured: a note, no constraint, no guess.
    let mut snapshot = Machine {
        mode: ModeKind::Custom,
        ..Machine::default()
    }
    .snapshot();
    snapshot.gpu = Reading::unavailable("GPU metrics are not available in this build");
    let advice = capacity(
        &snapshot,
        &limits,
        &RunningWork::default(),
        &CapacityRequest::default(),
    );
    assert!(
        advice
            .constraints
            .iter()
            .all(|c| kind_of(&c.reason) != "gpu")
    );
    assert!(
        advice
            .notes
            .iter()
            .any(|n| matches!(n, CapacityNote::GpuLimitsNotApplied { .. }))
    );
    // Measured (a future probe): applied.
    snapshot.gpu = Reading::Value(GpuReading {
        utilization_percent: Reading::Value(90.0),
        vram_used_bytes: Reading::Value(GIB),
        vram_total_bytes: Reading::Value(8 * GIB),
    });
    let advice = capacity(
        &snapshot,
        &limits,
        &RunningWork::default(),
        &CapacityRequest::default(),
    );
    assert_eq!(advice.additional, 0);
    assert!(matches!(
        advice.holds[0],
        HoldReason::GpuLimit {
            metric: GpuMetric::UtilizationPercent,
            ..
        }
    ));
}

#[test]
fn capacity_is_deterministic_and_serializable() {
    let machine = Machine {
        pressure: vec![(ResourceKind::Cpu, PressureLevel::Elevated)],
        ..Machine::default()
    };
    for mode in all_modes() {
        let a = advise(&mode, &machine, &RunningWork::default(), Some("codex"));
        let b = advise(&mode, &machine, &RunningWork::default(), Some("codex"));
        assert_eq!(a, b);
        let json = serde_json::to_string(&a).unwrap();
        let back: kalcode_resources::CapacityAdvice = serde_json::from_str(&json).unwrap();
        assert_eq!(back, a);
    }
}

#[test]
fn snapshot_from_another_mode_is_flagged() {
    let limits = ModeLimits::conservative();
    let snapshot = Machine {
        mode: ModeKind::Performance,
        ..Machine::default()
    }
    .snapshot();
    let advice = capacity(
        &snapshot,
        &limits,
        &RunningWork::default(),
        &CapacityRequest::default(),
    );
    assert!(advice.notes.contains(&CapacityNote::PressureFromOtherMode {
        snapshot_mode: ModeKind::Performance
    }));
}

#[test]
fn proposals_explain_and_never_act() {
    let machine = Machine {
        sessions: vec![(10, "claude-code", 3 * GIB), (11, "codex", 600 * MIB)],
        pressure: vec![
            (ResourceKind::Memory, PressureLevel::Critical),
            (ResourceKind::Cpu, PressureLevel::High),
            (ResourceKind::DiskSpace, PressureLevel::High),
        ],
        ..Machine::default()
    };
    let proposals = propose(
        &machine.snapshot(),
        &RunningWork {
            agents: 3,
            ..Default::default()
        },
    );
    let actions: Vec<_> = proposals.iter().map(|p| p.action.clone()).collect();
    assert_eq!(
        actions,
        vec![
            ProposedAction::ReviewProcess {
                pid: 10,
                name: "node".into(),
                role: provider("claude-code"),
                rss_mb: 3072
            },
            ProposedAction::ReduceParallelism {
                running: 3,
                suggested: 2
            },
            ProposedAction::FreeDiskSpace {
                mount: "C:\\".into(),
                free_mb: 1000
            },
        ]
    );
    assert!(
        proposals
            .iter()
            .all(|p| p.requires_user && !p.explanation.is_empty())
    );
    assert!(proposals[0].explanation.contains("will not close it"));

    // Normal pressure: nothing proposed. KalCode's own process is never proposed.
    assert!(propose(&Machine::default().snapshot(), &RunningWork::default()).is_empty());
    let own_only = Machine {
        tree_rss: Some(8 * GIB),
        pressure: vec![(ResourceKind::Memory, PressureLevel::Critical)],
        ..Machine::default()
    };
    assert!(propose(&own_only.snapshot(), &RunningWork::default()).is_empty());
}
