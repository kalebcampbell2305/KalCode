use std::time::Duration;

use kalcode_contracts::agent::ProviderId;
use kalcode_resources::model::{CpuReading, GpuReading, MemoryReading, VolumeReading};
use kalcode_resources::{
    AdmissionReason, AdmissionRequirements, AdmissionState, CapacityRequest, GovernorStatus,
    ModeKind, ModeLimits, Reading, ResourceKind, ResourceSnapshot, RunningWork, admission_max_age,
    capacity, evaluate_admission,
};

const NOW_MS: i64 = 1_800_000_000_000;

fn provider_snapshot() -> ResourceSnapshot {
    let mut snapshot = ResourceSnapshot::unknown("not sampled", ModeKind::Balanced);
    snapshot.seq = 7;
    snapshot.sampled_at_unix_ms = NOW_MS - 1_000;
    snapshot.cpu = Reading::Value(CpuReading {
        total_percent: 20.0,
        smoothed_percent: 20.0,
        logical_cores: 8,
    });
    snapshot.memory = Reading::Value(MemoryReading {
        total_bytes: 16 * 1024 * 1024 * 1024,
        available_bytes: 10 * 1024 * 1024 * 1024,
        used_bytes: 6 * 1024 * 1024 * 1024,
        used_percent: 37.5,
        smoothed_used_percent: 37.5,
        smoothed_available_bytes: 10 * 1024 * 1024 * 1024,
        commit: Reading::Unavailable("not exposed on this platform".into()),
    });
    snapshot
}

fn advice(snapshot: &ResourceSnapshot, running: RunningWork) -> kalcode_resources::CapacityAdvice {
    capacity(
        snapshot,
        &ModeLimits::balanced(),
        &running,
        &CapacityRequest {
            provider: Some(ProviderId::new("codex")),
        },
    )
}

#[test]
fn ordinary_provider_work_ignores_optional_disk_and_gpu_telemetry() {
    let snapshot = provider_snapshot();
    let advice = advice(&snapshot, RunningWork::default());
    assert!(matches!(
        advice.data,
        kalcode_resources::DataQuality::Partial { .. }
    ));

    let decision = evaluate_admission(
        &GovernorStatus::Running,
        Some(&snapshot),
        Some(advice),
        AdmissionRequirements::provider_task(),
        NOW_MS,
        admission_max_age(&snapshot),
    );

    assert_eq!(decision.state, AdmissionState::Allowed);
    assert!(decision.reasons.is_empty());
    assert_eq!(decision.snapshot_seq, Some(7));
}

#[test]
fn missing_mandatory_cpu_or_memory_holds_with_the_actual_reading_state() {
    let mut snapshot = provider_snapshot();
    snapshot.cpu = Reading::Unknown("warming up".into());
    snapshot.memory = Reading::Unavailable("memory probe unavailable".into());
    let decision = evaluate_admission(
        &GovernorStatus::Running,
        Some(&snapshot),
        Some(advice(&snapshot, RunningWork::default())),
        AdmissionRequirements::provider_task(),
        NOW_MS,
        admission_max_age(&snapshot),
    );

    assert_eq!(decision.state, AdmissionState::Held);
    assert!(decision.reasons.iter().any(|reason| matches!(
        reason,
        AdmissionReason::RequiredTelemetryUnknown {
            resource: ResourceKind::Cpu,
            ..
        }
    )));
    assert!(decision.reasons.iter().any(|reason| matches!(
        reason,
        AdmissionReason::RequiredTelemetryUnavailable {
            resource: ResourceKind::Memory,
            ..
        }
    )));
}

#[test]
fn heavy_work_can_require_disk_and_gpu_without_changing_provider_policy() {
    let snapshot = provider_snapshot();
    let requirements = AdmissionRequirements {
        disk_space: true,
        gpu: true,
        ..AdmissionRequirements::provider_task()
    };
    let decision = evaluate_admission(
        &GovernorStatus::Running,
        Some(&snapshot),
        Some(advice(&snapshot, RunningWork::default())),
        requirements,
        NOW_MS,
        admission_max_age(&snapshot),
    );

    assert_eq!(decision.state, AdmissionState::Held);
    assert!(decision.reasons.iter().any(|reason| matches!(
        reason,
        AdmissionReason::RequiredTelemetryUnknown {
            resource: ResourceKind::DiskSpace,
            ..
        }
    )));
    assert!(decision.reasons.iter().any(|reason| matches!(
        reason,
        AdmissionReason::RequiredTelemetryUnknown {
            resource: ResourceKind::Gpu,
            ..
        }
    )));
}

#[test]
fn malformed_cpu_and_memory_values_are_not_accepted_as_telemetry() {
    let mut snapshot = provider_snapshot();
    snapshot.cpu = Reading::Value(CpuReading {
        total_percent: f32::NAN,
        smoothed_percent: f32::NAN,
        logical_cores: 0,
    });
    snapshot.memory = Reading::Value(MemoryReading {
        total_bytes: 0,
        available_bytes: 1,
        used_bytes: 0,
        used_percent: f32::NAN,
        smoothed_used_percent: f32::NAN,
        smoothed_available_bytes: 1,
        commit: Reading::Unavailable("not exposed on this platform".into()),
    });

    let decision = evaluate_admission(
        &GovernorStatus::Running,
        Some(&snapshot),
        Some(advice(&snapshot, RunningWork::default())),
        AdmissionRequirements::provider_task(),
        NOW_MS,
        admission_max_age(&snapshot),
    );

    assert_eq!(decision.state, AdmissionState::Held);
    assert!(decision.reasons.iter().any(|reason| matches!(
        reason,
        AdmissionReason::RequiredTelemetryUnknown {
            resource: ResourceKind::Cpu,
            ..
        }
    )));
    assert!(decision.reasons.iter().any(|reason| matches!(
        reason,
        AdmissionReason::RequiredTelemetryUnknown {
            resource: ResourceKind::Memory,
            ..
        }
    )));
}

#[test]
fn disk_required_work_holds_when_no_workspace_volume_was_measured() {
    let mut snapshot = provider_snapshot();
    snapshot.volumes = Reading::Value(Vec::new());
    let decision = evaluate_admission(
        &GovernorStatus::Running,
        Some(&snapshot),
        Some(advice(&snapshot, RunningWork::default())),
        AdmissionRequirements::background_heavy(),
        NOW_MS,
        admission_max_age(&snapshot),
    );

    assert_eq!(decision.state, AdmissionState::Held);
    assert!(decision.reasons.iter().any(|reason| matches!(
        reason,
        AdmissionReason::RequiredTelemetryUnknown {
            resource: ResourceKind::DiskSpace,
            ..
        }
    )));
}

#[test]
fn gpu_required_work_checks_nested_gpu_and_vram_sensors() {
    let mut snapshot = provider_snapshot();
    snapshot.volumes = Reading::Value(vec![VolumeReading {
        mount: "C:\\".into(),
        workspace_ids: vec![Some("workspace-1".into())],
        total_bytes: 1_000,
        free_bytes: 500,
    }]);
    snapshot.gpu = Reading::Value(GpuReading {
        utilization_percent: Reading::Unavailable("GPU utilization is unsupported".into()),
        vram_used_bytes: Reading::Unknown("VRAM is warming up".into()),
        vram_total_bytes: Reading::Unknown("VRAM is warming up".into()),
    });
    let decision = evaluate_admission(
        &GovernorStatus::Running,
        Some(&snapshot),
        Some(advice(&snapshot, RunningWork::default())),
        AdmissionRequirements::gpu_heavy(),
        NOW_MS,
        admission_max_age(&snapshot),
    );

    assert_eq!(decision.state, AdmissionState::Held);
    assert!(decision.reasons.iter().any(|reason| matches!(
        reason,
        AdmissionReason::RequiredTelemetryUnavailable {
            resource: ResourceKind::Gpu,
            ..
        }
    )));
    assert!(decision.reasons.iter().any(|reason| matches!(
        reason,
        AdmissionReason::RequiredTelemetryUnknown {
            resource: ResourceKind::Vram,
            ..
        }
    )));
}

#[test]
fn non_running_governor_and_missing_snapshot_fail_closed() {
    let decision = evaluate_admission(
        &GovernorStatus::Degraded {
            reason: "sampling is failing".into(),
        },
        None,
        None,
        AdmissionRequirements::provider_task(),
        NOW_MS,
        Duration::from_secs(45),
    );

    assert_eq!(decision.state, AdmissionState::Held);
    assert!(
        decision
            .reasons
            .iter()
            .any(|reason| matches!(reason, AdmissionReason::GovernorNotReady { .. }))
    );
    assert!(decision.reasons.contains(&AdmissionReason::SnapshotMissing));
    assert!(
        decision
            .reasons
            .contains(&AdmissionReason::CapacityUnavailable)
    );
}

#[test]
fn stale_and_future_snapshots_fail_closed() {
    let mut stale = provider_snapshot();
    stale.sampled_at_unix_ms = NOW_MS - 45_001;
    let stale_decision = evaluate_admission(
        &GovernorStatus::Running,
        Some(&stale),
        Some(advice(&stale, RunningWork::default())),
        AdmissionRequirements::provider_task(),
        NOW_MS,
        Duration::from_secs(45),
    );
    assert!(stale_decision.reasons.iter().any(|reason| matches!(
        reason,
        AdmissionReason::SnapshotStale {
            age_ms: 45_001,
            max_age_ms: 45_000
        }
    )));

    let mut future = provider_snapshot();
    future.sampled_at_unix_ms = NOW_MS + 1;
    let future_decision = evaluate_admission(
        &GovernorStatus::Running,
        Some(&future),
        Some(advice(&future, RunningWork::default())),
        AdmissionRequirements::provider_task(),
        NOW_MS,
        Duration::from_secs(45),
    );
    assert!(
        future_decision
            .reasons
            .iter()
            .any(|reason| matches!(reason, AdmissionReason::SnapshotFromFuture { .. }))
    );
}

#[test]
fn zero_capacity_preserves_the_typed_capacity_holds() {
    let snapshot = provider_snapshot();
    let running = RunningWork {
        agents: ModeLimits::balanced().max_agents,
        ..RunningWork::default()
    };
    let decision = evaluate_admission(
        &GovernorStatus::Running,
        Some(&snapshot),
        Some(advice(&snapshot, running)),
        AdmissionRequirements::provider_task(),
        NOW_MS,
        admission_max_age(&snapshot),
    );

    assert_eq!(decision.state, AdmissionState::Held);
    assert!(decision.reasons.iter().any(|reason| matches!(
        reason,
        AdmissionReason::Capacity { holds } if !holds.is_empty()
    )));
}

#[test]
fn a_mode_change_holds_until_pressure_is_sampled_under_the_new_mode() {
    let snapshot = provider_snapshot();
    let performance = capacity(
        &snapshot,
        &ModeLimits::performance(),
        &RunningWork::default(),
        &CapacityRequest::default(),
    );
    let decision = evaluate_admission(
        &GovernorStatus::Running,
        Some(&snapshot),
        Some(performance),
        AdmissionRequirements::provider_task(),
        NOW_MS,
        admission_max_age(&snapshot),
    );

    assert_eq!(decision.state, AdmissionState::Held);
    assert!(decision.reasons.iter().any(|reason| matches!(
        reason,
        AdmissionReason::SnapshotModeMismatch {
            snapshot_mode: ModeKind::Balanced,
            active_mode: ModeKind::Performance,
        }
    )));
}

#[test]
fn freshness_window_tracks_cadence_with_safe_bounds() {
    let mut snapshot = provider_snapshot();
    snapshot.sampling.next_interval_ms = 1_000;
    assert_eq!(admission_max_age(&snapshot), Duration::from_secs(5));
    snapshot.sampling.next_interval_ms = 15_000;
    assert_eq!(admission_max_age(&snapshot), Duration::from_secs(45));
    snapshot.sampling.next_interval_ms = u64::MAX;
    assert_eq!(admission_max_age(&snapshot), Duration::from_secs(45));
}
