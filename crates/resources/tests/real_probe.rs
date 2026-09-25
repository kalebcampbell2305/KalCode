//! The real probe on this machine: values where the platform exposes them, honest `Unknown` /
//! `Unavailable` otherwise, and never a hang.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::time::{Duration, Instant};

use kalcode_resources::model::{ProcessRole, Tiers};
use kalcode_resources::probe::{
    GPU_UNAVAILABLE, ProbePlan, SysinfoProbe, SystemProbe, WorkspaceRoot,
};
use kalcode_resources::{
    Activity, Governor, GovernorConfig, GovernorStatus, Reading, ResourceMode,
};

#[test]
fn real_probe_measures_this_machine() {
    let mut probe = SysinfoProbe::new();
    let cwd = std::env::current_dir().unwrap();
    let workspaces = vec![WorkspaceRoot {
        workspace_id: Some("ws".into()),
        path: cwd,
    }];
    let all = Tiers {
        fast: true,
        slow: true,
        processes: true,
        inventory: true,
    };
    let plan = ProbePlan {
        tiers: all,
        self_pid: std::process::id(),
        roots: &[],
        workspace_roots: &workspaces,
    };

    let first = probe.sample(&plan);
    assert!(
        matches!(first.cpu, Reading::Unknown(_)),
        "CPU needs two measurements"
    );
    let memory = first.memory.value().expect("memory is always measurable");
    assert!(memory.total_bytes > 0 && memory.available_bytes <= memory.total_bytes);
    assert_eq!(first.gpu, Some(Reading::unavailable(GPU_UNAVAILABLE)));
    let processes = first
        .processes
        .as_ref()
        .and_then(|p| p.value())
        .expect("process list");
    assert!(processes.count > 1);
    let me = processes
        .tree
        .processes
        .iter()
        .find(|p| p.pid == std::process::id())
        .expect("self in tree");
    assert_eq!(me.role, ProcessRole::KalCodeSelf);
    assert!(me.rss_bytes > 0);
    assert_eq!(me.cpu_percent, None, "first sight has no CPU figure");
    let volumes = first.volumes.as_ref().unwrap();
    if let Some(volumes) = volumes.value() {
        assert_eq!(volumes.len(), 1);
        assert!(volumes[0].free_bytes <= volumes[0].total_bytes);
    } else {
        // Allowed only when the test runs from a non-local volume.
        assert!(matches!(volumes, Reading::Unknown(_)));
    }
    if cfg!(windows) {
        assert!(first.commit.as_ref().unwrap().is_value());
    } else {
        assert!(matches!(first.commit, Some(Reading::Unavailable(_))));
    }

    std::thread::sleep(Duration::from_millis(300));
    let fast_only = ProbePlan {
        tiers: Tiers {
            fast: true,
            slow: false,
            processes: false,
            inventory: false,
        },
        ..plan
    };
    let second = probe.sample(&fast_only);
    let cpu = second.cpu.value().expect("CPU after warm-up");
    assert!((0.0..=100.0).contains(&cpu.total_percent) && cpu.logical_cores > 0);
    assert!(second.processes.is_none(), "slow tier not requested");

    let third = probe.sample(&plan);
    let processes = third.processes.as_ref().and_then(|p| p.value()).unwrap();
    let me = processes
        .tree
        .processes
        .iter()
        .find(|p| p.pid == std::process::id())
        .unwrap();
    assert!(me.cpu_percent.is_some());
}

#[test]
fn real_governor_starts_samples_and_stops_promptly() {
    let handle = Governor::start(GovernorConfig {
        mode: ResourceMode::Balanced,
        ..GovernorConfig::default()
    })
    .unwrap();
    let started = Instant::now();
    while handle.latest().is_none() {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "no first sample"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    handle.set_activity(Activity {
        active_tasks: 1,
        resource_view_open: false,
    });
    while handle.latest().is_none_or(|s| s.seq < 2) {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "no second sample"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(handle.status(), GovernorStatus::Running);
    let snapshot = handle.latest().unwrap();
    assert!(snapshot.cpu.is_value() && snapshot.memory.is_value());
    let stats = handle.stats();
    assert!(stats.samples >= 2 && stats.failed_samples == 0);
    let stop = Instant::now();
    handle.shutdown();
    assert!(stop.elapsed() < Duration::from_secs(2));
}
