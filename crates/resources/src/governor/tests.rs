//! Governor thread tests: a scripted probe, the real clock for wake-up timing, and a racing
//! manual clock where many samples are needed quickly.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::*;
use crate::capacity::DataQuality;
use crate::clock::manual::ManualClock;
use crate::mode::{CustomLimits, ModeKind};
use crate::model::{PressureLevel, Reading, ResourceKind};
use crate::probe::{Counters, ProbePlan, RawCpu, RawMemory, RawSample};
use kalcode_contracts::agent::ProviderId;

/// Hang guard for probe handshakes, the immediate first sample and joins after release: never a
/// latency assertion (cadence and promptness tests keep their own bounds).
const HANG_GUARD: Duration = Duration::from_secs(30);

/// Root pids and workspace count of each plan the probe received.
type PlanLog = Arc<Mutex<Vec<(Vec<u32>, usize)>>>;

type Script = Box<dyn FnMut(u32, &ProbePlan<'_>) -> RawSample + Send>;

struct ScriptedProbe {
    calls: Arc<AtomicU32>,
    script: Script,
}

impl SystemProbe for ScriptedProbe {
    fn sample(&mut self, plan: &ProbePlan<'_>) -> RawSample {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        (self.script)(call, plan)
    }
}

fn probe(
    script: impl FnMut(u32, &ProbePlan<'_>) -> RawSample + Send + 'static,
) -> (Box<dyn SystemProbe>, Arc<AtomicU32>) {
    let calls = Arc::new(AtomicU32::new(0));
    (
        Box::new(ScriptedProbe {
            calls: Arc::clone(&calls),
            script: Box::new(script),
        }),
        calls,
    )
}

fn sample(cpu: f32) -> RawSample {
    RawSample {
        cpu: Reading::Value(RawCpu {
            total_percent: cpu,
            logical_cores: 8,
        }),
        memory: Reading::Value(RawMemory {
            total_bytes: 16 << 30,
            available_bytes: 8 << 30,
        }),
        disk_io: Reading::Value(Counters {
            generation: 1,
            a_bytes: 0,
            b_bytes: 0,
        }),
        commit: None,
        network: None,
        volumes: Some(Reading::Value(vec![])),
        processes: None,
        gpu: None,
    }
}

fn config() -> GovernorConfig {
    GovernorConfig {
        self_pid: 1,
        ..GovernorConfig::default()
    }
}

fn wait_until(what: &str, timeout: Duration, mut ok: impl FnMut() -> bool) {
    let start = Instant::now();
    while !ok() {
        assert!(start.elapsed() < timeout, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

struct ProbeRelease(Option<std::sync::mpsc::SyncSender<()>>);

impl ProbeRelease {
    fn release(&mut self) -> Result<(), std::sync::mpsc::TrySendError<()>> {
        self.0
            .take()
            .expect("probe release is one-shot")
            .try_send(())
    }
}

impl Drop for ProbeRelease {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.try_send(());
        }
    }
}

fn seq(handle: &GovernorHandle) -> u64 {
    handle.latest().map_or(0, |s| s.seq)
}

#[test]
fn bounded_shutdown_retains_blocked_sampler_for_retry() {
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let (probe, _) = probe(move |_, _| {
        entered_tx.send(()).expect("entered");
        release_rx.recv().expect("release probe");
        sample(10.0)
    });
    let mut handle =
        Governor::start_with(config(), probe, Arc::new(SystemClock::default())).unwrap();
    entered_rx.recv_timeout(HANG_GUARD).expect("probe started");
    let started = Instant::now();
    let stopped = handle.shutdown_checked(Duration::from_millis(20));
    // Always release the fixture before assertions so failures cannot hang Drop.
    release_tx.send(()).expect("release");
    assert!(
        !stopped,
        "an in-flight blocked probe is not termination proof"
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(
        handle.thread.is_some(),
        "retain join ownership after timeout"
    );
    assert!(handle.shutdown_checked(HANG_GUARD));
    assert!(handle.thread.is_none());
    assert_eq!(handle.status(), GovernorStatus::Stopped);
    assert!(handle.shutdown_checked(Duration::ZERO));
}

#[test]
fn first_sample_is_immediate_and_published() {
    let (probe, _) = probe(|_, _| sample(10.0));
    let handle = Governor::start_with(config(), probe, Arc::new(SystemClock::default())).unwrap();
    wait_until("first sample", Duration::from_secs(5), || seq(&handle) == 1);
    assert_eq!(handle.status(), GovernorStatus::Running);
    assert_eq!(handle.history().len(), 1);
    assert_eq!(handle.stats().samples, 1);
    assert_eq!(handle.stats().slow_tier_samples, 1);
    // Idle: the next sample is 15 s away, so nothing more arrives soon.
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(seq(&handle), 1);
}

#[test]
fn callers_never_wait_for_a_slow_probe() {
    let (probe, calls) = probe(|_, _| {
        std::thread::sleep(Duration::from_millis(1500));
        sample(10.0)
    });
    let handle = Governor::start_with(config(), probe, Arc::new(SystemClock::default())).unwrap();
    wait_until("probe running", HANG_GUARD, || {
        calls.load(Ordering::SeqCst) >= 1
    });
    let started = Instant::now();
    for _ in 0..100 {
        assert_eq!(handle.snapshot_or_unknown().seq, 0);
        let advice = handle.capacity(&RunningWork::default(), &CapacityRequest::default());
        assert_eq!(advice.data, DataQuality::NoData);
        assert_eq!(
            advice.additional,
            u32::MAX,
            "Presets impose no count ceiling; admission still requires real telemetry"
        );
        let _ = handle.latest();
        let _ = handle.status();
        handle.set_activity(Activity {
            active_tasks: 1,
            resource_view_open: false,
        });
    }
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn activity_change_wakes_an_idle_sampler() {
    let (probe, _) = probe(|_, _| sample(10.0));
    let handle = Governor::start_with(config(), probe, Arc::new(SystemClock::default())).unwrap();
    wait_until("first sample", HANG_GUARD, || seq(&handle) == 1);
    let started = Instant::now();
    handle.set_activity(Activity {
        active_tasks: 1,
        resource_view_open: false,
    });
    wait_until("second sample", Duration::from_secs(5), || {
        seq(&handle) == 2
    });
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(3),
        "1 Hz after activity, not the 15 s idle wait: {elapsed:?}"
    );
    assert_eq!(
        handle.latest().unwrap().sampling.reason,
        crate::model::CadenceReason::ActiveWork
    );
}

#[test]
fn mode_change_resamples_at_once_and_notifies_subscribers() {
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let (probe, _) = probe(move |call, _| {
        if call == 1 {
            entered_tx.send(()).expect("first probe entered");
            release_rx
                .recv_timeout(HANG_GUARD)
                .expect("release first probe");
        }
        sample(72.0)
    });
    let handle = Governor::start_with(config(), probe, Arc::new(SystemClock::default())).unwrap();
    let mut release = ProbeRelease(Some(release_tx));
    let entered = entered_rx.recv_timeout(HANG_GUARD);
    // Subscribe while the first probe is held so its first publication cannot
    // race ahead of this future-only stream.
    let updates = handle.subscribe(64);
    let released = release.release();
    assert!(entered.is_ok(), "first probe did not enter: {entered:?}");
    assert!(
        released.is_ok(),
        "first probe was not released: {released:?}"
    );
    wait_until("first sample", HANG_GUARD, || seq(&handle) == 1);
    handle.set_mode(ResourceMode::Conservative).unwrap();
    assert_eq!(
        handle.limits().kind,
        ModeKind::Conservative,
        "limits switch synchronously"
    );
    wait_until("resample", Duration::from_secs(3), || seq(&handle) == 2);

    let received: Vec<GovernorUpdate> = updates.try_iter().collect();
    let pressure: Vec<(PressureLevel, PressureLevel, ModeKind)> = received
        .iter()
        .filter_map(|u| match u {
            GovernorUpdate::PressureChanged(t) if t.resource == ResourceKind::Cpu => {
                Some((t.from, t.to, t.mode))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        pressure,
        vec![
            (
                PressureLevel::Normal,
                PressureLevel::Elevated,
                ModeKind::Balanced
            ),
            (
                PressureLevel::Elevated,
                PressureLevel::High,
                ModeKind::Conservative
            ),
        ]
    );
    assert!(received.contains(&GovernorUpdate::ModeChanged(ModeChange {
        from: ModeKind::Balanced,
        to: ModeKind::Conservative
    })));
    assert_eq!(
        received
            .iter()
            .filter(|u| matches!(u, GovernorUpdate::Sample(_)))
            .count(),
        2
    );
    assert_eq!(handle.recent_transitions().len(), 2);
}

#[test]
fn invalid_custom_limits_are_rejected_synchronously() {
    let bad = ResourceMode::Custom(CustomLimits {
        max_cpu_percent: 1,
        ..CustomLimits::default()
    });
    let (p, _) = probe(|_, _| sample(10.0));
    assert!(
        Governor::start_with(
            GovernorConfig {
                mode: bad.clone(),
                ..config()
            },
            p,
            Arc::new(SystemClock::default())
        )
        .is_err()
    );
    let (p, _) = probe(|_, _| sample(10.0));
    let handle = Governor::start_with(config(), p, Arc::new(SystemClock::default())).unwrap();
    assert!(handle.set_mode(bad).is_err());
    assert_eq!(handle.limits().kind, ModeKind::Balanced);
}

#[test]
fn a_panicking_probe_degrades_then_stops_without_affecting_callers() {
    let (probe, calls) = probe(|_, _| panic!("simulated probe failure"));
    let clock = Arc::new(ManualClock::racing(Duration::from_secs(120)));
    let handle = Governor::start_with(config(), probe, clock).unwrap();
    wait_until("give up", Duration::from_secs(10), || {
        matches!(handle.status(), GovernorStatus::Failed { .. })
    });
    assert_eq!(calls.load(Ordering::SeqCst), MAX_CONSECUTIVE_PANICS);
    let snapshot = handle.latest().unwrap();
    assert!(!snapshot.cpu.is_value() && !snapshot.memory.is_value());
    assert!(snapshot.pressure.entries.is_empty());
    assert_eq!(
        handle.stats().failed_samples,
        u64::from(MAX_CONSECUTIVE_PANICS)
    );
    let advice = handle.capacity(
        &RunningWork {
            agents: 1,
            ..Default::default()
        },
        &CapacityRequest::default(),
    );
    assert_eq!(
        (advice.data, advice.additional),
        (DataQuality::NoData, u32::MAX)
    );
    // Commands after the thread stopped are accepted and ignored; nothing panics or blocks.
    handle.set_activity(Activity {
        active_tasks: 3,
        resource_view_open: true,
    });
    handle.track_process(42, crate::ProcessRole::Descendant);
    drop(handle);
}

#[test]
fn a_transient_panic_recovers() {
    let (probe, _) = probe(|call, _| {
        if call == 2 {
            panic!("one-off failure");
        }
        sample(10.0)
    });
    let clock = Arc::new(ManualClock::racing(Duration::from_secs(120)));
    let handle = Governor::start_with(config(), probe, clock).unwrap();
    wait_until("recovery", Duration::from_secs(10), || seq(&handle) >= 4);
    assert_eq!(handle.status(), GovernorStatus::Running);
    assert_eq!(handle.stats().failed_samples, 1);
}

#[test]
fn shutdown_is_prompt_during_an_idle_wait() {
    let (probe, _) = probe(|_, _| sample(10.0));
    let handle = Governor::start_with(config(), probe, Arc::new(SystemClock::default())).unwrap();
    wait_until("first sample", HANG_GUARD, || seq(&handle) == 1);
    let started = Instant::now();
    handle.shutdown();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn lagging_subscribers_lose_updates_and_history_stays_bounded() {
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let (probe, _) = probe(move |call, _| {
        if call == 1 {
            entered_tx.send(()).expect("first probe entered");
            release_rx
                .recv_timeout(HANG_GUARD)
                .expect("release first probe");
        }
        sample(10.0)
    });
    let clock = Arc::new(ManualClock::racing(Duration::from_secs(120)));
    let config = GovernorConfig {
        history_capacity: 5,
        ..config()
    };
    let handle = Governor::start_with(config, probe, clock).unwrap();
    let mut release = ProbeRelease(Some(release_tx));
    let entered = entered_rx.recv_timeout(HANG_GUARD);
    let never_read = handle.subscribe(1);
    let dropped = handle.subscribe(4);
    drop(dropped);
    let released = release.release();
    assert!(entered.is_ok(), "first probe did not enter: {entered:?}");
    assert!(
        released.is_ok(),
        "first probe was not released: {released:?}"
    );
    wait_until("samples", Duration::from_secs(10), || seq(&handle) >= 30);
    assert!(handle.stats().dropped_updates > 0);
    assert_eq!(handle.history().len(), 5);
    handle.shutdown();
    assert_eq!(
        never_read.try_iter().count(),
        1,
        "the buffer held one update; the rest were dropped"
    );
}

#[test]
fn tracked_processes_and_workspaces_reach_the_probe() {
    let seen: PlanLog = Arc::default();
    let log = Arc::clone(&seen);
    let (probe, _) = probe(move |_, plan| {
        let pids = plan.roots.iter().map(|r| r.pid).collect();
        log.lock().unwrap().push((pids, plan.workspace_roots.len()));
        sample(10.0)
    });
    let clock = Arc::new(ManualClock::racing(Duration::from_secs(120)));
    let handle = Governor::start_with(config(), probe, clock).unwrap();
    let role = crate::ProcessRole::Provider {
        provider: ProviderId::new("claude-code"),
        thread_id: None,
    };
    handle.track_process(500, role);
    handle.set_workspaces(vec![WorkspaceRoot {
        workspace_id: Some("w".into()),
        path: "/w".into(),
    }]);
    wait_until("plan with root", Duration::from_secs(10), || {
        seen.lock()
            .unwrap()
            .iter()
            .any(|(pids, ws)| pids == &vec![500] && *ws == 1)
    });
    handle.untrack_process(500);
    let len = seen.lock().unwrap().len();
    wait_until("plan without root", Duration::from_secs(10), || {
        seen.lock().unwrap()[len..]
            .iter()
            .any(|(pids, _)| pids.is_empty())
    });
}

#[test]
fn proposals_are_only_explanations() {
    let (probe, _) = probe(|_, _| sample(99.0));
    let handle = Governor::start_with(config(), probe, Arc::new(SystemClock::default())).unwrap();
    wait_until("first sample", HANG_GUARD, || seq(&handle) == 1);
    let proposals = handle.proposals(&RunningWork {
        agents: 3,
        ..Default::default()
    });
    assert_eq!(proposals.len(), 1);
    assert!(proposals.iter().all(|p| p.requires_user));
}
