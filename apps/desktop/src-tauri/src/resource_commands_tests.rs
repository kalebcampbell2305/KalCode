use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{
    AgentEvent, AgentEventSink, AgentInput, AgentProvider, AgentSession, AuthState, DetectionState,
    ProviderCapabilities, ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::permissions::{ApprovalDecision, PermissionMode};
use kalcode_contracts::resources::{
    CpuReading, LaunchHoldKind, MemoryReading, ResourcePressure, VolumeReading,
};
use kalcode_resources::{
    AdmissionDecision, AdmissionReason, AdmissionRequirements, AdmissionState, GovernorStatus,
    ModeKind, ModeLimits, PressureLevel, PressureSummary, Reading, ResourceKind, ResourceMode,
    ResourceSnapshot, SamplerStats, Signal, admission_max_age,
};

use super::provider::{ProviderAdmission, ProviderAdmissionPermit, ResourceAdmissionProvider};
use super::{
    ActivityTracker, AgentLaunch, LocalWorkloadEstimate, REPORT_HISTORY_POINTS, ReservationBudget,
    ResourceFreshnessState, ResourceGovernorState, Runtime, freshness, projected_admission,
    recent_history, sampler_stats,
};
#[cfg(feature = "e2e")]
use super::{
    E2eResourceFixtureSelection, classify_e2e_resource_fixture,
    start_e2e_provider_capacity_governor,
};

const NOW_MS: i64 = 1_800_000_000_000;

#[cfg(feature = "e2e")]
#[test]
fn e2e_resource_fixture_requires_exact_opt_in_and_attested_data_root() {
    use std::ffi::OsStr;
    use std::path::Path;

    let path = Path::new("C:/Temp/kalcode-e2e-fixture");
    assert_eq!(
        classify_e2e_resource_fixture(None, Some(path), |_| true),
        E2eResourceFixtureSelection::Real
    );
    assert_eq!(
        classify_e2e_resource_fixture(Some(OsStr::new("provider-capacity-v2")), Some(path), |_| {
            true
        }),
        E2eResourceFixtureSelection::Rejected
    );
    assert_eq!(
        classify_e2e_resource_fixture(Some(OsStr::new("provider-capacity-v1")), None, |_| true),
        E2eResourceFixtureSelection::Rejected
    );
    assert_eq!(
        classify_e2e_resource_fixture(Some(OsStr::new("provider-capacity-v1")), Some(path), |_| {
            false
        },),
        E2eResourceFixtureSelection::Rejected
    );
    assert_eq!(
        classify_e2e_resource_fixture(Some(OsStr::new("provider-capacity-v1")), Some(path), |_| {
            true
        },),
        E2eResourceFixtureSelection::ProviderCapacity
    );
}

#[cfg(feature = "e2e")]
#[test]
fn e2e_provider_sample_uses_canonical_capacity_and_still_enforces_limits() {
    use std::collections::BTreeMap;

    use kalcode_resources::CustomLimits;

    let handle = start_e2e_provider_capacity_governor().expect("fixed fixture governor");
    let deadline = Instant::now() + Duration::from_secs(5);
    while handle.latest().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(handle.latest().is_some(), "fixture sample was not ingested");
    let state = Arc::new(ResourceGovernorState {
        interactive: kalcode_resources::InteractivePriority::default(),
        runtime: Mutex::new(Runtime {
            handle: Some(handle),
            activity: ActivityTracker::default(),
            fallback_status: GovernorStatus::Starting,
        }),
    });

    let admitted = state.report().admission;
    assert_eq!(admitted.state, AdmissionState::Allowed);
    assert!(admitted.additional > 0);

    state.set_active_tasks(32);
    let held = state.report().admission;
    assert_eq!(held.state, AdmissionState::Allowed);
    assert!(held.additional > 0);

    state.set_active_tasks(0);
    let provider = ProviderId::new("codex");
    state
        .set_mode(ResourceMode::Custom(CustomLimits {
            per_provider: BTreeMap::from([(provider.clone(), 0)]),
            ..CustomLimits::default()
        }))
        .expect("valid provider-specific limit");
    let deadline = Instant::now() + Duration::from_secs(5);
    while state.report().snapshot.mode != ModeKind::Custom && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(state.report().snapshot.mode, ModeKind::Custom);
    let provider_denial = match state.reserve_provider_task(provider, &AgentLaunch::default()) {
        Ok(_) => panic!("provider-specific zero limit must deny the reservation"),
        Err(decision) => decision,
    };
    assert_eq!(provider_denial.state, AdmissionState::Held);
    assert_eq!(provider_denial.additional, 0);
    assert!(!provider_denial.reasons.is_empty());
    state.shutdown();
}

fn snapshot(sampled_at_unix_ms: i64) -> ResourceSnapshot {
    let mut snapshot = ResourceSnapshot::unknown("not sampled", ModeKind::Balanced);
    snapshot.seq = 4;
    snapshot.sampled_at_unix_ms = sampled_at_unix_ms;
    snapshot.sampling.next_interval_ms = 1_000;
    snapshot
}

fn allowed(additional: u32) -> AdmissionDecision {
    AdmissionDecision {
        state: AdmissionState::Allowed,
        mode: Some(ModeKind::Balanced),
        additional,
        reasons: Vec::new(),
        snapshot_seq: Some(1),
        sampled_at_unix_ms: Some(NOW_MS),
    }
}

fn held(reason: AdmissionReason) -> AdmissionDecision {
    AdmissionDecision {
        state: AdmissionState::Held,
        mode: Some(ModeKind::Balanced),
        additional: 0,
        reasons: vec![reason],
        snapshot_seq: Some(1),
        sampled_at_unix_ms: Some(NOW_MS),
    }
}

fn deterministic_state() -> Arc<ResourceGovernorState> {
    Arc::new(ResourceGovernorState {
        interactive: kalcode_resources::InteractivePriority::default(),
        runtime: Mutex::new(Runtime {
            handle: None,
            activity: ActivityTracker::default(),
            fallback_status: GovernorStatus::Running,
        }),
    })
}

fn measured_snapshot() -> ResourceSnapshot {
    let mut snapshot = snapshot(NOW_MS);
    snapshot.cpu = Reading::Value(CpuReading {
        total_percent: 50.0,
        smoothed_percent: 50.0,
        logical_cores: 4,
    });
    snapshot.memory = Reading::Value(MemoryReading {
        total_bytes: 8 * 1024 * 1024 * 1024,
        available_bytes: 4 * 1024 * 1024 * 1024,
        used_bytes: 4 * 1024 * 1024 * 1024,
        used_percent: 50.0,
        smoothed_used_percent: 50.0,
        smoothed_available_bytes: 4 * 1024 * 1024 * 1024,
        commit: Reading::unavailable("not exposed by this platform"),
    });
    snapshot.volumes = Reading::Value(vec![VolumeReading {
        mount: "/".into(),
        workspace_ids: vec![None],
        total_bytes: 100 * 1024 * 1024 * 1024,
        free_bytes: 6 * 1024 * 1024 * 1024,
    }]);
    snapshot.pressure = PressureSummary::default();
    snapshot
}

fn projected(
    snapshot: &ResourceSnapshot,
    running: &kalcode_resources::RunningWork,
    estimate: LocalWorkloadEstimate,
    pending: ReservationBudget,
) -> AdmissionDecision {
    let requirements = estimate.requirements();
    projected_admission(
        &GovernorStatus::Running,
        Some(snapshot),
        &ModeLimits::balanced(),
        running,
        &kalcode_resources::CapacityRequest::default(),
        requirements,
        pending,
        estimate.budget(),
        NOW_MS,
    )
}

// Ported from #236's interactive-terminal policy: one user-agent policy now governs panes and
// headless routes alike (AGENTS.md Resource Governor rule).
#[test]
fn user_agents_ignore_cpu_soft_memory_and_missing_telemetry_but_keep_custom_limits() {
    let mut snapshot = measured_snapshot();
    let mut limits = ModeLimits::balanced();
    let request = kalcode_resources::CapacityRequest::default();
    let running = kalcode_resources::RunningWork::default();
    let decide = |snapshot: Option<&ResourceSnapshot>, limits: &ModeLimits| {
        super::user_agent_admission(snapshot, limits, &running, &request, None, NOW_MS, false)
    };
    snapshot.cpu = Reading::Value(CpuReading {
        total_percent: 100.0,
        smoothed_percent: 100.0,
        logical_cores: 4,
    });
    snapshot.pressure.entries.push(ResourcePressure {
        resource: ResourceKind::Cpu,
        level: PressureLevel::Critical,
        signal: Signal::CpuPercent,
        value: 100.0,
        threshold: Some(90.0),
        approaching: false,
    });
    assert_eq!(decide(Some(&snapshot), &limits).state, AdmissionState::Allowed);
    snapshot.cpu = Reading::unknown("not sampled yet");
    snapshot.pressure.entries.push(ResourcePressure {
        resource: ResourceKind::Memory,
        level: PressureLevel::High,
        signal: Signal::MemoryUsedPercent,
        value: 90.0,
        threshold: Some(88.0),
        approaching: false,
    });
    assert_eq!(decide(Some(&snapshot), &limits).state, AdmissionState::Allowed);
    assert_eq!(
        decide(None, &limits).state,
        AdmissionState::Allowed,
        "an unfinished startup sampler is not a real resource failure"
    );
    limits.kind = kalcode_resources::ModeKind::Custom;
    limits.max_agents = 0;
    assert_eq!(
        decide(None, &limits).state,
        AdmissionState::Held,
        "custom count limits do not depend on telemetry"
    );
    assert_eq!(
        decide(Some(&snapshot), &limits).state,
        AdmissionState::Held,
        "an explicit custom agent limit still applies"
    );
}

#[test]
fn user_agents_hold_for_a_full_disk_with_the_truthful_reason() {
    let mut snapshot = measured_snapshot();
    snapshot.volumes = Reading::Value(vec![VolumeReading {
        mount: "/".into(),
        workspace_ids: vec![None],
        total_bytes: 100 * 1024 * 1024 * 1024,
        free_bytes: 200 * 1024 * 1024,
    }]);
    let decision = super::user_agent_admission(
        Some(&snapshot),
        &ModeLimits::balanced(),
        &kalcode_resources::RunningWork::default(),
        &kalcode_resources::CapacityRequest::default(),
        None,
        NOW_MS,
        false,
    );
    assert_eq!(decision.state, AdmissionState::Held);
    assert!(kalcode_resources::decision_codes(&decision).contains(&"disk_full"));
}

#[test]
fn local_workload_estimates_reject_unknown_and_unbounded_values() {
    assert!(LocalWorkloadEstimate::inference(None, Some(512)).is_err());
    assert!(LocalWorkloadEstimate::inference(Some(500), None).is_err());
    assert!(LocalWorkloadEstimate::inference(Some(0), Some(512)).is_err());
    assert!(LocalWorkloadEstimate::inference(Some(64_001), Some(512)).is_err());
    assert!(LocalWorkloadEstimate::inference(Some(500), Some(262_145)).is_err());
    assert!(LocalWorkloadEstimate::acquisition(Some(500), Some(512), None).is_err());
    assert!(LocalWorkloadEstimate::acquisition(Some(500), Some(512), Some(0)).is_err());
    assert!(LocalWorkloadEstimate::acquisition(Some(500), Some(512), Some(1_048_577)).is_err());

    assert!(LocalWorkloadEstimate::inference(Some(64_000), Some(262_144)).is_ok());
    assert!(LocalWorkloadEstimate::acquisition(Some(500), Some(512), Some(1_048_576)).is_ok());
}

#[test]
fn stale_unknown_and_high_pressure_never_consume_local_capacity() {
    let estimate = LocalWorkloadEstimate::inference(Some(250), Some(256)).expect("estimate");
    let state = deterministic_state();

    let mut stale = measured_snapshot();
    stale.sampled_at_unix_ms = NOW_MS - 5_001;
    let stale_result = state.reserve_local_task_with(estimate, |_, running, pending| {
        projected(&stale, running, estimate, pending)
    });
    assert!(matches!(
        stale_result,
        Err(AdmissionDecision {
            state: AdmissionState::Held,
            ..
        })
    ));
    assert_eq!(state.running_work_for_test().agents, 0);

    let mut unknown = measured_snapshot();
    unknown.cpu = Reading::unknown("sample failed");
    let unknown_result = state.reserve_local_task_with(estimate, |_, running, pending| {
        projected(&unknown, running, estimate, pending)
    });
    assert!(matches!(
        unknown_result,
        Err(AdmissionDecision {
            state: AdmissionState::Held,
            ..
        })
    ));
    assert_eq!(state.running_work_for_test().agents, 0);

    let mut pressure = measured_snapshot();
    pressure.pressure.entries.push(ResourcePressure {
        resource: ResourceKind::Cpu,
        level: PressureLevel::High,
        signal: Signal::CpuPercent,
        value: 90.0,
        threshold: Some(85.0),
        approaching: false,
    });
    let pressure_result = state.reserve_local_task_with(estimate, |_, running, pending| {
        projected(&pressure, running, estimate, pending)
    });
    assert!(matches!(
        pressure_result,
        Err(AdmissionDecision {
            state: AdmissionState::Held,
            ..
        })
    ));
    assert_eq!(state.running_work_for_test().agents, 0);
}

#[test]
fn local_reservations_are_atomic_at_the_exact_shared_budget_boundary() {
    let state = deterministic_state();
    let snapshot = Arc::new(measured_snapshot());
    let estimate = LocalWorkloadEstimate::inference(Some(1_000), Some(2_048)).expect("estimate");
    let barrier = Arc::new(Barrier::new(17));
    let mut contenders = Vec::new();

    for _ in 0..16 {
        let state = Arc::clone(&state);
        let snapshot = Arc::clone(&snapshot);
        let barrier = Arc::clone(&barrier);
        contenders.push(std::thread::spawn(move || {
            barrier.wait();
            state.reserve_local_task_with(estimate, |_, running, pending| {
                projected(&snapshot, running, estimate, pending)
            })
        }));
    }
    barrier.wait();
    let reservations: Vec<_> = contenders
        .into_iter()
        .filter_map(|contender| contender.join().expect("contender").ok())
        .collect();

    assert_eq!(reservations.len(), 1);
    assert_eq!(state.running_work_for_test().agents, 1);
    drop(reservations);
    assert_eq!(state.running_work_for_test().agents, 0);
}

#[test]
fn provider_and_local_starts_compete_for_the_same_pending_budget() {
    let state = deterministic_state();
    let snapshot = measured_snapshot();
    let estimate = LocalWorkloadEstimate::inference(Some(1_000), Some(2_048)).expect("estimate");
    let provider = state
        .reserve_provider_task_with_estimate(
            ProviderId::new(ProviderId::CODEX),
            estimate.budget(),
            |_, running, pending| projected(&snapshot, running, estimate, pending),
        )
        .expect("provider gets the exact remaining budget");

    let local = state.reserve_local_task_with(estimate, |_, running, pending| {
        projected(&snapshot, running, estimate, pending)
    });
    assert!(matches!(
        local,
        Err(AdmissionDecision {
            state: AdmissionState::Held,
            ..
        })
    ));
    assert_eq!(state.running_work_for_test().agents, 1);

    drop(provider);
    let local = state
        .reserve_local_task_with(estimate, |_, running, pending| {
            projected(&snapshot, running, estimate, pending)
        })
        .expect("released provider budget is reusable");
    drop(local);
    assert_eq!(state.running_work_for_test().agents, 0);
}

#[test]
fn acquisition_reserves_peak_disk_space_on_the_kalcode_data_volume() {
    let state = deterministic_state();
    let mut snapshot = measured_snapshot();
    let limits = ModeLimits::balanced();
    if let Reading::Value(volumes) = &mut snapshot.volumes {
        volumes[0].free_bytes = (limits.disk_free_mb.high as u64 + 1_024) * 1024 * 1024;
    }
    let estimate =
        LocalWorkloadEstimate::acquisition(Some(250), Some(256), Some(1_024)).expect("estimate");
    let reserve = |running: &kalcode_resources::RunningWork, pending: ReservationBudget| {
        projected_admission(
            &GovernorStatus::Running,
            Some(&snapshot),
            &limits,
            running,
            &kalcode_resources::CapacityRequest::default(),
            AdmissionRequirements::background_heavy(),
            pending,
            estimate.budget(),
            NOW_MS,
        )
    };
    let first = state
        .reserve_local_task_with(estimate, |_, running, pending| reserve(running, pending))
        .expect("exact disk boundary is admitted");
    let second =
        state.reserve_local_task_with(estimate, |_, running, pending| reserve(running, pending));
    assert!(matches!(
        second,
        Err(AdmissionDecision {
            state: AdmissionState::Held,
            ..
        })
    ));
    drop(first);
}

#[test]
fn acquisition_denies_when_the_kalcode_data_volume_is_not_measured() {
    let state = deterministic_state();
    let mut snapshot = measured_snapshot();
    snapshot.volumes = Reading::Value(vec![VolumeReading {
        mount: "/workspace".into(),
        workspace_ids: vec![Some("workspace-id".into())],
        total_bytes: 100 * 1024 * 1024 * 1024,
        free_bytes: 50 * 1024 * 1024 * 1024,
    }]);
    let estimate =
        LocalWorkloadEstimate::acquisition(Some(250), Some(256), Some(1_024)).expect("estimate");

    let decision = state.reserve_local_task_with(estimate, |_, running, pending| {
        projected(&snapshot, running, estimate, pending)
    });
    assert!(matches!(
        decision,
        Err(AdmissionDecision {
            state: AdmissionState::Held,
            ..
        })
    ));
    assert_eq!(state.running_work_for_test().agents, 0);
}

#[test]
fn local_permit_is_held_until_explicit_settlement_and_releases_once() {
    let state = deterministic_state();
    let snapshot = measured_snapshot();
    let estimate = LocalWorkloadEstimate::inference(Some(250), Some(256)).expect("estimate");
    let permit = state
        .reserve_local_task_with(estimate, |_, running, pending| {
            projected(&snapshot, running, estimate, pending)
        })
        .expect("reservation");

    assert_eq!(state.running_work_for_test().agents, 1);
    assert_eq!(state.pending_budget_for_test(), estimate.budget());
    // A cancellation or cleanup request is not settlement; the caller still owns the permit.
    assert_eq!(state.running_work_for_test().agents, 1);
    permit.release();
    permit.release();
    assert_eq!(state.running_work_for_test().agents, 0);
    assert_eq!(
        state.pending_budget_for_test(),
        ReservationBudget::default()
    );
    drop(permit);
    assert_eq!(state.running_work_for_test().agents, 0);
}

#[test]
fn view_visibility_never_clobbers_scheduler_owned_activity() {
    let mut tracker = ActivityTracker::default();
    tracker.set_active_tasks(3);
    tracker.set_view_open(true);
    assert_eq!(tracker.activity().active_tasks, 3);
    assert!(tracker.activity().resource_view_open);

    tracker.set_view_open(false);
    assert_eq!(tracker.activity().active_tasks, 3);
    assert!(!tracker.activity().resource_view_open);
}

#[test]
fn provider_reservations_are_atomic_at_the_capacity_boundary() {
    let state = deterministic_state();
    let barrier = Arc::new(Barrier::new(17));
    let mut contenders = Vec::new();
    for _ in 0..16 {
        let state = Arc::clone(&state);
        let barrier = Arc::clone(&barrier);
        contenders.push(std::thread::spawn(move || {
            barrier.wait();
            state.reserve_provider_task_with(ProviderId::new(ProviderId::CODEX), |_, running, _| {
                let remaining = 2_u32.saturating_sub(running.agents);
                if remaining == 0 {
                    held(AdmissionReason::CapacityUnavailable)
                } else {
                    allowed(remaining)
                }
            })
        }));
    }
    barrier.wait();
    let reservations: Vec<_> = contenders
        .into_iter()
        .filter_map(|contender| contender.join().expect("contender").ok())
        .collect();

    assert_eq!(reservations.len(), 2);
    let running = state.running_work_for_test();
    assert_eq!(running.agents, 2);
    assert_eq!(
        running
            .per_provider
            .get(&ProviderId::new(ProviderId::CODEX)),
        Some(&2)
    );

    drop(reservations);
    assert_eq!(state.running_work_for_test().agents, 0);
}

#[test]
fn held_or_stale_admission_never_consumes_a_slot() {
    let state = deterministic_state();
    let decision =
        match state.reserve_provider_task_with(ProviderId::new(ProviderId::CODEX), |_, _, _| {
            held(AdmissionReason::SnapshotStale {
                age_ms: 5_001,
                max_age_ms: 5_000,
            })
        }) {
            Ok(_) => panic!("stale telemetry must hold"),
            Err(decision) => decision,
        };

    assert_eq!(decision.state, AdmissionState::Held);
    assert_eq!(state.running_work_for_test().agents, 0);
}

#[test]
fn provider_reservations_keep_independent_per_provider_counts() {
    let state = deterministic_state();
    let codex = state
        .reserve_provider_task_with(ProviderId::new(ProviderId::CODEX), |_, _, _| allowed(2))
        .expect("codex reservation");
    let gemini = state
        .reserve_provider_task_with(ProviderId::new(ProviderId::GEMINI_CLI), |_, _, _| {
            allowed(1)
        })
        .expect("gemini reservation");

    let running = state.running_work_for_test();
    assert_eq!(running.agents, 2);
    assert_eq!(
        running
            .per_provider
            .get(&ProviderId::new(ProviderId::CODEX)),
        Some(&1)
    );
    assert_eq!(
        running
            .per_provider
            .get(&ProviderId::new(ProviderId::GEMINI_CLI)),
        Some(&1)
    );

    drop(codex);
    assert_eq!(state.running_work_for_test().agents, 1);
    drop(gemini);
    assert_eq!(state.running_work_for_test().agents, 0);
}

#[test]
fn freshness_distinguishes_current_stale_missing_and_invalid_clock_data() {
    let current = snapshot(NOW_MS - 1_000);
    assert_eq!(
        freshness(Some(&current), NOW_MS, admission_max_age(&current)).state,
        ResourceFreshnessState::Fresh
    );

    let stale = snapshot(NOW_MS - 5_001);
    let stale_result = freshness(Some(&stale), NOW_MS, Duration::from_secs(5));
    assert_eq!(stale_result.state, ResourceFreshnessState::Stale);
    assert_eq!(stale_result.age_ms, Some(5_001));

    assert_eq!(
        freshness(None, NOW_MS, Duration::from_secs(45)).state,
        ResourceFreshnessState::Unavailable
    );

    let future = snapshot(NOW_MS + 1);
    assert_eq!(
        freshness(Some(&future), NOW_MS, Duration::from_secs(5)).state,
        ResourceFreshnessState::Unavailable
    );
}

#[test]
fn duration_stats_are_serialized_as_bounded_integer_milliseconds() {
    let wire = sampler_stats(SamplerStats {
        samples: 9,
        failed_samples: 2,
        slow_tier_samples: 3,
        process_tier_samples: 1,
        total_probe_time: Duration::from_micros(12_900),
        last_probe_time: Duration::from_micros(2_900),
        max_probe_time: Duration::from_micros(5_900),
        max_process_tier_time: Duration::from_micros(5_900),
        dropped_updates: 4,
    });

    assert_eq!(wire.samples, 9);
    assert_eq!(wire.failed_samples, 2);
    assert_eq!(wire.total_probe_ms, 12);
    assert_eq!(wire.last_probe_ms, 2);
    assert_eq!(wire.max_probe_ms, 5);
    assert_eq!(wire.max_process_tier_ms, 5);
    assert_eq!(wire.dropped_updates, 4);

    let json = serde_json::to_value(wire).expect("resource stats serialize");
    assert_eq!(json["totalProbeMs"], 12);
    assert_eq!(json["lastProbeMs"], 2);
    assert!(json.get("total_probe_ms").is_none());
}

#[test]
fn mode_command_accepts_the_frontend_tagged_shape() {
    let mode: ResourceMode = serde_json::from_value(serde_json::json!({
        "mode": "performance"
    }))
    .expect("preset resource mode deserializes");
    assert_eq!(mode, ResourceMode::Performance);
}

#[test]
fn ipc_history_keeps_only_the_most_recent_bounded_points() {
    let history = (0..REPORT_HISTORY_POINTS + 5)
        .map(|seq| kalcode_resources::HistoryPoint {
            seq: seq as u64,
            at_unix_ms: seq as i64,
            cpu_percent: None,
            memory_used_percent: None,
            kalcode_cpu_percent: None,
            kalcode_rss_mb: None,
            disk_read_bytes_per_sec: None,
            disk_write_bytes_per_sec: None,
            overall: None,
        })
        .collect();

    let bounded = recent_history(history);
    assert_eq!(bounded.len(), REPORT_HISTORY_POINTS);
    assert_eq!(bounded.first().map(|point| point.seq), Some(5));
    assert_eq!(
        bounded.last().map(|point| point.seq),
        Some((REPORT_HISTORY_POINTS + 4) as u64)
    );
}

/// No sampler: visible, background work is held (fail-closed), and a coding agent the person
/// starts is still admitted — missing telemetry is not evidence of pressure.
#[test]
fn missing_sampler_is_visible_holds_background_work_and_admits_agents() {
    let state = ResourceGovernorState {
        interactive: kalcode_resources::InteractivePriority::default(),
        runtime: Mutex::new(Runtime {
            handle: None,
            activity: ActivityTracker::default(),
            fallback_status: GovernorStatus::Failed {
                reason: "the resource governor could not start".into(),
            },
        }),
    };

    let report = state.report_at(NOW_MS);
    assert!(matches!(report.status, GovernorStatus::Failed { .. }));
    assert_eq!(report.freshness.state, ResourceFreshnessState::Unavailable);
    assert_eq!(report.admission.state, AdmissionState::Allowed);
    assert!(report.admission.reasons.is_empty());
    let background = &report.background_admission;
    assert_eq!(background.state, AdmissionState::Held);
    assert!(
        background
            .reasons
            .iter()
            .any(|reason| matches!(reason, AdmissionReason::GovernorNotReady { .. }))
    );
    assert!(
        background
            .reasons
            .contains(&AdmissionReason::SnapshotMissing)
    );
    assert!(
        background
            .reasons
            .contains(&AdmissionReason::CapacityUnavailable)
    );
}

#[test]
fn shutdown_is_idempotent_when_startup_failed() {
    let state = ResourceGovernorState {
        interactive: kalcode_resources::InteractivePriority::default(),
        runtime: Mutex::new(Runtime {
            handle: None,
            activity: ActivityTracker::default(),
            fallback_status: GovernorStatus::Failed {
                reason: "the resource governor could not start".into(),
            },
        }),
    };

    state.shutdown();
    state.shutdown();
    assert_eq!(state.report_at(NOW_MS).status, GovernorStatus::Stopped);
}

#[test]
fn real_sampler_produces_a_bounded_snapshot_and_stops_cleanly() {
    let state = ResourceGovernorState::start();
    let deadline = Instant::now() + Duration::from_secs(10);
    let report = loop {
        let report = state.report();
        if report.snapshot.seq > 0 || matches!(report.status, GovernorStatus::Failed { .. }) {
            break report;
        }
        assert!(
            Instant::now() < deadline,
            "real sampler did not publish within 10 seconds"
        );
        std::thread::sleep(Duration::from_millis(20));
    };

    assert!(matches!(report.status, GovernorStatus::Running));
    assert!(report.snapshot.seq > 0);
    assert!(report.stats.samples > 0);
    let shutdown_started = Instant::now();
    state.shutdown();
    assert!(
        shutdown_started.elapsed() < Duration::from_secs(5),
        "resource sampler did not stop within five seconds"
    );
    assert_eq!(state.report().status, GovernorStatus::Stopped);
}

#[derive(Clone, Copy)]
enum FakeStart {
    Fail,
    /// The OS refused to create the process (out of memory or process slots).
    Exhausted,
    ExitBeforeReturn,
    Live {
        exit_on_terminate: bool,
    },
}

/// `std::io::Error`'s text for an OS refusal to create another process on this platform.
#[cfg(windows)]
const EXHAUSTED_SPAWN: &str =
    "Insufficient system resources exist to complete the requested service. (os error 1450)";
#[cfg(not(windows))]
const EXHAUSTED_SPAWN: &str = "Resource temporarily unavailable (os error 11)";

struct FakeAdmission {
    active: Arc<AtomicUsize>,
    reservations: Arc<AtomicUsize>,
    child_active: Arc<AtomicBool>,
    released_while_active: Arc<AtomicBool>,
    hold: Arc<AtomicBool>,
}

struct FakePermit {
    active: Arc<AtomicUsize>,
    child_active: Arc<AtomicBool>,
    released_while_active: Arc<AtomicBool>,
}

impl Drop for FakePermit {
    fn drop(&mut self) {
        if self.child_active.load(Ordering::SeqCst) {
            self.released_while_active.store(true, Ordering::SeqCst);
        }
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

impl ProviderAdmissionPermit for FakePermit {}

impl ProviderAdmission for FakeAdmission {
    fn reserve(
        &self,
        _provider: ProviderId,
        _launch: &AgentLaunch,
    ) -> Result<Box<dyn ProviderAdmissionPermit>, ProviderError> {
        if self.hold.load(Ordering::SeqCst) {
            return Err(ProviderError::ResourcesHeld(
                kalcode_resources::launch_hold(
                    &held(AdmissionReason::HardPressure {
                        pressure: kalcode_resources::HardPressure::MemoryCritical {
                            available_mb: 300,
                            floor_mb: 634,
                        },
                    }),
                    Duration::from_secs(1),
                    kalcode_resources::ADMISSION_WAIT_LIMIT,
                )
                .expect("hard pressure is a user-facing hold"),
            ));
        }
        self.reservations.fetch_add(1, Ordering::SeqCst);
        self.active.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(FakePermit {
            active: Arc::clone(&self.active),
            child_active: Arc::clone(&self.child_active),
            released_while_active: Arc::clone(&self.released_while_active),
        }))
    }
}

struct FakeProvider {
    id: &'static str,
    start: FakeStart,
    starts: Arc<AtomicUsize>,
    child_active: Arc<AtomicBool>,
}

impl AgentProvider for FakeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::new(self.id)
    }

    fn display_name(&self) -> &str {
        "Codex fixture"
    }

    fn detect(&self) -> ProviderDetection {
        ProviderDetection {
            provider_id: self.id(),
            display_name: self.display_name().into(),
            state: DetectionState::Installed,
            display_path: None,
            version: Some("1.0.0".into()),
            minimum_version: None,
            auth: AuthState::Authenticated,
            message: None,
            checked_at: "2026-09-25T00:00:00Z".into(),
        }
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: true,
            interrupt: true,
            resume: true,
            host_approvals: false,
            models: Vec::new(),
            permission_mappings: Vec::new(),
            interactive: None,
            tools: Vec::new(),
        }
    }

    fn start_session(
        &self,
        _config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        match self.start {
            FakeStart::Fail => Err(ProviderError::Start("spawn failed".into())),
            FakeStart::Exhausted => Err(ProviderError::Start(format!(
                "failed to spawn the provider: {EXHAUSTED_SPAWN}"
            ))),
            FakeStart::ExitBeforeReturn => {
                self.child_active.store(true, Ordering::SeqCst);
                self.child_active.store(false, Ordering::SeqCst);
                sink.emit(AgentEvent::Exited { exit_code: Some(0) });
                Ok(Box::new(FakeSession {
                    child_active: Arc::clone(&self.child_active),
                    sink: Mutex::new(Some(sink)),
                    exit_on_terminate: false,
                }))
            }
            FakeStart::Live { exit_on_terminate } => Ok(Box::new(FakeSession {
                child_active: Arc::clone(&self.child_active),
                sink: Mutex::new(Some(sink)),
                exit_on_terminate,
            })),
        }
    }
}

/// A turn-based session: each `send` runs a turn process (`child_active`) until the turn ends.
/// "fail" is refused before anything runs; "quick" completes before `send` returns.
struct FakeSession {
    child_active: Arc<AtomicBool>,
    sink: Mutex<Option<Box<dyn AgentEventSink>>>,
    exit_on_terminate: bool,
}

impl FakeSession {
    fn emit(&self, event: AgentEvent) {
        if let Some(sink) = self
            .sink
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            sink.emit(event);
        }
    }
}

impl AgentSession for FakeSession {
    fn provider_session_id(&self) -> Option<String> {
        Some("fixture-session".into())
    }

    fn send(&self, input: AgentInput) -> Result<(), ProviderError> {
        let AgentInput::Text { text } = input;
        if text == "fail" {
            return Err(ProviderError::Start("spawn failed".into()));
        }
        self.child_active.store(true, Ordering::SeqCst);
        if text == "quick" {
            self.child_active.store(false, Ordering::SeqCst);
            self.emit(AgentEvent::TurnCompleted { ok: true });
        }
        Ok(())
    }

    fn interrupt(&self) -> Result<(), ProviderError> {
        // The turn process is killed and reaped before the provider reports the interrupt.
        self.child_active.store(false, Ordering::SeqCst);
        self.emit(AgentEvent::Status {
            status: kalcode_contracts::threads::ThreadStatus::Interrupted,
            detail: None,
        });
        Ok(())
    }

    fn terminate(&self) -> Result<(), ProviderError> {
        if self.exit_on_terminate {
            self.child_active.store(false, Ordering::SeqCst);
            self.emit(AgentEvent::Exited { exit_code: Some(0) });
        }
        Ok(())
    }

    fn respond_to_approval(
        &self,
        _request_id: &str,
        _decision: ApprovalDecision,
    ) -> Result<(), ProviderError> {
        Err(ProviderError::Unsupported)
    }
}

impl Drop for FakeSession {
    fn drop(&mut self) {
        self.child_active.store(false, Ordering::SeqCst);
    }
}

struct WrapperFixture {
    provider: Arc<dyn AgentProvider>,
    active: Arc<AtomicUsize>,
    reservations: Arc<AtomicUsize>,
    starts: Arc<AtomicUsize>,
    child_active: Arc<AtomicBool>,
    released_while_active: Arc<AtomicBool>,
    hold: Arc<AtomicBool>,
}

fn wrapper_fixture(start: FakeStart) -> WrapperFixture {
    let active = Arc::new(AtomicUsize::new(0));
    let reservations = Arc::new(AtomicUsize::new(0));
    let starts = Arc::new(AtomicUsize::new(0));
    let child_active = Arc::new(AtomicBool::new(false));
    let released_while_active = Arc::new(AtomicBool::new(false));
    let hold = Arc::new(AtomicBool::new(false));
    let admission: Arc<dyn ProviderAdmission> = Arc::new(FakeAdmission {
        active: Arc::clone(&active),
        reservations: Arc::clone(&reservations),
        child_active: Arc::clone(&child_active),
        released_while_active: Arc::clone(&released_while_active),
        hold: Arc::clone(&hold),
    });
    let inner: Arc<dyn AgentProvider> = Arc::new(FakeProvider {
        id: ProviderId::CODEX,
        start,
        starts: Arc::clone(&starts),
        child_active: Arc::clone(&child_active),
    });
    WrapperFixture {
        provider: ResourceAdmissionProvider::with_admission(inner, admission),
        active,
        reservations,
        starts,
        child_active,
        released_while_active,
        hold,
    }
}

fn session_config() -> SessionConfig {
    SessionConfig {
        thread_id: kalcode_contracts::ids::new_id(),
        workspace_id: kalcode_contracts::ids::new_id(),
        provider_account_id: Some(kalcode_contracts::ids::new_id()),
        working_directory: std::env::temp_dir().to_string_lossy().into_owned(),
        model: None,
        effort: None,
        permission_mode: PermissionMode::Approve,
        resume_session_id: None,
        secret_ref: None,
    }
}

fn text(text: &str) -> AgentInput {
    AgentInput::Text { text: text.into() }
}

#[test]
fn failed_provider_start_releases_its_reservation() {
    let fixture = wrapper_fixture(FakeStart::Fail);
    let result = fixture
        .provider
        .start_session(session_config(), Box::new(|_: AgentEvent| {}));

    assert!(matches!(result, Err(ProviderError::Start(_))));
    assert_eq!(fixture.reservations.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.starts.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);
    assert!(!fixture.released_while_active.load(Ordering::SeqCst));
}

#[test]
fn exit_before_start_returns_releases_exactly_once() {
    let fixture = wrapper_fixture(FakeStart::ExitBeforeReturn);
    let session = fixture
        .provider
        .start_session(session_config(), Box::new(|_: AgentEvent| {}))
        .expect("session object may arrive after its process exited");

    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);
    drop(session);
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);
    assert!(!fixture.released_while_active.load(Ordering::SeqCst));
}

/// A launch the governor holds is `ResourcesHeld` (never `Start`) and spawns nothing.
#[test]
fn a_held_launch_is_resources_held_and_starts_nothing() {
    let fixture = wrapper_fixture(FakeStart::Live {
        exit_on_terminate: true,
    });
    fixture.hold.store(true, Ordering::SeqCst);
    let Err(ProviderError::ResourcesHeld(hold)) = fixture
        .provider
        .start_session(session_config(), Box::new(|_: AgentEvent| {}))
    else {
        panic!("a held launch must be ResourcesHeld");
    };
    assert_eq!(hold.kind, LaunchHoldKind::MemoryCritical);
    assert_eq!((hold.free_mb, hold.floor_mb), (Some(300), Some(634)));
    assert_eq!(hold.wait_limit, kalcode_resources::ADMISSION_WAIT_LIMIT);
    assert_eq!(fixture.starts.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);
}

/// The OS refusing to create the provider process is a hard-pressure hold with the real reason
/// (the thread waits and can Start Anyway), not a provider failure; any other spawn failure
/// stays a provider start failure.
#[test]
fn an_os_process_creation_refusal_is_a_process_limit_hold() {
    let fixture = wrapper_fixture(FakeStart::Exhausted);
    let Err(ProviderError::ResourcesHeld(hold)) = fixture
        .provider
        .start_session(session_config(), Box::new(|_: AgentEvent| {}))
    else {
        panic!("an exhausted spawn must be a resource hold");
    };
    assert_eq!(hold.kind, LaunchHoldKind::ProcessLimit);
    assert!(hold.kind.is_hard_pressure());
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0, "no slot kept");

    let other = wrapper_fixture(FakeStart::Fail);
    assert!(matches!(
        other
            .provider
            .start_session(session_config(), Box::new(|_: AgentEvent| {})),
        Err(ProviderError::Start(_))
    ));
}

/// Capacity is held per turn: an idle session holds nothing; a turn holds one slot from `send`
/// until the provider reports its end; the next turn is admitted again.
#[test]
fn turns_hold_capacity_and_idle_sessions_hold_none() {
    let fixture = wrapper_fixture(FakeStart::Live {
        exit_on_terminate: true,
    });
    let session = fixture
        .provider
        .start_session(session_config(), Box::new(|_: AgentEvent| {}))
        .expect("live session");
    assert_eq!(
        fixture.reservations.load(Ordering::SeqCst),
        1,
        "start admitted"
    );
    assert_eq!(
        fixture.active.load(Ordering::SeqCst),
        0,
        "idle holds nothing"
    );

    session.send(text("work")).expect("turn");
    assert_eq!(fixture.active.load(Ordering::SeqCst), 1);
    session.interrupt().expect("interrupt");
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);

    session.send(text("quick")).expect("turn");
    assert_eq!(
        fixture.active.load(Ordering::SeqCst),
        0,
        "completed turn returned"
    );
    assert_eq!(fixture.reservations.load(Ordering::SeqCst), 3);

    // A held turn is refused before anything runs.
    fixture.hold.store(true, Ordering::SeqCst);
    assert!(matches!(
        session.send(text("work")),
        Err(ProviderError::ResourcesHeld(_))
    ));
    assert!(!fixture.child_active.load(Ordering::SeqCst));
    assert!(!fixture.released_while_active.load(Ordering::SeqCst));
}

/// A send the provider refuses returns only the capacity that send took.
#[test]
fn a_failed_send_returns_only_its_own_reservation() {
    let fixture = wrapper_fixture(FakeStart::Live {
        exit_on_terminate: true,
    });
    let session = fixture
        .provider
        .start_session(session_config(), Box::new(|_: AgentEvent| {}))
        .expect("live session");
    assert!(matches!(
        session.send(text("fail")),
        Err(ProviderError::Start(_))
    ));
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);

    session.send(text("work")).expect("turn");
    // A second message while the turn runs reuses the turn's slot, and its failure does not
    // release the running turn's capacity.
    assert!(session.send(text("fail")).is_err());
    assert_eq!(fixture.active.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.reservations.load(Ordering::SeqCst), 3);
}

#[test]
fn terminate_request_does_not_release_a_running_turn_until_exit_or_inner_drop() {
    let fixture = wrapper_fixture(FakeStart::Live {
        exit_on_terminate: false,
    });
    let session = fixture
        .provider
        .start_session(session_config(), Box::new(|_: AgentEvent| {}))
        .expect("live session");
    session.send(text("work")).expect("turn");

    assert_eq!(fixture.active.load(Ordering::SeqCst), 1);
    session.terminate().expect("terminate request");
    assert_eq!(
        fixture.active.load(Ordering::SeqCst),
        1,
        "a request is not proof that the child process exited"
    );
    assert!(fixture.child_active.load(Ordering::SeqCst));

    drop(session);
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);
    assert!(!fixture.released_while_active.load(Ordering::SeqCst));
}

#[test]
fn canonical_exit_event_releases_before_session_object_is_dropped() {
    let fixture = wrapper_fixture(FakeStart::Live {
        exit_on_terminate: true,
    });
    let session = fixture
        .provider
        .start_session(session_config(), Box::new(|_: AgentEvent| {}))
        .expect("live session");
    session.send(text("work")).expect("turn");

    session.terminate().expect("terminate and exit");
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);
    drop(session);
    assert_eq!(fixture.active.load(Ordering::SeqCst), 0);
    assert!(!fixture.released_while_active.load(Ordering::SeqCst));
}

#[test]
fn read_only_provider_metadata_does_not_consume_admission() {
    let fixture = wrapper_fixture(FakeStart::Fail);
    assert_eq!(fixture.provider.detect().state, DetectionState::Installed);
    assert!(fixture.provider.capabilities().streaming);
    assert_eq!(fixture.reservations.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.starts.load(Ordering::SeqCst), 0);
}

// ------------------------------------------------------------------------------------------
// The real governor: slots, KalVoice's resident worker, and memory accounting.

/// A healthy machine the sampler reads the same way every time.
struct SteadyProbe {
    cpu_percent: f32,
    cores: u32,
    total_bytes: u64,
    available_bytes: u64,
}

impl kalcode_resources::SystemProbe for SteadyProbe {
    fn sample(
        &mut self,
        _plan: &kalcode_resources::probe::ProbePlan<'_>,
    ) -> kalcode_resources::probe::RawSample {
        use kalcode_resources::probe::{Counters, RawCpu, RawMemory, RawSample};
        RawSample {
            cpu: Reading::Value(RawCpu {
                total_percent: self.cpu_percent,
                logical_cores: self.cores,
            }),
            memory: Reading::Value(RawMemory {
                total_bytes: self.total_bytes,
                available_bytes: self.available_bytes,
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
}

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

/// The owner's 24-thread, 31 GiB PC on a quiet moment.
pub(crate) fn healthy_governor() -> Arc<ResourceGovernorState> {
    let state = Arc::new(ResourceGovernorState::start_with_probe(Box::new(
        SteadyProbe {
            cpu_percent: 12.0,
            cores: 24,
            total_bytes: 31 * GIB,
            available_bytes: 20 * GIB,
        },
    )));
    let deadline = Instant::now() + Duration::from_secs(10);
    // Background admission is fail-closed: it allows only on a fresh, valid sample.
    while state.report().background_admission.state != AdmissionState::Allowed {
        assert!(Instant::now() < deadline, "healthy governor never admitted");
        std::thread::sleep(Duration::from_millis(10));
    }
    state
}

/// The owner's PC with a build pinning every core (98 % CPU) and plenty of memory.
fn cpu_saturated_governor() -> Arc<ResourceGovernorState> {
    let state = Arc::new(ResourceGovernorState::start_with_probe(Box::new(
        SteadyProbe {
            cpu_percent: 98.0,
            cores: 24,
            total_bytes: 31 * GIB,
            available_bytes: 20 * GIB,
        },
    )));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let report = state.report();
        let cpu_high =
            report.snapshot.pressure.entries.iter().any(|entry| {
                entry.resource == ResourceKind::Cpu && entry.level >= PressureLevel::High
            });
        if report.snapshot.seq > 0 && cpu_high {
            break;
        }
        assert!(Instant::now() < deadline, "CPU pressure never sampled");
        std::thread::sleep(Duration::from_millis(10));
    }
    state
}

/// Memory critically low: 300 MiB available of 31 GiB (the hard floor there is 634 MiB).
fn memory_critical_governor() -> Arc<ResourceGovernorState> {
    let state = Arc::new(ResourceGovernorState::start_with_probe(Box::new(
        SteadyProbe {
            cpu_percent: 10.0,
            cores: 24,
            total_bytes: 31 * GIB,
            available_bytes: 300 * MIB,
        },
    )));
    let deadline = Instant::now() + Duration::from_secs(10);
    while state.report().admission.state != AdmissionState::Held {
        assert!(Instant::now() < deadline, "critical memory never sampled");
        std::thread::sleep(Duration::from_millis(10));
    }
    state
}

fn governed_codex(governor: &Arc<ResourceGovernorState>) -> WrapperFixture {
    governed(governor, ProviderId::CODEX)
}

/// One provider adapter of any kind behind the real governor's admission wrapper.
fn governed(governor: &Arc<ResourceGovernorState>, provider: &'static str) -> WrapperFixture {
    let mut fixture = wrapper_fixture(FakeStart::Live {
        exit_on_terminate: true,
    });
    let inner: Arc<dyn AgentProvider> = Arc::new(FakeProvider {
        id: provider,
        start: FakeStart::Live {
            exit_on_terminate: true,
        },
        starts: Arc::clone(&fixture.starts),
        child_active: Arc::clone(&fixture.child_active),
    });
    fixture.provider = ResourceAdmissionProvider::wrap(inner, Arc::clone(governor));
    fixture
}

/// (A)(G) Five idle threads hold nothing, so a new thread starts; and the KalVoice reasoner,
/// resident and idle, holds no agent slot.
#[test]
fn idle_sessions_and_an_idle_resident_reasoner_leave_room_for_a_new_thread() {
    let governor = healthy_governor();
    // KalVoice's local reasoner as it reserves today: 8 threads and GGUF + 1 GiB, then resident.
    let reasoner = governor
        .reserve_local_task(
            LocalWorkloadEstimate::inference(Some(8_000), Some(1_819)).expect("estimate"),
        )
        .expect("the reasoner is admitted on a healthy machine");
    reasoner.settle_resident();
    assert_eq!(governor.running_work_for_test().agents, 0);

    let codex = governed_codex(&governor);
    let mut idle = Vec::new();
    for _ in 0..5 {
        let session = codex
            .provider
            .start_session(session_config(), Box::new(|_: AgentEvent| {}))
            .expect("admitted");
        session.send(text("quick")).expect("turn admitted");
        idle.push(session);
    }
    assert_eq!(
        governor.running_work_for_test().agents,
        0,
        "no phantom slots"
    );

    let sixth = codex
        .provider
        .start_session(session_config(), Box::new(|_: AgentEvent| {}))
        .expect("a sixth thread starts");
    sixth.send(text("work")).expect("its turn is admitted");
    assert_eq!(governor.running_work_for_test().agents, 1);
    drop(sixth);
    drop(idle);
    drop(reasoner);
    assert_eq!(governor.running_work_for_test().agents, 0);
    governor.shutdown();
}

/// An explicit Custom ceiling of four running turns holds the fifth with the concurrency reason
/// and the counts, and proceeds as soon as one turn finishes.
#[test]
fn an_explicit_custom_agent_ceiling_waits_for_a_slot_and_resumes() {
    let governor = healthy_governor();
    let codex = governed_codex(&governor);
    let limit = 4;
    governor
        .set_mode(ResourceMode::Custom(
            kalcode_resources::CustomLimits::default(),
        ))
        .expect("explicit custom ceiling");
    let deadline = Instant::now() + Duration::from_secs(10);
    while governor.report().snapshot.mode != ModeKind::Custom {
        assert!(Instant::now() < deadline, "custom mode sample");
        std::thread::sleep(Duration::from_millis(10));
    }
    let running: Vec<_> = (0..limit)
        .map(|_| {
            let session = codex
                .provider
                .start_session(session_config(), Box::new(|_: AgentEvent| {}))
                .expect("admitted");
            session.send(text("work")).expect("turn admitted");
            session
        })
        .collect();
    assert_eq!(governor.running_work_for_test().agents, limit);

    let Err(ProviderError::ResourcesHeld(hold)) = codex
        .provider
        .start_session(session_config(), Box::new(|_: AgentEvent| {}))
    else {
        panic!("the fifth launch must wait for a slot");
    };
    assert_eq!(hold.kind, LaunchHoldKind::ConcurrencyLimit);
    assert_eq!((hold.running, hold.limit), (Some(limit), Some(limit)));
    assert!(hold.retry_after >= kalcode_resources::ADMISSION_RETRY_MIN);
    assert!(hold.retry_after <= kalcode_resources::ADMISSION_RETRY_MAX);

    running[0].interrupt().expect("one turn ends");
    let fifth = codex
        .provider
        .start_session(session_config(), Box::new(|_: AgentEvent| {}))
        .expect("a freed slot admits the waiting launch");
    fifth.send(text("work")).expect("turn admitted");
    assert_eq!(governor.running_work_for_test().agents, limit);
    drop(fifth);
    drop(running);
    governor.shutdown();
}

/// (E) No sampler: missing telemetry is not evidence of pressure, so a coding agent the person
/// starts is admitted (and still counted), while background work stays held.
#[test]
fn a_missing_sampler_never_holds_a_user_requested_agent() {
    let state = deterministic_state();
    let reservation = state
        .reserve_provider_task(ProviderId::new(ProviderId::CODEX), &AgentLaunch::default())
        .expect("no sampler never holds a user-requested agent");
    assert_eq!(state.running_work_for_test().agents, 1);
    drop(reservation);
    assert_eq!(state.running_work_for_test().agents, 0);
    assert!(
        state
            .reserve_local_task(
                LocalWorkloadEstimate::inference(Some(1_000), Some(512)).expect("estimate")
            )
            .is_err(),
        "background work is fail-closed without telemetry"
    );
}

/// (B)(C)(D) Only genuine hard pressure and explicit Custom limits become user-facing launch
/// holds, each classified with its real reason and logged by code. CPU, soft memory, KalCode's
/// memory share and telemetry reasons never hold a user-requested agent.
#[test]
fn hold_reasons_are_classified_and_logged_by_code() {
    let cases = [
        (
            AdmissionReason::HardPressure {
                pressure: kalcode_resources::HardPressure::MemoryCritical {
                    available_mb: 300,
                    floor_mb: 634,
                },
            },
            LaunchHoldKind::MemoryCritical,
            "memory_critical",
        ),
        (
            AdmissionReason::HardPressure {
                pressure: kalcode_resources::HardPressure::CommitExhausted {
                    remaining_mb: 100,
                    floor_mb: 634,
                },
            },
            LaunchHoldKind::MemoryCritical,
            "commit_exhausted",
        ),
        (
            AdmissionReason::HardPressure {
                pressure: kalcode_resources::HardPressure::DiskFull {
                    mount: "C:\\".into(),
                    free_mb: 200,
                    floor_mb: 1_024,
                },
            },
            LaunchHoldKind::DiskFull,
            "disk_full",
        ),
        (
            AdmissionReason::Capacity {
                holds: vec![kalcode_resources::HoldReason::UserLimit {
                    running: 4,
                    limit: 4,
                    mode: ModeKind::Custom,
                }],
            },
            LaunchHoldKind::ConcurrencyLimit,
            "concurrency_limit",
        ),
    ];
    for (reason, kind, code) in cases {
        let decision = held(reason);
        let hold = kalcode_resources::launch_hold(
            &decision,
            Duration::from_secs(1),
            kalcode_resources::ADMISSION_WAIT_LIMIT,
        )
        .expect("a user-facing hold");
        assert_eq!(hold.kind, kind, "{code}");
        assert_eq!(kalcode_resources::decision_codes(&decision), [code]);
        // The structured log line carries the governor's values (smoke: it serializes).
        super::provider::log_launch_hold(&ProviderId::new(ProviderId::CODEX), &decision);
    }

    let background_only = [
        AdmissionReason::Capacity {
            holds: vec![kalcode_resources::HoldReason::CpuHeadroom {
                cpu_percent: 99.0,
                target_percent: 75.0,
                per_agent_percent: 2.0,
                mode: ModeKind::Balanced,
            }],
        },
        AdmissionReason::Capacity {
            holds: vec![kalcode_resources::HoldReason::Pressure {
                resource: ResourceKind::Cpu,
                level: PressureLevel::Critical,
                mode: ModeKind::Balanced,
                signal: Signal::CpuPercent,
                value: 99.0,
                threshold: Some(95.0),
            }],
        },
        AdmissionReason::Capacity {
            holds: vec![kalcode_resources::HoldReason::MemoryHeadroom {
                available_mb: 1_900,
                reserve_mb: 2_048,
                per_agent_mb: 512,
                mode: ModeKind::Balanced,
            }],
        },
        AdmissionReason::Capacity {
            holds: vec![kalcode_resources::HoldReason::KalCodeMemoryCap {
                used_mb: 16_000,
                cap_mb: 15_872,
                per_agent_mb: 512,
                mode: ModeKind::Balanced,
            }],
        },
        AdmissionReason::SnapshotStale {
            age_ms: 50_000,
            max_age_ms: 45_000,
        },
        AdmissionReason::CapacityUnavailable,
    ];
    for reason in background_only {
        assert_eq!(
            kalcode_resources::launch_hold(
                &held(reason.clone()),
                Duration::from_secs(1),
                kalcode_resources::ADMISSION_WAIT_LIMIT,
            ),
            None,
            "{reason:?} must never hold a user-requested agent"
        );
    }

    // The real hard reason wins over a count limit when both hold.
    let mixed = AdmissionDecision {
        reasons: vec![
            AdmissionReason::Capacity {
                holds: vec![kalcode_resources::HoldReason::UserLimit {
                    running: 4,
                    limit: 4,
                    mode: ModeKind::Custom,
                }],
            },
            AdmissionReason::HardPressure {
                pressure: kalcode_resources::HardPressure::MemoryCritical {
                    available_mb: 300,
                    floor_mb: 634,
                },
            },
        ],
        ..held(AdmissionReason::CapacityUnavailable)
    };
    let hold = kalcode_resources::launch_hold(
        &mixed,
        Duration::from_secs(1),
        kalcode_resources::ADMISSION_WAIT_LIMIT,
    )
    .expect("held");
    assert_eq!(hold.kind, LaunchHoldKind::MemoryCritical);
    assert_eq!((hold.free_mb, hold.floor_mb), (Some(300), Some(634)));
}

/// A budget is projected only until a sample can reflect it; the slot stays until release.
#[test]
fn reservations_are_not_counted_twice_once_measured() {
    let mut tracker = ActivityTracker::default();
    let budget = ReservationBudget {
        cpu_millicores: 500,
        memory_mib: 1_819,
        disk_mib: 0,
    };
    let id = tracker
        .reserve(super::ReservationKind::Local, budget, NOW_MS)
        .expect("reserve");
    assert_eq!(tracker.unmeasured_budget(Some(NOW_MS + 1_000)), budget);
    assert_eq!(tracker.unmeasured_budget(None), budget);
    assert_eq!(
        tracker.unmeasured_budget(Some(NOW_MS + 10_000)),
        budget,
        "one process-tier cadence (10 s) is not enough margin: the budget stays projected"
    );
    assert_eq!(tracker.unmeasured_budget(Some(NOW_MS + 14_999)), budget);
    assert_eq!(
        tracker.unmeasured_budget(Some(NOW_MS + 15_000)),
        ReservationBudget::default(),
        "a sample 15 s later measures the process: its memory is not subtracted again"
    );
    assert_eq!(
        tracker.running().agents,
        1,
        "the slot is held until release"
    );

    // A resident worker gives up its slot; a request re-arms only its CPU.
    tracker.settle_resident(id);
    assert_eq!(tracker.running().agents, 0);
    tracker.arm_cpu(id, 8_000, NOW_MS + 60_000);
    assert_eq!(
        tracker.unmeasured_budget(Some(NOW_MS + 61_000)),
        ReservationBudget {
            cpu_millicores: 8_000,
            memory_mib: 0,
            disk_mib: 0,
        }
    );
    tracker.release(id);
    assert_eq!(tracker.pending_budget(), ReservationBudget::default());
}

/// The owner's M1 (8 cores, 16 GiB): sysinfo reads ~3,694 MiB available while macOS reports
/// 74% free, and the local reasoner is resident. On an otherwise idle Mac a Codex launch is
/// admitted; before this fix the raw figure minus the reasoner's re-subtracted 1,819 MiB fell
/// under the 2,560 MiB floor and every launch was held.
#[test]
fn an_m1_with_a_resident_reasoner_admits_codex() {
    let available = kalcode_resources::probe::reconcile_available_memory(
        16 * GIB,
        3_694 * MIB,
        Some(74),
        Some(kalcode_resources::probe::MACOS_PRESSURE_NORMAL),
    );
    let mut mac = measured_snapshot();
    mac.cpu = Reading::Value(CpuReading {
        total_percent: 8.0,
        smoothed_percent: 8.0,
        logical_cores: 8,
    });
    mac.memory = Reading::Value(MemoryReading {
        total_bytes: 16 * GIB,
        available_bytes: available,
        used_bytes: 16 * GIB - available,
        used_percent: 26.0,
        smoothed_used_percent: 26.0,
        smoothed_available_bytes: available,
        commit: Reading::unavailable("not exposed by this platform"),
    });

    let mut tracker = ActivityTracker::default();
    // The reasoner was admitted and loaded a minute before this launch.
    let reasoner = tracker
        .reserve(
            super::ReservationKind::Local,
            ReservationBudget {
                cpu_millicores: 4_000,
                memory_mib: 1_819,
                disk_mib: 0,
            },
            NOW_MS - 60_000,
        )
        .expect("reasoner");
    tracker.settle_resident(reasoner);

    let codex = ReservationBudget {
        cpu_millicores: 500,
        memory_mib: 512,
        disk_mib: 0,
    };
    let decide = |snapshot: &ResourceSnapshot, pending: ReservationBudget| {
        projected_admission(
            &GovernorStatus::Running,
            Some(snapshot),
            &ModeLimits::balanced(),
            &tracker.running(),
            &kalcode_resources::CapacityRequest {
                provider: Some(ProviderId::new(ProviderId::CODEX)),
            },
            AdmissionRequirements::provider_task(),
            pending,
            codex,
            NOW_MS,
        )
    };
    let admitted = decide(&mac, tracker.unmeasured_budget(Some(NOW_MS)));
    assert_eq!(admitted.state, AdmissionState::Allowed, "{admitted:?}");

    // The old accounting: raw sysinfo memory and the reasoner's memory subtracted again.
    let mut raw = mac.clone();
    if let Reading::Value(memory) = &mut raw.memory {
        memory.available_bytes = 3_694 * MIB;
        memory.smoothed_available_bytes = 3_694 * MIB;
    }
    let old = decide(
        &raw,
        ReservationBudget {
            cpu_millicores: 4_000,
            memory_mib: 1_819,
            disk_mib: 0,
        },
    );
    assert_eq!(
        old.state,
        AdmissionState::Held,
        "the regression this guards"
    );
}

#[test]
fn balanced_mode_runs_twelve_provider_turns_when_hardware_has_headroom() {
    let governor = healthy_governor();
    let provider = governed_codex(&governor);
    let sessions: Vec<_> = (0..12)
        .map(|_| {
            let session = provider
                .provider
                .start_session(session_config(), Box::new(|_: AgentEvent| {}))
                .expect("no preset count cap");
            session.send(text("work")).expect("hardware admits turn");
            session
        })
        .collect();
    assert_eq!(governor.running_work_for_test().agents, 12);
    drop(sessions);
    assert_eq!(governor.running_work_for_test().agents, 0);
    governor.shutdown();
}

/// Owner directive (2026-10-04): with every core pinned (98 % CPU, CPU pressure High or worse),
/// 1, 4 and 10 coding-agent panes the person creates all start immediately — for Claude Code,
/// Codex, Cursor, Gemini CLI and a future provider alike — and no fake concurrency cap appears.
#[test]
fn cpu_busy_never_holds_user_requested_agents_one_four_or_ten_any_provider() {
    let governor = cpu_saturated_governor();
    for provider in [
        ProviderId::CLAUDE_CODE,
        ProviderId::CODEX,
        ProviderId::CURSOR,
        ProviderId::GEMINI_CLI,
        "future-provider",
    ] {
        let adapter = governed(&governor, provider);
        for count in [1, 4, 10] {
            let started = Instant::now();
            let sessions: Vec<_> = (0..count)
                .map(|_| {
                    let session = adapter
                        .provider
                        .start_session(session_config(), Box::new(|_: AgentEvent| {}))
                        .unwrap_or_else(|error| {
                            panic!("{provider} launch held under CPU load: {error}")
                        });
                    session
                        .send(text("work"))
                        .unwrap_or_else(|error| panic!("{provider} turn held: {error}"));
                    session
                })
                .collect();
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "{count} {provider} agents must start immediately, not after a wait"
            );
            assert_eq!(governor.running_work_for_test().agents, count);
            drop(sessions);
            assert_eq!(governor.running_work_for_test().agents, 0);
        }
    }
    // The resource view says new agents start (it never reports "CPU busy").
    assert_eq!(governor.report().admission.state, AdmissionState::Allowed);
    governor.shutdown();
}

/// The same CPU load still throttles optional background work: a local model inference waits
/// while ten agents run, and it yields to their unmeasured budgets.
#[test]
fn cpu_busy_still_throttles_background_work() {
    let governor = cpu_saturated_governor();
    let adapter = governed(&governor, ProviderId::CLAUDE_CODE);
    let agents: Vec<_> = (0..10)
        .map(|_| {
            let session = adapter
                .provider
                .start_session(session_config(), Box::new(|_: AgentEvent| {}))
                .expect("agent starts");
            session.send(text("work")).expect("turn admitted");
            session
        })
        .collect();
    let Err(decision) = governor.reserve_local_task(
        LocalWorkloadEstimate::inference(Some(4_000), Some(1_024)).expect("estimate"),
    ) else {
        panic!("background inference must yield to CPU load");
    };
    let codes = kalcode_resources::decision_codes(&decision);
    assert!(
        codes.contains(&"cpu_headroom") || codes.contains(&"pressure"),
        "{codes:?}"
    );
    assert_eq!(
        governor.report().background_admission.state,
        AdmissionState::Held
    );
    drop(agents);
    governor.shutdown();
}

/// Critically low memory holds a user-requested launch with the real reason and the numbers;
/// Start Anyway for that thread starts it (launch and first turn), and only that thread.
#[test]
fn critically_low_memory_holds_with_the_real_reason_and_start_anyway_starts_it() {
    let governor = memory_critical_governor();
    let adapter = governed(&governor, ProviderId::CLAUDE_CODE);
    let config = session_config();
    let Err(ProviderError::ResourcesHeld(hold)) = adapter
        .provider
        .start_session(config.clone(), Box::new(|_: AgentEvent| {}))
    else {
        panic!("critically low memory must hold the launch");
    };
    assert_eq!(hold.kind, LaunchHoldKind::MemoryCritical);
    assert_eq!(hold.kind.phrase(), "memory is critically low");
    assert_eq!(hold.free_mb, Some(300));
    assert_eq!(
        hold.floor_mb,
        Some(kalcode_resources::memory_floor_mib(31 * GIB))
    );
    assert_eq!(adapter.starts.load(Ordering::SeqCst), 0, "nothing spawned");

    governor.grant_start_anyway(&config.thread_id);
    let session = adapter
        .provider
        .start_session(config, Box::new(|_: AgentEvent| {}))
        .expect("Start Anyway starts it");
    session
        .send(text("work"))
        .expect("its first turn is admitted too");
    assert_eq!(adapter.starts.load(Ordering::SeqCst), 1);

    // Another thread is still held: the override is per thread, not a standing exemption.
    assert!(matches!(
        adapter
            .provider
            .start_session(session_config(), Box::new(|_: AgentEvent| {})),
        Err(ProviderError::ResourcesHeld(_))
    ));
    drop(session);
    governor.shutdown();
}
