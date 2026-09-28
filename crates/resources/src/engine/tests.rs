//! Engine tests: every time value is injected, so cadence, smoothing and hysteresis are exact.

use std::time::Duration;

use kalcode_contracts::agent::ProviderId;

use super::*;
use crate::PressureLevel::*;
use crate::model::{ProcessRole, TrackedProcess};
use crate::probe::{RawCpu, RawMemory, RawProcesses};

const GIB_FOR_TESTS: u64 = 1024 * MIB;

fn secs(s: u64) -> Duration {
    Duration::from_secs(s)
}

const TOTAL: u64 = 16 * GIB_FOR_TESTS;

fn engine(mode: ResourceMode) -> Engine {
    Engine::new(&GovernorConfig {
        mode,
        self_pid: 100,
        ..GovernorConfig::default()
    })
    .unwrap()
}

/// A fast-tier sample: CPU percent and memory used percent of a 16 GiB machine.
fn fast(cpu: f32, used_percent: f64) -> RawSample {
    let available = (TOTAL as f64 * (1.0 - used_percent / 100.0)) as u64;
    RawSample {
        cpu: Reading::Value(RawCpu {
            total_percent: cpu,
            logical_cores: 8,
        }),
        memory: Reading::Value(RawMemory {
            total_bytes: TOTAL,
            available_bytes: available,
        }),
        disk_io: Reading::Value(Counters {
            generation: 1,
            a_bytes: 0,
            b_bytes: 0,
        }),
        commit: None,
        network: None,
        volumes: None,
        processes: None,
        gpu: None,
    }
}

fn tree(pids: &[(u32, ProcessRole, u64)]) -> RawProcesses {
    let processes: Vec<TrackedProcess> = pids
        .iter()
        .map(|(pid, role, rss)| TrackedProcess {
            pid: *pid,
            parent_pid: None,
            name: format!("p{pid}"),
            role: role.clone(),
            cpu_percent: Some(1.0),
            rss_bytes: *rss,
            root_pid: *pid,
        })
        .collect();
    RawProcesses {
        count: 300,
        tree: ProcessTreeReading {
            total_rss_bytes: processes.iter().map(|p| p.rss_bytes).sum(),
            total_cpu_percent: processes.len() as f32,
            processes,
            truncated: false,
            provider_sessions: Vec::new(),
        },
        vanished_roots: Vec::new(),
    }
}

/// Runs one ingest at `now`, planning tiers as the governor would.
fn step(engine: &mut Engine, now: Duration, raw: RawSample) -> Ingested {
    let tiers = engine.plan_tiers(now);
    engine.ingest(tiers, raw, now, 1_800_000_000_000 + now.as_millis() as i64)
}

#[test]
fn a_cpu_warm_up_sample_takes_the_second_measurement_at_the_fast_cadence() {
    // The OS probe's first CPU reading is always "warming up": admission is held until the
    // second measurement, which the idle cadence would otherwise delay by 15 s at every launch.
    let mut e = engine(ResourceMode::Balanced);
    let mut warming = fast(10.0, 40.0);
    warming.cpu = Reading::unknown("warming up: needs a second measurement");
    let out = step(&mut e, secs(0), warming);
    assert_eq!(out.snapshot.sampling.reason, CadenceReason::WarmingUp);
    assert_eq!(out.snapshot.sampling.next_interval_ms, 1_000);
    assert_eq!(out.snapshot.sampling.consecutive_failures, 0);
    assert_eq!(e.next_delay(), (secs(1), CadenceReason::WarmingUp));

    // The second measurement arrives: the normal idle cadence resumes.
    let out = step(&mut e, secs(1), fast(10.0, 40.0));
    assert_eq!(out.snapshot.sampling.reason, CadenceReason::Idle);
    assert_eq!(out.snapshot.sampling.next_interval_ms, 15_000);

    // Any other unknown CPU reading keeps the ordinary cadence.
    let mut unknown = fast(10.0, 40.0);
    unknown.cpu = Reading::unknown("CPU counter returned an invalid value");
    let out = step(&mut e, secs(16), unknown);
    assert_eq!(out.snapshot.sampling.reason, CadenceReason::Idle);
    assert_eq!(out.snapshot.sampling.next_interval_ms, 15_000);
}

#[test]
fn adaptive_interval_follows_activity_pressure_and_failures() {
    let mut e = engine(ResourceMode::Balanced);
    // Idle and calm: 15 s.
    let out = step(&mut e, secs(0), fast(10.0, 40.0));
    assert_eq!(out.snapshot.sampling.reason, CadenceReason::Idle);
    assert_eq!(out.snapshot.sampling.next_interval_ms, 15_000);

    // Agent work starts: 1 Hz.
    assert!(e.set_activity(Activity {
        active_tasks: 2,
        resource_view_open: false
    }));
    assert!(!e.set_activity(Activity {
        active_tasks: 2,
        resource_view_open: false
    }));
    assert_eq!(e.next_delay(), (secs(1), CadenceReason::ActiveWork));

    // Work ends; CPU climbs to within the approach margin of Elevated (Balanced: 65 − 10).
    e.set_activity(Activity::default());
    let mut now = secs(0);
    let mut reasons = Vec::new();
    for _ in 0..6 {
        now += e.next_delay().0;
        let out = step(&mut e, now, fast(58.0, 40.0));
        reasons.push((
            out.snapshot.sampling.next_interval_ms,
            out.snapshot.sampling.reason,
        ));
    }
    // The 10 s EMA needs two idle intervals to climb from 10 into the approach band [55, 65);
    // from then on the sampler watches at 0.2 Hz.
    assert_eq!(reasons[0], (15_000, CadenceReason::Idle), "{reasons:?}");
    assert!(
        reasons[1..]
            .iter()
            .all(|r| *r == (5_000, CadenceReason::PressureDeveloping)),
        "{reasons:?}"
    );

    // CPU falls back: idle cadence resumes once the smoothed value leaves the approach band.
    for _ in 0..10 {
        now += e.next_delay().0;
        step(&mut e, now, fast(5.0, 40.0));
    }
    assert_eq!(e.next_delay(), (secs(15), CadenceReason::Idle));

    // A resource view opens: 1 Hz regardless of pressure.
    e.set_activity(Activity {
        active_tasks: 0,
        resource_view_open: true,
    });
    assert_eq!(e.next_delay(), (secs(1), CadenceReason::ResourceViewOpen));

    // Failures back off from the current base.
    e.ingest_failure(0, "probe failed");
    assert_eq!(e.next_delay(), (secs(2), CadenceReason::Backoff));
    e.ingest_failure(0, "probe failed");
    assert_eq!(e.next_delay().0, secs(4));
    // One good sample resets the backoff.
    now += secs(4);
    step(&mut e, now, fast(5.0, 40.0));
    assert_eq!(e.next_delay(), (secs(1), CadenceReason::ResourceViewOpen));
}

#[test]
fn slow_tier_runs_at_most_every_five_seconds_at_1_hz() {
    let mut e = engine(ResourceMode::Balanced);
    e.set_activity(Activity {
        active_tasks: 1,
        resource_view_open: false,
    });
    let mut slow = Vec::new();
    let mut processes = Vec::new();
    for s in 0..=12 {
        let tiers = e.plan_tiers(secs(s));
        if tiers.slow {
            slow.push(s);
        }
        if tiers.processes {
            processes.push(s);
        }
        let mut raw = fast(10.0, 40.0);
        if tiers.processes {
            raw.processes = Some(Reading::Value(tree(&[(
                100,
                ProcessRole::KalCodeSelf,
                MIB,
            )])));
        }
        let out = e.ingest(tiers, raw, secs(s), 0);
        // Between slow refreshes the tree is carried forward, not dropped.
        assert!(out.snapshot.kalcode_tree.is_value());
        assert_eq!(out.snapshot.process_count, Reading::Value(300));
        assert_eq!(out.snapshot.sampling.refreshed, tiers);
    }
    assert_eq!(slow, vec![0, 5, 10]);
    assert_eq!(processes, vec![0, 10]);
    // Registering a process makes the process tier due at the next sample.
    e.track(TrackedRoot {
        pid: 7,
        role: ProcessRole::Descendant,
    });
    assert!(e.plan_tiers(secs(13)).processes);
}

#[test]
fn rates_need_two_samples_and_restart_when_devices_change() {
    let mut e = engine(ResourceMode::Balanced);
    let mut raw = fast(10.0, 40.0);
    raw.disk_io = Reading::Value(Counters {
        generation: 7,
        a_bytes: 1_000,
        b_bytes: 5_000,
    });
    let first = step(&mut e, secs(0), raw);
    assert!(
        matches!(first.snapshot.disk_io, Reading::Unknown(_)),
        "warming up"
    );

    let mut raw = fast(10.0, 40.0);
    raw.disk_io = Reading::Value(Counters {
        generation: 7,
        a_bytes: 1_000 + 30 * MIB,
        b_bytes: 5_000 + 15 * MIB,
    });
    let second = step(&mut e, secs(15), raw);
    assert_eq!(
        second.snapshot.disk_io,
        Reading::Value(IoRate {
            read_bytes_per_sec: 2 * MIB,
            write_bytes_per_sec: MIB
        })
    );

    // A new volume changes the generation: no burst, measure again.
    let mut raw = fast(10.0, 40.0);
    raw.disk_io = Reading::Value(Counters {
        generation: 8,
        a_bytes: u64::MAX / 2,
        b_bytes: 0,
    });
    let third = step(&mut e, secs(30), raw);
    assert!(matches!(third.snapshot.disk_io, Reading::Unknown(_)));

    // Counters going backwards (device reset) are not a negative rate.
    let mut raw = fast(10.0, 40.0);
    raw.disk_io = Reading::Value(Counters {
        generation: 8,
        a_bytes: 0,
        b_bytes: 0,
    });
    let fourth = step(&mut e, secs(45), raw);
    assert!(matches!(fourth.snapshot.disk_io, Reading::Unknown(_)));
}

#[test]
fn hysteresis_through_the_engine_rises_and_falls_without_flapping() {
    let mut e = engine(ResourceMode::Balanced); // CPU 65 / 85 / 95
    e.set_activity(Activity {
        active_tasks: 1,
        resource_view_open: false,
    });
    let mut transitions = Vec::new();
    let mut now = secs(0);
    // Calm, then a sustained 100 % load for 60 s, then noisy load around 60 %, then calm.
    let script: Vec<f32> = std::iter::repeat_n(10.0, 5)
        .chain(std::iter::repeat_n(100.0, 60))
        .chain((0..60).map(|i| if i % 2 == 0 { 70.0 } else { 50.0 }))
        .chain(std::iter::repeat_n(5.0, 90))
        .collect();
    for cpu in script {
        let out = step(&mut e, now, fast(cpu, 40.0));
        transitions.extend(
            out.transitions
                .into_iter()
                .filter(|t| t.resource == ResourceKind::Cpu),
        );
        now += secs(1);
    }
    let path: Vec<(PressureLevel, PressureLevel)> =
        transitions.iter().map(|t| (t.from, t.to)).collect();
    // Rises level by level as the 10 s EMA climbs; falls one level per 20 s dwell; the 50/70
    // oscillation (mean 60, inside Elevated's exit margin) never flaps.
    assert_eq!(
        path,
        vec![
            (Normal, Elevated),
            (Elevated, High),
            (High, Critical),
            (Critical, High),
            (High, Elevated),
            (Elevated, Normal)
        ],
        "{transitions:#?}"
    );
    for t in &transitions {
        assert_eq!(t.mode, ModeKind::Balanced);
        assert_eq!(t.signal, Signal::CpuPercent);
        assert_eq!(t.threshold, ModeLimits::balanced().cpu.threshold(t.to));
    }
}

#[test]
fn startup_under_pressure_reports_a_transition_from_normal() {
    let mut e = engine(ResourceMode::Balanced);
    let out = step(&mut e, secs(0), fast(10.0, 97.0));
    let memory: Vec<_> = out
        .transitions
        .iter()
        .filter(|t| t.resource == ResourceKind::Memory)
        .collect();
    assert_eq!(memory.len(), 1);
    assert_eq!((memory[0].from, memory[0].to), (Normal, Critical));
    // Same level again: no new transition.
    let out = step(&mut e, secs(1), fast(10.0, 97.0));
    assert!(out.transitions.is_empty());
}

#[test]
fn mode_change_re_evaluates_thresholds_at_the_next_sample() {
    let mut e = engine(ResourceMode::Balanced);
    let out = step(&mut e, secs(0), fast(72.0, 40.0));
    assert_eq!(
        out.snapshot.pressure.level(ResourceKind::Cpu),
        Some(Elevated)
    );

    let change = e.set_mode(ResourceMode::Conservative).unwrap();
    assert_eq!(
        change,
        Some(ModeChange {
            from: ModeKind::Balanced,
            to: ModeKind::Conservative
        })
    );
    assert_eq!(
        e.set_mode(ResourceMode::Conservative).unwrap(),
        None,
        "no-op"
    );
    let out = step(&mut e, secs(1), fast(72.0, 40.0));
    assert_eq!(out.snapshot.mode, ModeKind::Conservative);
    assert_eq!(out.snapshot.pressure.level(ResourceKind::Cpu), Some(High));
    assert_eq!(out.transitions[0].mode, ModeKind::Conservative);

    // A looser mode applies at once (no dwell wait after a mode change).
    e.set_mode(ResourceMode::Performance).unwrap();
    let out = step(&mut e, secs(2), fast(72.0, 40.0));
    assert_eq!(out.snapshot.pressure.level(ResourceKind::Cpu), Some(Normal));
    assert_eq!(
        (out.transitions[0].from, out.transitions[0].to),
        (High, Normal)
    );

    // Invalid custom limits are rejected and the mode is unchanged.
    let bad = crate::CustomLimits {
        max_agents: 0,
        ..Default::default()
    };
    assert!(e.set_mode(ResourceMode::Custom(bad)).is_err());
    assert_eq!(e.limits().kind, ModeKind::Performance);
}

#[test]
fn unknown_readings_are_listed_and_never_emit_transitions() {
    let mut e = engine(ResourceMode::Balanced);
    step(&mut e, secs(0), fast(90.0, 40.0)); // CPU High
    let mut raw = fast(0.0, 40.0);
    raw.cpu = Reading::unknown("counter failed");
    let out = step(&mut e, secs(1), raw);
    assert!(out.transitions.is_empty(), "unknown is not Normal");
    assert!(out.snapshot.pressure.unknown.contains(&ResourceKind::Cpu));
    assert_eq!(out.snapshot.pressure.level(ResourceKind::Cpu), None);
    assert!(
        out.snapshot
            .pressure
            .unknown
            .contains(&ResourceKind::DiskSpace),
        "not sampled yet"
    );
    // Data returns at the same level: still no transition.
    let out = step(&mut e, secs(2), fast(90.0, 40.0));
    assert!(
        out.transitions
            .iter()
            .all(|t| t.resource != ResourceKind::Cpu)
    );
}

#[test]
fn failed_samples_report_unknown_back_off_and_recover() {
    let mut e = engine(ResourceMode::Balanced);
    step(&mut e, secs(0), fast(10.0, 40.0));
    for n in 1..=3u32 {
        let out = e.ingest_failure(0, "the resource probe failed");
        let s = &out.snapshot;
        assert!(!s.cpu.is_value() && !s.memory.is_value() && !s.kalcode_tree.is_value());
        assert!(s.pressure.entries.is_empty());
        assert_eq!(s.sampling.consecutive_failures, n);
        assert_eq!(s.sampling.reason, CadenceReason::Backoff);
        assert!(out.transitions.is_empty());
    }
    assert_eq!(e.next_delay().0, secs(60), "15 s × 2³ capped at 60 s");

    // A probe that answers but measures nothing also counts as failing.
    let out = step(
        &mut e,
        secs(100),
        RawSample::unknown("operating system refused"),
    );
    assert_eq!(out.snapshot.sampling.consecutive_failures, 4);

    // A CPU warm-up alone is not a failure.
    let mut e2 = engine(ResourceMode::Balanced);
    let mut raw = RawSample::unknown("x");
    raw.cpu = Reading::unknown(WARMING_UP);
    assert_eq!(
        step(&mut e2, secs(0), raw)
            .snapshot
            .sampling
            .consecutive_failures,
        0
    );

    let out = step(&mut e, secs(200), fast(10.0, 40.0));
    assert_eq!(out.snapshot.sampling.consecutive_failures, 0);
    assert_eq!(e.next_delay(), (secs(15), CadenceReason::Idle));
}

#[test]
fn exact_commit_drives_memory_pressure_and_bounds_do_not() {
    let mut e = engine(ResourceMode::Balanced);
    let mut raw = fast(10.0, 40.0);
    raw.commit = Some(Reading::Value(CommitReading {
        limit_bytes: 20 * GIB_FOR_TESTS,
        used: CommitUsed::Exact(19 * GIB_FOR_TESTS), // 95 %: High
    }));
    let out = step(&mut e, secs(0), raw);
    let entry = out.snapshot.pressure.entry(ResourceKind::Memory).unwrap();
    assert_eq!((entry.level, &entry.signal), (High, &Signal::CommitPercent));

    let mut e = engine(ResourceMode::Balanced);
    let mut raw = fast(10.0, 40.0);
    raw.commit = Some(Reading::Value(CommitReading {
        limit_bytes: 17 * GIB_FOR_TESTS,
        used: CommitUsed::AtMost(16 * GIB_FOR_TESTS),
    }));
    let out = step(&mut e, secs(0), raw);
    assert_eq!(
        out.snapshot.pressure.level(ResourceKind::Memory),
        Some(Normal)
    );
}

#[test]
fn workspace_volume_pressure_uses_the_worst_volume_and_forgets_removed_ones() {
    let mut e = engine(ResourceMode::Balanced); // disk 10 240 / 5 120 / 2 048 MiB
    e.set_workspaces(vec![WorkspaceRoot {
        workspace_id: Some("ws".into()),
        path: "/ws".into(),
    }]);
    let volume = |mount: &str, free_mb: u64| VolumeReading {
        mount: mount.into(),
        workspace_ids: vec![Some("ws".into())],
        total_bytes: 500 * GIB_FOR_TESTS,
        free_bytes: free_mb * MIB,
    };
    let mut raw = fast(10.0, 40.0);
    raw.volumes = Some(Reading::Value(vec![
        volume("C:\\", 50_000),
        volume("D:\\", 4_000),
    ]));
    let out = step(&mut e, secs(0), raw);
    let entry = out
        .snapshot
        .pressure
        .entry(ResourceKind::DiskSpace)
        .unwrap();
    assert_eq!(entry.level, High);
    assert_eq!(
        entry.signal,
        Signal::DiskFreeMb {
            mount: "D:\\".into()
        }
    );

    // No workspace registered any more: nothing to govern (neither an entry nor unknown).
    e.set_workspaces(vec![]);
    let tiers = e.plan_tiers(secs(1));
    assert!(
        tiers.inventory && tiers.slow,
        "workspace change forces a refresh"
    );
    let mut raw = fast(10.0, 40.0);
    raw.volumes = Some(Reading::Value(vec![]));
    let out = e.ingest(tiers, raw, secs(1), 0);
    assert_eq!(out.snapshot.pressure.level(ResourceKind::DiskSpace), None);
    assert!(
        !out.snapshot
            .pressure
            .unknown
            .contains(&ResourceKind::DiskSpace)
    );
    assert!(
        e.trackers
            .keys()
            .all(|s| !matches!(s, Signal::DiskFreeMb { .. }))
    );
}

#[test]
fn vanished_roots_stop_being_tracked() {
    let mut e = engine(ResourceMode::Balanced);
    let role = ProcessRole::Provider {
        provider: ProviderId::new("codex"),
        thread_id: None,
    };
    e.track(TrackedRoot {
        pid: 500,
        role: role.clone(),
    });
    e.track(TrackedRoot {
        pid: 501,
        role: role.clone(),
    });
    e.track(TrackedRoot {
        pid: 500,
        role: role.clone(),
    }); // re-registering replaces
    assert_eq!(e.tracked_roots().len(), 2);
    assert_eq!(e.probe_plan(e.plan_tiers(secs(0))).roots.len(), 2);
    let mut raw = fast(10.0, 40.0);
    let mut processes = tree(&[(100, ProcessRole::KalCodeSelf, MIB), (500, role, MIB)]);
    processes.vanished_roots = vec![501];
    raw.processes = Some(Reading::Value(processes));
    step(&mut e, secs(0), raw);
    assert_eq!(
        e.tracked_roots().iter().map(|r| r.pid).collect::<Vec<_>>(),
        vec![500]
    );
    e.untrack(500);
    assert!(e.tracked_roots().is_empty());
}

#[test]
fn process_tier_failure_is_unknown_not_empty() {
    let mut e = engine(ResourceMode::Balanced);
    let mut raw = fast(10.0, 40.0);
    raw.processes = Some(Reading::unknown("the process list is empty"));
    raw.gpu = Some(Reading::unavailable(crate::probe::GPU_UNAVAILABLE));
    let out = step(&mut e, secs(0), raw);
    assert!(matches!(out.snapshot.kalcode_tree, Reading::Unknown(_)));
    assert!(matches!(out.snapshot.process_count, Reading::Unknown(_)));
    assert!(matches!(out.snapshot.gpu, Reading::Unavailable(_)));
}

#[test]
fn snapshots_round_trip_through_json() {
    let mut e = engine(ResourceMode::Balanced);
    let mut raw = fast(30.0, 50.0);
    raw.processes = Some(Reading::Value(tree(&[(
        100,
        ProcessRole::KalCodeSelf,
        MIB,
    )])));
    let out = step(&mut e, secs(0), raw);
    let json = serde_json::to_string(&*out.snapshot).unwrap();
    let back: ResourceSnapshot = serde_json::from_str(&json).unwrap();
    assert_eq!(back, *out.snapshot);
}
