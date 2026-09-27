use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{
    AgentEvent, AgentEventSink, AgentInput, AgentProvider, AgentSession, AuthState, DetectionState,
    ProviderCapabilities, ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::permissions::{ApprovalDecision, PermissionMode};
use kalcode_contracts::resources::{CpuReading, MemoryReading, ResourcePressure, VolumeReading};
use kalcode_resources::{
    AdmissionDecision, AdmissionReason, AdmissionRequirements, AdmissionState, GovernorStatus,
    ModeKind, ModeLimits, PressureLevel, PressureSummary, Reading, ResourceKind, ResourceMode,
    ResourceSnapshot, SamplerStats, Signal, admission_max_age,
};

use super::provider::{ProviderAdmission, ProviderAdmissionPermit, ResourceAdmissionProvider};
use super::{
    ActivityTracker, LocalWorkloadEstimate, REPORT_HISTORY_POINTS, ReservationBudget,
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
        runtime: Mutex::new(Runtime {
            handle: Some(handle),
            activity: ActivityTracker::default(),
            fallback_status: GovernorStatus::Starting,
        }),
    });

    let admitted = state.report().admission;
    assert_eq!(admitted.state, AdmissionState::Allowed);
    assert!(admitted.additional > 0);

    state.set_active_tasks(ModeLimits::balanced().max_agents);
    let held = state.report().admission;
    assert_eq!(held.state, AdmissionState::Held);
    assert_eq!(held.additional, 0);
    assert!(!held.reasons.is_empty());

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
    let provider_denial = match state.reserve_provider_task(provider) {
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

#[test]
fn missing_sampler_is_visible_and_holds_new_work() {
    let state = ResourceGovernorState {
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
    assert_eq!(report.admission.state, AdmissionState::Held);
    assert!(
        report
            .admission
            .reasons
            .iter()
            .any(|reason| matches!(reason, AdmissionReason::GovernorNotReady { .. }))
    );
    assert!(
        report
            .admission
            .reasons
            .contains(&AdmissionReason::SnapshotMissing)
    );
    assert!(
        report
            .admission
            .reasons
            .contains(&AdmissionReason::CapacityUnavailable)
    );
}

#[test]
fn shutdown_is_idempotent_when_startup_failed() {
    let state = ResourceGovernorState {
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
    ExitBeforeReturn,
    Live { exit_on_terminate: bool },
}

struct FakeAdmission {
    active: Arc<AtomicUsize>,
    reservations: Arc<AtomicUsize>,
    child_active: Arc<AtomicBool>,
    released_while_active: Arc<AtomicBool>,
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
    ) -> Result<Box<dyn ProviderAdmissionPermit>, ProviderError> {
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
    start: FakeStart,
    starts: Arc<AtomicUsize>,
    child_active: Arc<AtomicBool>,
}

impl AgentProvider for FakeProvider {
    fn id(&self) -> ProviderId {
        ProviderId::new(ProviderId::CODEX)
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
            FakeStart::Live { exit_on_terminate } => {
                self.child_active.store(true, Ordering::SeqCst);
                Ok(Box::new(FakeSession {
                    child_active: Arc::clone(&self.child_active),
                    sink: Mutex::new(Some(sink)),
                    exit_on_terminate,
                }))
            }
        }
    }
}

struct FakeSession {
    child_active: Arc<AtomicBool>,
    sink: Mutex<Option<Box<dyn AgentEventSink>>>,
    exit_on_terminate: bool,
}

impl AgentSession for FakeSession {
    fn provider_session_id(&self) -> Option<String> {
        Some("fixture-session".into())
    }

    fn send(&self, _input: AgentInput) -> Result<(), ProviderError> {
        Ok(())
    }

    fn interrupt(&self) -> Result<(), ProviderError> {
        Ok(())
    }

    fn terminate(&self) -> Result<(), ProviderError> {
        if self.exit_on_terminate {
            self.child_active.store(false, Ordering::SeqCst);
            if let Some(sink) = self
                .sink
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
            {
                sink.emit(AgentEvent::Exited { exit_code: Some(0) });
            }
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
}

fn wrapper_fixture(start: FakeStart) -> WrapperFixture {
    let active = Arc::new(AtomicUsize::new(0));
    let reservations = Arc::new(AtomicUsize::new(0));
    let starts = Arc::new(AtomicUsize::new(0));
    let child_active = Arc::new(AtomicBool::new(false));
    let released_while_active = Arc::new(AtomicBool::new(false));
    let admission: Arc<dyn ProviderAdmission> = Arc::new(FakeAdmission {
        active: Arc::clone(&active),
        reservations: Arc::clone(&reservations),
        child_active: Arc::clone(&child_active),
        released_while_active: Arc::clone(&released_while_active),
    });
    let inner: Arc<dyn AgentProvider> = Arc::new(FakeProvider {
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
    }
}

fn session_config() -> SessionConfig {
    SessionConfig {
        thread_id: kalcode_contracts::ids::new_id(),
        workspace_id: kalcode_contracts::ids::new_id(),
        provider_account_id: Some(kalcode_contracts::ids::new_id()),
        working_directory: std::env::temp_dir().to_string_lossy().into_owned(),
        model: None,
        permission_mode: PermissionMode::Approve,
        resume_session_id: None,
        secret_ref: None,
    }
}

#[test]
fn failed_provider_start_releases_its_reservation() {
    let fixture = wrapper_fixture(FakeStart::Fail);
    let result = fixture
        .provider
        .start_session(session_config(), Box::new(|_: AgentEvent| {}));

    assert!(result.is_err());
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

#[test]
fn terminate_request_does_not_release_until_exit_or_inner_drop() {
    let fixture = wrapper_fixture(FakeStart::Live {
        exit_on_terminate: false,
    });
    let session = fixture
        .provider
        .start_session(session_config(), Box::new(|_: AgentEvent| {}))
        .expect("live session");

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
