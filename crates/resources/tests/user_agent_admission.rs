//! Owner directive (2026-10-04): the Resource Governor protects system responsiveness without
//! becoming an artificial agent limit. User-requested coding agents start immediately whenever the
//! OS can reasonably run them; high CPU throttles optional background work instead; only genuine
//! hard pressure delays a user-requested agent, with the real reason and Start Anyway.

use std::collections::BTreeMap;
use std::time::Duration;

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::resources::LaunchHoldKind;
use kalcode_resources::model::{CpuReading, MemoryReading, VolumeReading};
use kalcode_resources::{
    AdmissionReason, AdmissionRequirements, AdmissionState, CapacityRequest, CustomLimits,
    GovernorStatus, HardPressure, ModeKind, ModeLimits, PressureEntry, PressureLevel,
    PressureSummary, Reading, ResourceKind, ResourceSnapshot, RunningWork, Signal,
    admission_max_age, capacity, decision_codes, evaluate_admission, evaluate_user_agent_admission,
    launch_hold, memory_floor_mib,
};

const NOW_MS: i64 = 1_800_000_000_000;
const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
const PROVIDERS: [&str; 5] = [
    ProviderId::CLAUDE_CODE,
    ProviderId::CODEX,
    ProviderId::CURSOR,
    ProviderId::GEMINI_CLI,
    "future-provider",
];

/// The owner's 24-thread, 31 GiB PC with the CPU pinned by a build: 99 % busy, CPU pressure
/// Critical, no CPU headroom at all. Memory and disk are fine.
fn cpu_saturated() -> ResourceSnapshot {
    let mut snapshot = ResourceSnapshot::unknown("not sampled", ModeKind::Balanced);
    snapshot.seq = 9;
    snapshot.sampled_at_unix_ms = NOW_MS - 500;
    snapshot.sampling.next_interval_ms = 1_000;
    snapshot.cpu = Reading::Value(CpuReading {
        total_percent: 99.0,
        smoothed_percent: 99.0,
        logical_cores: 24,
    });
    snapshot.memory = memory(31 * GIB, 12 * GIB);
    snapshot.volumes = Reading::Value(vec![VolumeReading {
        mount: "C:\\".into(),
        workspace_ids: vec![None, Some("ws".into())],
        total_bytes: 1_000 * GIB,
        free_bytes: 200 * GIB,
    }]);
    snapshot.pressure = PressureSummary {
        entries: vec![PressureEntry {
            resource: ResourceKind::Cpu,
            level: PressureLevel::Critical,
            signal: Signal::CpuPercent,
            value: 99.0,
            threshold: Some(95.0),
            approaching: false,
        }],
        unknown: Vec::new(),
    };
    snapshot
}

fn memory(total: u64, available: u64) -> Reading<MemoryReading> {
    Reading::Value(MemoryReading {
        total_bytes: total,
        available_bytes: available,
        used_bytes: total - available,
        used_percent: ((total - available) * 100 / total) as f32,
        smoothed_used_percent: ((total - available) * 100 / total) as f32,
        smoothed_available_bytes: available,
        commit: Reading::unavailable("not exposed on this platform"),
    })
}

fn running(agents: u32, provider: &str) -> RunningWork {
    RunningWork {
        agents,
        per_provider: BTreeMap::from([(ProviderId::new(provider), agents)]),
    }
}

fn user_agent(
    snapshot: Option<&ResourceSnapshot>,
    limits: &ModeLimits,
    running: &RunningWork,
    provider: &str,
    override_holds: bool,
) -> kalcode_resources::AdmissionDecision {
    evaluate_user_agent_admission(
        snapshot,
        limits,
        running,
        &CapacityRequest {
            provider: Some(ProviderId::new(provider)),
        },
        Some("ws"),
        NOW_MS,
        snapshot
            .map(admission_max_age)
            .unwrap_or(kalcode_resources::MAX_ADMISSION_SAMPLE_AGE),
        override_holds,
    )
}

fn background(
    snapshot: &ResourceSnapshot,
    limits: &ModeLimits,
) -> kalcode_resources::AdmissionDecision {
    evaluate_admission(
        &GovernorStatus::Running,
        Some(snapshot),
        Some(capacity(
            snapshot,
            limits,
            &RunningWork::default(),
            &CapacityRequest::default(),
        )),
        AdmissionRequirements::background_heavy(),
        NOW_MS,
        admission_max_age(snapshot),
    )
}

/// 1, 4 and 10 agents (and more) launched while the CPU is saturated all start immediately, for
/// every provider and in every preset mode.
#[test]
fn cpu_saturation_never_holds_user_requested_agents_for_any_provider_or_mode() {
    let snapshot = cpu_saturated();
    for limits in [
        ModeLimits::conservative(),
        ModeLimits::balanced(),
        ModeLimits::performance(),
    ] {
        let mut snapshot = snapshot.clone();
        snapshot.mode = limits.kind;
        for provider in PROVIDERS {
            for already_running in [0, 1, 3, 4, 9, 10, 32] {
                let decision = user_agent(
                    Some(&snapshot),
                    &limits,
                    &running(already_running, provider),
                    provider,
                    false,
                );
                assert_eq!(
                    decision.state,
                    AdmissionState::Allowed,
                    "{:?} {provider} with {already_running} running: {decision:?}",
                    limits.kind
                );
                assert!(decision.additional > 0);
                assert!(decision.reasons.is_empty(), "{decision:?}");
            }
        }
    }
}

/// The same saturated CPU throttles optional background work (it yields first).
#[test]
fn cpu_saturation_still_throttles_background_work() {
    let snapshot = cpu_saturated();
    let decision = background(&snapshot, &ModeLimits::balanced());
    assert_eq!(decision.state, AdmissionState::Held);
    let codes = decision_codes(&decision);
    assert!(
        codes.contains(&"pressure") || codes.contains(&"cpu_headroom"),
        "{codes:?}"
    );
    // A background hold never becomes a user-facing launch hold.
    assert_eq!(
        launch_hold(&decision, Duration::from_secs(1), Duration::from_secs(90)),
        None
    );
}

/// Soft memory pressure (below the mode's 2 GiB reserve, far above the hard floor) throttles
/// background work but never a user-requested agent.
#[test]
fn soft_memory_pressure_throttles_background_only() {
    let mut snapshot = cpu_saturated();
    snapshot.memory = memory(31 * GIB, 1_500 * MIB);
    let agent = user_agent(
        Some(&snapshot),
        &ModeLimits::balanced(),
        &RunningWork::default(),
        ProviderId::CLAUDE_CODE,
        false,
    );
    assert_eq!(agent.state, AdmissionState::Allowed, "{agent:?}");
    assert_eq!(
        background(&snapshot, &ModeLimits::balanced()).state,
        AdmissionState::Held
    );
}

/// Critically low memory holds a user-requested launch with the real reason and the numbers;
/// Start Anyway admits it.
#[test]
fn critically_low_memory_holds_with_the_real_reason_and_start_anyway_admits() {
    let mut snapshot = cpu_saturated();
    snapshot.memory = memory(31 * GIB, 300 * MIB);
    let floor = memory_floor_mib(31 * GIB);
    for provider in PROVIDERS {
        let held = user_agent(
            Some(&snapshot),
            &ModeLimits::performance(),
            &RunningWork::default(),
            provider,
            false,
        );
        assert_eq!(held.state, AdmissionState::Held, "{provider}");
        assert_eq!(
            held.reasons,
            [AdmissionReason::HardPressure {
                pressure: HardPressure::MemoryCritical {
                    available_mb: 300,
                    floor_mb: floor,
                }
            }]
        );
        assert_eq!(decision_codes(&held), ["memory_critical"]);
        let hold = launch_hold(&held, Duration::from_secs(1), Duration::from_secs(90))
            .expect("a hard hold is user-facing");
        assert_eq!(hold.kind, LaunchHoldKind::MemoryCritical);
        assert_eq!((hold.free_mb, hold.floor_mb), (Some(300), Some(floor)));
        assert_eq!(hold.kind.phrase(), "memory is critically low");

        let anyway = user_agent(
            Some(&snapshot),
            &ModeLimits::performance(),
            &RunningWork::default(),
            provider,
            true,
        );
        assert_eq!(anyway.state, AdmissionState::Allowed, "{provider}");
        assert!(anyway.additional > 0);
    }
}

/// A full workspace or data volume holds; another workspace's full volume does not.
#[test]
fn a_full_disk_on_the_launch_volume_holds_with_the_disk_reason() {
    let mut snapshot = cpu_saturated();
    snapshot.volumes = Reading::Value(vec![VolumeReading {
        mount: "C:\\".into(),
        workspace_ids: vec![None, Some("ws".into())],
        total_bytes: 500 * GIB,
        free_bytes: 200 * MIB,
    }]);
    let held = user_agent(
        Some(&snapshot),
        &ModeLimits::balanced(),
        &RunningWork::default(),
        ProviderId::CODEX,
        false,
    );
    let hold = launch_hold(&held, Duration::from_secs(1), Duration::from_secs(90))
        .expect("a full disk holds");
    assert_eq!(hold.kind, LaunchHoldKind::DiskFull);
    assert_eq!(hold.free_mb, Some(200));
}

/// Missing, stale and future samples are not evidence of pressure: the agent starts.
#[test]
fn missing_or_stale_telemetry_never_holds_a_user_requested_agent() {
    let limits = ModeLimits::balanced();
    let none = user_agent(
        None,
        &limits,
        &RunningWork::default(),
        ProviderId::CODEX,
        false,
    );
    assert_eq!(none.state, AdmissionState::Allowed);

    let mut stale = cpu_saturated();
    stale.memory = memory(31 * GIB, 100 * MIB);
    stale.sampled_at_unix_ms = NOW_MS - 600_000;
    let decision = user_agent(
        Some(&stale),
        &limits,
        &RunningWork::default(),
        ProviderId::CODEX,
        false,
    );
    assert_eq!(
        decision.state,
        AdmissionState::Allowed,
        "a stale critical reading is not current evidence"
    );

    let unknown = ResourceSnapshot::unknown("sampler starting", ModeKind::Balanced);
    assert_eq!(
        user_agent(
            Some(&unknown),
            &limits,
            &RunningWork::default(),
            ProviderId::CODEX,
            false
        )
        .state,
        AdmissionState::Allowed
    );
}

/// No preset imposes a count: 64 running agents and another still starts. Only a limit the
/// person set explicitly in Custom mode holds, with its counts, and Start Anyway admits it.
#[test]
fn there_is_no_fake_concurrency_cap_only_explicit_custom_limits() {
    let snapshot = cpu_saturated();
    for limits in [
        ModeLimits::conservative(),
        ModeLimits::balanced(),
        ModeLimits::performance(),
    ] {
        assert_eq!(
            user_agent(
                Some(&snapshot),
                &limits,
                &running(64, ProviderId::CODEX),
                ProviderId::CODEX,
                false
            )
            .state,
            AdmissionState::Allowed
        );
    }

    let custom = ModeLimits::custom(&CustomLimits {
        max_agents: 4,
        ..CustomLimits::default()
    });
    let held = user_agent(
        Some(&snapshot),
        &custom,
        &running(4, ProviderId::CODEX),
        ProviderId::CODEX,
        false,
    );
    let hold = launch_hold(&held, Duration::from_secs(1), Duration::from_secs(90))
        .expect("explicit custom limit");
    assert_eq!(hold.kind, LaunchHoldKind::ConcurrencyLimit);
    assert_eq!((hold.running, hold.limit), (Some(4), Some(4)));
    assert_eq!(
        user_agent(
            Some(&snapshot),
            &custom,
            &running(4, ProviderId::CODEX),
            ProviderId::CODEX,
            true
        )
        .state,
        AdmissionState::Allowed
    );
}
