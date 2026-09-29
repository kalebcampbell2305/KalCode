use super::*;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};

use kalcode_kalvoice::signals::KalVoiceSignal;
use kalcode_resources::probe::{Counters, ProbePlan, RawCpu, RawMemory, RawSample};
use kalcode_resources::{
    AdmissionState, ModeLimits, Reading, ResourceKind, ResourceSnapshot, SystemProbe,
};
use tauri::ipc::{Channel, InvokeResponseBody};

type Published = Arc<Mutex<Vec<(LocalReasoningStatus, Option<&'static str>)>>>;

// ------------------------------------------------------------------------------------------
// Fakes

struct FakeWorker {
    stop_allowed: AtomicBool,
    calls: AtomicUsize,
    stopping: AtomicBool,
}
impl LocalInterpreter for FakeWorker {
    fn interpret(
        &self,
        _: LocalInterpretationRequest,
        _: Instant,
        _: &LocalInterpretationCancellation,
    ) -> Result<LocalInterpretation, LocalInterpretationError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(LocalInterpretation::Uncertain)
    }
}
impl ManagedInterpreter for FakeWorker {
    fn warm(&self, _: &LocalInterpretationCancellation) -> Result<(), StartFailure> {
        Ok(())
    }
    fn status(&self) -> LlamaWorkerStatus {
        LlamaWorkerStatus::Ready
    }
    fn stop(&self) -> bool {
        self.stopping.store(true, Ordering::SeqCst);
        self.stop_allowed.load(Ordering::SeqCst)
    }
}

/// A worker whose starts follow a shared script (default: success). A failed start leaves no
/// process behind, like a real worker whose child was killed.
struct ScriptedWorker {
    script: Arc<Mutex<VecDeque<Result<(), StartFailure>>>>,
    ready: AtomicBool,
}
impl LocalInterpreter for ScriptedWorker {
    fn interpret(
        &self,
        _: LocalInterpretationRequest,
        _: Instant,
        _: &LocalInterpretationCancellation,
    ) -> Result<LocalInterpretation, LocalInterpretationError> {
        Ok(LocalInterpretation::Uncertain)
    }
}
impl ManagedInterpreter for ScriptedWorker {
    fn warm(&self, _: &LocalInterpretationCancellation) -> Result<(), StartFailure> {
        let next = self
            .script
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front()
            .unwrap_or(Ok(()));
        self.ready.store(next.is_ok(), Ordering::SeqCst);
        next
    }
    fn status(&self) -> LlamaWorkerStatus {
        if self.ready.load(Ordering::SeqCst) {
            LlamaWorkerStatus::Ready
        } else {
            LlamaWorkerStatus::Stopped
        }
    }
    fn stop(&self) -> bool {
        self.ready.store(false, Ordering::SeqCst);
        true
    }
}

struct Prepared {
    script: Arc<Mutex<VecDeque<Result<(), StartFailure>>>>,
    launches: Arc<AtomicUsize>,
}
impl PreparedInterpreter for Prepared {
    fn launch(self: Box<Self>) -> Result<Arc<dyn ManagedInterpreter>, StartFailure> {
        self.launches.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::new(ScriptedWorker {
            script: self.script,
            ready: AtomicBool::new(false),
        }))
    }
}

/// Live reservations, so a test can prove capacity is never double-held or leaked.
struct Reservation(Arc<AtomicUsize>);
impl Drop for Reservation {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
impl ResidentCapacity for Reservation {}
impl ResidentCapacity for () {}

/// The governor permit (real or scripted) plus the live-reservation counter.
struct TestCapacity(Box<dyn ResidentCapacity>, #[allow(dead_code)] Reservation);
impl ResidentCapacity for TestCapacity {
    fn settle_resident(&self) {
        self.0.settle_resident();
    }
    fn arm_request(&self) {
        self.0.arm_request();
    }
}

enum Admission {
    /// Scripted governor decisions (default: admit).
    Scripted(Mutex<VecDeque<AdmissionDecision>>),
    /// The real desktop governor.
    Real(Arc<ResourceGovernorState>),
}

struct FakeHost {
    installed: AtomicBool,
    acquire_script: Mutex<VecDeque<StartFailure>>,
    admission: Admission,
    events: Mutex<Option<Receiver<GovernorUpdate>>>,
    worker_script: Arc<Mutex<VecDeque<Result<(), StartFailure>>>>,
    acquires: AtomicUsize,
    reserves: AtomicUsize,
    launches: Arc<AtomicUsize>,
    live_reservations: Arc<AtomicUsize>,
    voice: kalcode_resources::InteractivePriority,
}

impl FakeHost {
    fn new(admission: Admission, events: Option<Receiver<GovernorUpdate>>) -> Arc<Self> {
        Arc::new(Self {
            installed: AtomicBool::new(true),
            acquire_script: Mutex::new(VecDeque::new()),
            admission,
            events: Mutex::new(events),
            worker_script: Arc::default(),
            acquires: AtomicUsize::new(0),
            reserves: AtomicUsize::new(0),
            launches: Arc::default(),
            live_reservations: Arc::default(),
            voice: kalcode_resources::InteractivePriority::default(),
        })
    }

    fn scripted(decisions: Vec<AdmissionDecision>) -> (Arc<Self>, SyncSender<GovernorUpdate>) {
        let (sender, receiver) = sync_channel(64);
        (
            Self::new(
                Admission::Scripted(Mutex::new(decisions.into())),
                Some(receiver),
            ),
            sender,
        )
    }

    fn fail_starts(&self, failures: impl IntoIterator<Item = StartFailure>) {
        self.worker_script
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .extend(failures.into_iter().map(Err));
    }
}

impl InterpreterHost for FakeHost {
    fn installed(&self) -> bool {
        self.installed.load(Ordering::SeqCst)
    }
    fn acquire(
        &self,
    ) -> Result<(Box<dyn PreparedInterpreter>, LocalWorkloadEstimate), StartFailure> {
        self.acquires.fetch_add(1, Ordering::SeqCst);
        if let Some(failure) = self
            .acquire_script
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front()
        {
            return Err(failure);
        }
        Ok((
            Box::new(Prepared {
                script: self.worker_script.clone(),
                launches: self.launches.clone(),
            }),
            estimate(),
        ))
    }
    fn reserve(
        &self,
        estimate: LocalWorkloadEstimate,
    ) -> Result<Box<dyn ResidentCapacity>, AdmissionDecision> {
        self.reserves.fetch_add(1, Ordering::SeqCst);
        let permit: Box<dyn ResidentCapacity> = match &self.admission {
            Admission::Scripted(decisions) => {
                if let Some(decision) = decisions
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .pop_front()
                {
                    return Err(decision);
                }
                Box::new(())
            }
            Admission::Real(resources) => Box::new(resources.reserve_local_task(estimate)?),
        };
        self.live_reservations.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(TestCapacity(
            permit,
            Reservation(self.live_reservations.clone()),
        )))
    }
    fn capacity_events(&self) -> Option<Receiver<GovernorUpdate>> {
        match &self.admission {
            Admission::Scripted(_) => self
                .events
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take(),
            Admission::Real(resources) => resources.subscribe(CAPACITY_EVENT_BUFFER),
        }
    }
    fn yield_to_voice(&self, cancelled: &dyn Fn() -> bool) -> Duration {
        self.voice
            .yield_to_interactive(MAX_INTERACTIVE_DEFERRAL, cancelled)
    }
}

fn estimate() -> LocalWorkloadEstimate {
    let Ok(estimate) = LocalWorkloadEstimate::inference(Some(1_000), Some(64)) else {
        panic!("a valid test workload");
    };
    estimate
}

fn held(reason: AdmissionReason) -> AdmissionDecision {
    AdmissionDecision {
        state: AdmissionState::Held,
        mode: None,
        additional: 0,
        reasons: vec![reason],
        snapshot_seq: None,
        sampled_at_unix_ms: None,
    }
}

/// What a governor that just started reports: its first sample has no CPU reading yet.
fn cpu_warming_up() -> AdmissionDecision {
    held(AdmissionReason::RequiredTelemetryUnknown {
        resource: ResourceKind::Cpu,
        detail: "warming up: needs a second measurement".into(),
    })
}

fn sample() -> GovernorUpdate {
    GovernorUpdate::Sample(Arc::new(ResourceSnapshot::unknown(
        "test sample",
        ModeLimits::balanced().kind,
    )))
}

/// One round without the backoff that follows it in production, for tests of a single round.
const ONE_ROUND: AutostartPolicy = AutostartPolicy {
    capacity_wait: Duration::from_secs(15 * 60),
    start_attempts: 3,
    retry: None,
};

fn interpreter(host: Arc<FakeHost>, policy: AutostartPolicy) -> Arc<DesktopLocalInterpreter> {
    DesktopLocalInterpreter::with_host(host, None, policy)
}

/// Runs `autostart` on its own thread (as the runtime's background task does), recording
/// every published status.
fn spawn_autostart(
    host: &Arc<DesktopLocalInterpreter>,
) -> (std::thread::JoinHandle<()>, Published) {
    let published: Published = Arc::default();
    let record = published.clone();
    let host = host.clone();
    let driver = std::thread::spawn(move || {
        host.autostart(&|status, issue| {
            record
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((status, issue))
        });
    });
    (driver, published)
}

fn eventually(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn request() -> LocalInterpretationRequest {
    LocalInterpretationRequest {
        request: "show the dashboard please".into(),
        workspace_id: None,
        workspaces: vec![],
    }
}

// ------------------------------------------------------------------------------------------
// Cold start: the governor is not ready when the runtime starts.

#[test]
fn a_freshly_started_governor_holds_the_first_local_start() {
    // The QA7 cold start: the governor is created a moment before KalVoice, so its first
    // sample (if any) has no CPU reading and a local start is held, not refused forever.
    let resources = Arc::new(ResourceGovernorState::start_with_probe(Box::new(
        GatedProbe::new().0,
    )));
    let Err(decision) = resources.reserve_local_task(estimate()) else {
        panic!("a governor without a CPU reading must hold local work");
    };
    assert_eq!(decision.state, AdmissionState::Held);
    assert_eq!(classify_hold(&decision).code, "resource_monitor_starting");
    assert!(!classify_hold(&decision).permanent);
}

#[test]
fn installed_components_reach_ready_on_the_governors_next_sample_without_a_retry() {
    // RED on 41f58b0: warm() tried once, the hold returned None, and nothing re-evaluated, so the
    // UI stayed "Installed; not running" until the owner pressed Retry.
    let (probe, release) = GatedProbe::new();
    let resources = Arc::new(ResourceGovernorState::start_with_probe(Box::new(probe)));
    // Idle machine, no resource view: the governor takes its second CPU measurement at the
    // fast cadence because the first was the warm-up, not a full idle interval (15 s) later.
    let host = FakeHost::new(Admission::Real(resources.clone()), None);
    let reasoning = interpreter(host.clone(), AutostartPolicy::default());
    let (driver, published) = spawn_autostart(&reasoning);

    eventually("the held start to be reported", || {
        reasoning.snapshot()
            == (
                LocalReasoningStatus::Waiting,
                Some("resource_monitor_starting"),
            )
    });
    assert_eq!(host.launches.load(Ordering::SeqCst), 0);
    // The CPU gets its second measurement; that sample alone re-evaluates the start.
    let released = Instant::now();
    release.send(()).unwrap();
    driver.join().unwrap();
    assert!(
        released.elapsed() < Duration::from_secs(3),
        "ready {:?} after the second sample was allowed",
        released.elapsed()
    );

    assert_eq!(reasoning.snapshot(), (LocalReasoningStatus::Ready, None));
    assert_eq!(host.launches.load(Ordering::SeqCst), 1);
    assert_eq!(
        published
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .last(),
        Some(&(LocalReasoningStatus::Ready, None))
    );
    drop(reasoning);
    assert!(resources.shutdown_checked());
}

#[test]
fn a_start_waits_for_push_to_talk_to_finish_and_then_proceeds_without_a_retry() {
    let (host, _samples) = FakeHost::scripted(Vec::new());
    let span = host.voice.begin();
    let reasoning = interpreter(host.clone(), AutostartPolicy::default());
    let (driver, _published) = spawn_autostart(&reasoning);
    std::thread::sleep(Duration::from_millis(150));
    // Nothing verified, reserved or launched while the user is talking.
    assert_eq!(host.acquires.load(Ordering::SeqCst), 0);
    assert_eq!(host.launches.load(Ordering::SeqCst), 0);
    let released = Instant::now();
    drop(span);
    driver.join().unwrap();
    assert!(released.elapsed() < Duration::from_secs(2));
    assert_eq!(reasoning.snapshot(), (LocalReasoningStatus::Ready, None));
    assert_eq!(host.launches.load(Ordering::SeqCst), 1);
}

#[test]
fn push_to_talk_deferral_is_bounded_even_if_a_span_never_ends() {
    let (host, _samples) = FakeHost::scripted(Vec::new());
    // A span nobody ends (a session lost on some path) stops deferring at its bound.
    let gate = kalcode_resources::InteractivePriority::with_cap(Duration::from_millis(100));
    let _span = gate.begin();
    let Some(host) = Arc::into_inner(host) else {
        panic!("sole owner");
    };
    let host = Arc::new(FakeHost {
        voice: gate,
        ..host
    });
    let reasoning = interpreter(host.clone(), AutostartPolicy::default());
    let started = Instant::now();
    let (driver, _published) = spawn_autostart(&reasoning);
    driver.join().unwrap();
    assert!(started.elapsed() >= Duration::from_millis(80));
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(reasoning.snapshot(), (LocalReasoningStatus::Ready, None));
}

#[test]
fn a_cold_start_on_an_idle_machine_is_ready_within_seconds_of_launch() {
    // Launch -> Ready without a visible wait: the second CPU measurement follows the warm-up at
    // the fast cadence, and that sample admits the start. At the idle cadence this took 15 s.
    let (probe, release) = GatedProbe::new();
    release.send(()).unwrap();
    let launched = Instant::now();
    let resources = Arc::new(ResourceGovernorState::start_with_probe(Box::new(probe)));
    let host = FakeHost::new(Admission::Real(resources.clone()), None);
    let reasoning = interpreter(host.clone(), AutostartPolicy::default());
    let (driver, _published) = spawn_autostart(&reasoning);
    driver.join().unwrap();
    assert_eq!(reasoning.snapshot(), (LocalReasoningStatus::Ready, None));
    assert!(
        launched.elapsed() < Duration::from_secs(4),
        "ready {:?} after launch",
        launched.elapsed()
    );
    assert_eq!(host.launches.load(Ordering::SeqCst), 1);
    drop(reasoning);
    assert!(resources.shutdown_checked());
}

#[test]
fn a_held_start_is_re_evaluated_only_on_samples_and_verifies_the_model_only_to_launch() {
    let (host, samples) = FakeHost::scripted(vec![cpu_warming_up(), cpu_warming_up()]);
    let reasoning = interpreter(host.clone(), AutostartPolicy::default());
    let (driver, published) = spawn_autostart(&reasoning);

    eventually("the first hold", || {
        host.reserves.load(Ordering::SeqCst) == 1
    });
    // No sample, no evaluation: the wait is event-driven, never a timer loop.
    std::thread::sleep(WAIT_SLICE * 3);
    assert_eq!(host.reserves.load(Ordering::SeqCst), 1);
    samples.send(sample()).unwrap();
    eventually("the second hold", || {
        host.reserves.load(Ordering::SeqCst) == 2
    });
    samples.send(sample()).unwrap();
    driver.join().unwrap();

    assert_eq!(reasoning.status(), LocalReasoningStatus::Ready);
    assert_eq!(host.reserves.load(Ordering::SeqCst), 3);
    // Verified once to learn the workload and once to launch; never per held sample.
    assert_eq!(host.acquires.load(Ordering::SeqCst), 2);
    assert_eq!(host.launches.load(Ordering::SeqCst), 1);
    assert_eq!(host.live_reservations.load(Ordering::SeqCst), 1);
    // Each distinct transition is published once, in order.
    assert_eq!(
        *published.lock().unwrap_or_else(PoisonError::into_inner),
        vec![
            (
                LocalReasoningStatus::Waiting,
                Some("resource_monitor_starting")
            ),
            (LocalReasoningStatus::Warming, None),
            (LocalReasoningStatus::Ready, None),
        ]
    );
}

#[test]
fn a_transient_cpu_hold_says_so_and_recovers_when_headroom_returns() {
    let (host, samples) = FakeHost::scripted(vec![held(AdmissionReason::Capacity {
        holds: vec![HoldReason::CpuHeadroom {
            cpu_percent: 90.0,
            target_percent: 75.0,
            per_agent_percent: 30.0,
            mode: ModeLimits::balanced().kind,
        }],
    })]);
    let reasoning = interpreter(host.clone(), AutostartPolicy::default());
    let (driver, _published) = spawn_autostart(&reasoning);
    eventually("the CPU hold", || {
        reasoning.snapshot() == (LocalReasoningStatus::Waiting, Some("cpu_headroom"))
    });
    samples.send(sample()).unwrap();
    driver.join().unwrap();
    assert_eq!(reasoning.status(), LocalReasoningStatus::Ready);
    assert_eq!(host.launches.load(Ordering::SeqCst), 1);
}

#[test]
fn a_hold_that_outlasts_its_window_gives_up_with_a_truthful_reason() {
    let memory = || {
        held(AdmissionReason::Capacity {
            holds: vec![HoldReason::MemoryHeadroom {
                available_mb: 900,
                reserve_mb: 2_048,
                per_agent_mb: 1_800,
                mode: ModeLimits::balanced().kind,
            }],
        })
    };
    let (host, samples) = FakeHost::scripted(vec![memory(), memory(), memory()]);
    let reasoning = interpreter(
        host.clone(),
        AutostartPolicy {
            capacity_wait: Duration::from_millis(50),
            start_attempts: 3,
            retry: None,
        },
    );
    let (driver, published) = spawn_autostart(&reasoning);
    eventually("the memory hold", || {
        reasoning.snapshot() == (LocalReasoningStatus::Waiting, Some("memory_headroom"))
    });
    std::thread::sleep(Duration::from_millis(60));
    samples.send(sample()).unwrap();
    driver.join().unwrap();
    assert_eq!(
        reasoning.snapshot(),
        (
            LocalReasoningStatus::Failed,
            Some("capacity_wait_exhausted")
        )
    );
    assert_eq!(host.launches.load(Ordering::SeqCst), 0);
    assert_eq!(host.live_reservations.load(Ordering::SeqCst), 0);
    assert_eq!(
        published
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .last(),
        Some(&(
            LocalReasoningStatus::Failed,
            Some("capacity_wait_exhausted")
        ))
    );
}

#[test]
fn a_stopped_governor_is_reported_instead_of_waited_on() {
    let (host, _samples) = FakeHost::scripted(vec![held(AdmissionReason::GovernorNotReady {
        status: GovernorStatus::Failed {
            reason: "the resource probe kept failing".into(),
        },
    })]);
    let reasoning = interpreter(host.clone(), ONE_ROUND);
    reasoning.autostart(&|_, _| {});
    assert_eq!(
        reasoning.snapshot(),
        (
            LocalReasoningStatus::Failed,
            Some("resource_monitor_unavailable")
        )
    );
    assert_eq!(host.reserves.load(Ordering::SeqCst), 1);
}

// ------------------------------------------------------------------------------------------
// Genuine failures.

#[test]
fn a_hard_failure_surfaces_its_code_once_and_ends_the_round() {
    let (host, samples) = FakeHost::scripted(vec![]);
    host.acquire_script
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push_back(StartFailure::hard("component_catalog_invalid"));
    let reasoning = interpreter(host.clone(), ONE_ROUND);
    // Returns on its own: no sample is needed to give up, and none restarts it.
    reasoning.autostart(&|_, _| {});
    assert_eq!(
        reasoning.snapshot(),
        (
            LocalReasoningStatus::Failed,
            Some("component_catalog_invalid")
        )
    );
    // The driver has stopped listening: later samples cannot restart it.
    assert!(samples.send(sample()).is_err());
    assert_eq!(host.acquires.load(Ordering::SeqCst), 1);
    assert_eq!(host.launches.load(Ordering::SeqCst), 0);
    assert_eq!(host.live_reservations.load(Ordering::SeqCst), 0);
}

#[test]
fn repeated_start_failures_stop_after_the_bound_with_the_last_code() {
    let (host, samples) = FakeHost::scripted(vec![]);
    host.fail_starts([StartFailure::transient("worker_health_timeout"); 5]);
    let reasoning = interpreter(host.clone(), ONE_ROUND);
    let (driver, _published) = spawn_autostart(&reasoning);
    for attempt in 1..=2 {
        eventually("a failed start", || {
            host.launches.load(Ordering::SeqCst) == attempt
                && reasoning.snapshot()
                    == (LocalReasoningStatus::Failed, Some("worker_health_timeout"))
        });
        samples.send(sample()).unwrap();
    }
    driver.join().unwrap();
    assert_eq!(host.launches.load(Ordering::SeqCst), 3);
    assert_eq!(
        reasoning.snapshot(),
        (LocalReasoningStatus::Failed, Some("worker_health_timeout"))
    );
    // A dead worker's leases and reservation are released rather than pinned.
    assert!(
        reasoning
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .resident
            .is_none()
    );
    assert_eq!(host.live_reservations.load(Ordering::SeqCst), 0);
    assert!(samples.send(sample()).is_err());
    assert_eq!(host.launches.load(Ordering::SeqCst), 3);
}

#[test]
fn an_unclean_previous_exit_recovers_on_the_next_sample() {
    // A worker left by a crashed session can hold the startup path briefly (a stale child or
    // port): the first start fails, the next sample's start succeeds.
    let (host, samples) = FakeHost::scripted(vec![]);
    host.fail_starts([StartFailure::transient("worker_start_failed")]);
    let reasoning = interpreter(host.clone(), AutostartPolicy::default());
    let (driver, published) = spawn_autostart(&reasoning);
    eventually("the failed first start", || {
        reasoning.snapshot() == (LocalReasoningStatus::Failed, Some("worker_start_failed"))
    });
    samples.send(sample()).unwrap();
    driver.join().unwrap();
    assert_eq!(reasoning.snapshot(), (LocalReasoningStatus::Ready, None));
    assert_eq!(host.launches.load(Ordering::SeqCst), 2);
    assert_eq!(host.live_reservations.load(Ordering::SeqCst), 1);
    assert_eq!(
        published
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .last(),
        Some(&(LocalReasoningStatus::Ready, None))
    );
}

#[test]
fn manual_retry_after_giving_up_starts_again_without_reinstalling() {
    let (host, _samples) = FakeHost::scripted(vec![]);
    host.fail_starts([StartFailure::hard("worker_cleanup_unproven")]);
    let reasoning = interpreter(host.clone(), ONE_ROUND);
    reasoning.autostart(&|_, _| {});
    assert_eq!(reasoning.status(), LocalReasoningStatus::Failed);
    reasoning.autostart(&|_, _| {});
    assert_eq!(reasoning.snapshot(), (LocalReasoningStatus::Ready, None));
    assert_eq!(host.launches.load(Ordering::SeqCst), 2);
}

// ------------------------------------------------------------------------------------------
// Nothing is final: bounded exponential backoff and a retry when KalCode comes to the front.

#[test]
fn the_backoff_is_one_five_fifteen_sixty_minutes_then_hourly() {
    let minutes = |round| backoff_delay(round).as_secs() / 60;
    assert_eq!(
        (1..=7).map(minutes).collect::<Vec<_>>(),
        vec![1, 5, 15, 60, 60, 60, 60]
    );
    assert_eq!(minutes(u32::MAX), 60);
    assert_eq!(
        AutostartPolicy::default().retry.map(|delay| delay(1)),
        Some(Duration::from_secs(60))
    );
}

#[test]
fn a_round_that_ends_without_a_start_retries_on_its_own_after_the_backoff() {
    // RED at b5342d6: three failures (or a 15-minute hold) gave up until "Retry local startup".
    let (host, _samples) = FakeHost::scripted(vec![]);
    host.fail_starts([
        StartFailure::transient("worker_health_timeout"),
        StartFailure::hard("worker_cleanup_unproven"),
    ]);
    let rounds = Arc::new(Mutex::new(Vec::new()));
    fn short(round: u32) -> Duration {
        Duration::from_millis(20 * u64::from(round))
    }
    let reasoning = interpreter(
        host.clone(),
        AutostartPolicy {
            capacity_wait: Duration::from_secs(15 * 60),
            start_attempts: 1,
            retry: Some(short),
        },
    );
    let record = rounds.clone();
    reasoning.autostart(&move |status, issue| {
        record
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((status, issue));
    });
    assert_eq!(reasoning.snapshot(), (LocalReasoningStatus::Ready, None));
    assert_eq!(host.launches.load(Ordering::SeqCst), 3);
    let published = rounds
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    assert!(published.contains(&(LocalReasoningStatus::Failed, Some("worker_health_timeout"))));
    assert!(published.contains(&(
        LocalReasoningStatus::Failed,
        Some("worker_cleanup_unproven")
    )));
    assert_eq!(published.last(), Some(&(LocalReasoningStatus::Ready, None)));
    assert_eq!(host.live_reservations.load(Ordering::SeqCst), 1);
}

#[test]
fn coming_back_to_the_front_retries_at_once_without_a_click() {
    let (host, _samples) = FakeHost::scripted(vec![]);
    host.fail_starts([StartFailure::hard("worker_cleanup_unproven")]);
    fn an_hour(_: u32) -> Duration {
        Duration::from_secs(60 * 60)
    }
    let reasoning = interpreter(
        host.clone(),
        AutostartPolicy {
            capacity_wait: Duration::from_secs(15 * 60),
            start_attempts: 3,
            retry: Some(an_hour),
        },
    );
    let (driver, _published) = spawn_autostart(&reasoning);
    eventually("the failed round", || {
        reasoning.snapshot()
            == (
                LocalReasoningStatus::Failed,
                Some("worker_cleanup_unproven"),
            )
    });
    assert_eq!(host.launches.load(Ordering::SeqCst), 1);
    // What a focus event does (through keep_warm): nudge the waiting driver; returns at once.
    reasoning.autostart(&|_, _| {});
    driver.join().unwrap();
    assert_eq!(reasoning.snapshot(), (LocalReasoningStatus::Ready, None));
    assert_eq!(host.launches.load(Ordering::SeqCst), 2);
}

#[test]
fn a_driver_waiting_out_its_backoff_stops_promptly_at_shutdown() {
    let (host, _samples) = FakeHost::scripted(vec![]);
    host.fail_starts([StartFailure::hard("worker_cleanup_unproven")]);
    let reasoning = interpreter(host.clone(), AutostartPolicy::default());
    let (driver, _published) = spawn_autostart(&reasoning);
    eventually("the failed round", || {
        reasoning.status() == LocalReasoningStatus::Failed
    });
    let started = Instant::now();
    assert!(reasoning.shutdown_reasoning(Instant::now() + Duration::from_secs(2)));
    driver.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(host.launches.load(Ordering::SeqCst), 1);
}

// ------------------------------------------------------------------------------------------
// Concurrency and runtime generations.

#[test]
fn a_retry_while_waiting_is_served_by_the_waiting_driver_with_one_launch() {
    let (host, _samples) = FakeHost::scripted(vec![cpu_warming_up()]);
    let reasoning = interpreter(host.clone(), AutostartPolicy::default());
    let (driver, _published) = spawn_autostart(&reasoning);
    eventually("the hold", || {
        reasoning.status() == LocalReasoningStatus::Waiting
    });
    // Retry (or a second keep_warm) returns at once and nudges the one driver.
    reasoning.autostart(&|_, _| {});
    driver.join().unwrap();
    assert_eq!(reasoning.status(), LocalReasoningStatus::Ready);
    assert_eq!(host.launches.load(Ordering::SeqCst), 1);
    assert_eq!(host.live_reservations.load(Ordering::SeqCst), 1);
}

#[test]
fn concurrent_start_requests_launch_exactly_one_worker() {
    let (host, _samples) = FakeHost::scripted(vec![]);
    let reasoning = interpreter(host.clone(), AutostartPolicy::default());
    let drivers: Vec<_> = (0..4).map(|_| spawn_autostart(&reasoning).0).collect();
    for driver in drivers {
        driver.join().unwrap();
    }
    assert_eq!(reasoning.status(), LocalReasoningStatus::Ready);
    assert_eq!(host.launches.load(Ordering::SeqCst), 1);
    assert_eq!(host.live_reservations.load(Ordering::SeqCst), 1);
}

#[test]
fn a_generation_rebuild_during_a_held_start_warms_exactly_once() {
    // The account runtime is rebuilt while the first generation's start is still held: the
    // retired generation must never launch, and its successor launches exactly one worker.
    let (retired_host, _retired_samples) = FakeHost::scripted(vec![cpu_warming_up()]);
    let retired = interpreter(retired_host.clone(), AutostartPolicy::default());
    let (retired_driver, _) = spawn_autostart(&retired);
    eventually("the retired generation's hold", || {
        retired.status() == LocalReasoningStatus::Waiting
    });
    assert!(retired.shutdown_reasoning(Instant::now() + Duration::from_secs(1)));
    retired_driver.join().unwrap();
    assert_eq!(retired_host.launches.load(Ordering::SeqCst), 0);
    assert_eq!(retired.status(), LocalReasoningStatus::Unavailable);

    let (host, _samples) = FakeHost::scripted(vec![]);
    let successor = interpreter(host.clone(), AutostartPolicy::default());
    successor.autostart(&|_, _| {});
    assert_eq!(successor.status(), LocalReasoningStatus::Ready);
    assert_eq!(host.launches.load(Ordering::SeqCst), 1);
    assert_eq!(retired_host.launches.load(Ordering::SeqCst), 0);
}

// ------------------------------------------------------------------------------------------
// Status reaches the page in either subscription order.

fn recording_channel() -> (Channel<KalVoiceSignal>, Arc<Mutex<Vec<String>>>) {
    let received: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = received.clone();
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            sink.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(json);
        }
        Ok(())
    });
    (channel, received)
}

fn reasoning_statuses(received: &Mutex<Vec<String>>) -> Vec<String> {
    received
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .filter(|json| json.contains("\"local_reasoning_status\""))
        .cloned()
        .collect()
}

#[test]
fn a_page_subscribed_before_the_start_receives_every_transition_ending_ready() {
    let signals = Arc::new(super::super::KalVoiceSignals::default());
    let (channel, received) = recording_channel();
    signals.subscribe("main", channel);
    let (host, samples) = FakeHost::scripted(vec![cpu_warming_up()]);
    let reasoning = interpreter(host, AutostartPolicy::default());
    let publisher = signals.clone();
    let driven = reasoning.clone();
    let driver = std::thread::spawn(move || {
        driven.autostart(&|status, issue| {
            publisher.send(&super::super::reasoning_signal(status, issue));
        });
    });
    eventually("the waiting signal", || {
        reasoning_statuses(&received)
            .iter()
            .any(|json| json.contains("\"waiting\"") && json.contains("resource_monitor_starting"))
    });
    samples.send(sample()).unwrap();
    driver.join().unwrap();
    let statuses = reasoning_statuses(&received);
    assert!(statuses.iter().any(|json| json.contains("\"warming\"")));
    assert!(statuses.last().unwrap().contains("\"status\":\"ready\""));
}

#[test]
fn a_page_subscribing_after_the_start_finished_is_told_it_is_ready() {
    let signals = Arc::new(super::super::KalVoiceSignals::default());
    let (host, _samples) = FakeHost::scripted(vec![]);
    let reasoning = interpreter(host, AutostartPolicy::default());
    // Ready with nobody subscribed: that signal was dropped.
    reasoning.autostart(&|status, issue| {
        signals.send(&super::super::reasoning_signal(status, issue));
    });
    let (channel, received) = recording_channel();
    signals.subscribe("main", channel);
    // What kalvoice_subscribe sends every new subscriber.
    signals.send(&super::super::current_reasoning_signal(&reasoning));
    let statuses = reasoning_statuses(&received);
    assert_eq!(statuses.len(), 1);
    assert!(statuses[0].contains("\"status\":\"ready\""));
    assert!(!statuses[0].contains("issue"));
}

// ------------------------------------------------------------------------------------------
// Existing custody guarantees.

#[test]
fn missing_provisioning_and_shutdown_never_launch_or_borrow_a_provider() {
    let (_temp, components) =
        crate::kalvoice_components::provisioning_tests::empty_manager().unwrap();
    let host =
        DesktopLocalInterpreter::new(components, Arc::new(ResourceGovernorState::start()), None);
    let cancel = LocalInterpretationCancellation::default();
    assert_eq!(host.status(), LocalReasoningStatus::NotInstalled);
    assert_eq!(
        host.interpret(request(), Instant::now() + Duration::from_secs(1), &cancel),
        Err(LocalInterpretationError::Unavailable)
    );
    host.autostart(&|_, _| {});
    assert!(
        host.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .resident
            .is_none()
    );
    assert_eq!(host.status(), LocalReasoningStatus::NotInstalled);
    assert!(host.shutdown_reasoning(Instant::now()));
    assert_eq!(host.status(), LocalReasoningStatus::Unavailable);
}

#[test]
fn failed_cleanup_retains_capacity_and_interpreter_until_proven_retry() {
    let (_temp, components) =
        crate::kalvoice_components::provisioning_tests::empty_manager().unwrap();
    let host =
        DesktopLocalInterpreter::new(components, Arc::new(ResourceGovernorState::start()), None);
    let worker = Arc::new(FakeWorker {
        stop_allowed: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
        stopping: AtomicBool::new(false),
    });
    let released = Arc::new(AtomicUsize::new(1));
    host.state
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .resident = Some(Arc::new(Resident {
        worker: worker.clone(),
        capacity: Mutex::new(Box::new(Reservation(released.clone()))),
    }));
    let cancel = LocalInterpretationCancellation::default();
    assert_eq!(
        host.interpret(request(), Instant::now() + Duration::from_secs(1), &cancel),
        Ok(LocalInterpretation::Uncertain)
    );
    assert!(!host.shutdown_reasoning(Instant::now() + Duration::from_secs(1)));
    assert!(worker.stopping.load(Ordering::SeqCst));
    assert_eq!(released.load(Ordering::SeqCst), 1);
    assert_eq!(
        host.interpret(request(), Instant::now() + Duration::from_secs(1), &cancel),
        Err(LocalInterpretationError::Unavailable)
    );
    assert_eq!(worker.calls.load(Ordering::SeqCst), 1);
    worker.stop_allowed.store(true, Ordering::SeqCst);
    assert!(host.shutdown_reasoning(Instant::now() + Duration::from_secs(1)));
    assert_eq!(released.load(Ordering::SeqCst), 0);
    assert!(host.shutdown_reasoning(Instant::now()));
}

// ------------------------------------------------------------------------------------------

/// The OS probe's first CPU reading is always "warming up"; this one reproduces that and then
/// withholds its second sample until the test releases it.
struct GatedProbe {
    samples: usize,
    release: Receiver<()>,
}

impl GatedProbe {
    fn new() -> (Self, SyncSender<()>) {
        let (release, gate) = sync_channel(1);
        (
            Self {
                samples: 0,
                release: gate,
            },
            release,
        )
    }
}

impl SystemProbe for GatedProbe {
    fn sample(&mut self, _plan: &ProbePlan<'_>) -> RawSample {
        self.samples += 1;
        let cpu = if self.samples == 1 {
            Reading::unknown("warming up: needs a second measurement")
        } else {
            if self.samples == 2 {
                let _ = self.release.recv();
            }
            Reading::Value(RawCpu {
                total_percent: 13.0,
                logical_cores: 24,
            })
        };
        RawSample {
            cpu,
            memory: Reading::Value(RawMemory {
                total_bytes: 31 * 1024 * 1024 * 1024,
                available_bytes: 20 * 1024 * 1024 * 1024,
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
