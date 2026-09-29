use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

use super::{
    ExitAttempt, ExitEventCleanup, begin_exit_attempt, drain_on_exit_event, finish_exit_attempt,
    route_main_close,
    runtime_shutdown::{ExitControl, RuntimeShutdown},
};

#[test]
fn main_close_is_synchronously_retained_and_routed_through_app_exit() {
    let prevented = AtomicUsize::new(0);
    let requested = AtomicUsize::new(0);
    route_main_close(
        "main",
        false,
        || {
            prevented.fetch_add(1, Ordering::SeqCst);
        },
        || {
            requested.fetch_add(1, Ordering::SeqCst);
        },
    );
    assert_eq!(prevented.load(Ordering::SeqCst), 1);
    assert_eq!(requested.load(Ordering::SeqCst), 1);
}

#[test]
fn child_and_final_ready_main_closes_keep_their_native_semantics() {
    for (label, ready) in [("browser-child", false), ("main", true)] {
        let prevented = AtomicUsize::new(0);
        let requested = AtomicUsize::new(0);
        route_main_close(
            label,
            ready,
            || {
                prevented.fetch_add(1, Ordering::SeqCst);
            },
            || {
                requested.fetch_add(1, Ordering::SeqCst);
            },
        );
        assert_eq!(prevented.load(Ordering::SeqCst), 0);
        assert_eq!(requested.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn bounded_cleanup_coalesces_duplicates_and_a_failed_attempt_remains_retryable() {
    let exit = ExitControl::default();
    assert_eq!(begin_exit_attempt(&exit), ExitAttempt::Start);
    assert_eq!(begin_exit_attempt(&exit), ExitAttempt::Pending);

    finish_exit_attempt(&exit, false);
    assert_eq!(begin_exit_attempt(&exit), ExitAttempt::Start);

    finish_exit_attempt(&exit, true);
    assert_eq!(begin_exit_attempt(&exit), ExitAttempt::Ready);
}

/// Generous: these tests never reach it unless they assert the limit itself.
const JOIN_LIMIT: Duration = Duration::from_secs(30);

#[test]
fn exit_event_after_a_completed_exit_request_does_not_drain_again() {
    // Red close button / app.exit / updater: ExitRequested drained, then the loop ends.
    let exit = ExitControl::default();
    assert_eq!(begin_exit_attempt(&exit), ExitAttempt::Start);
    finish_exit_attempt(&exit, true);
    assert_eq!(
        drain_on_exit_event(&exit, JOIN_LIMIT, || panic!(
            "a completed drain must not run again"
        )),
        ExitEventCleanup::AlreadyDrained
    );
    assert!(exit.event_loop_ended());
    assert_eq!(begin_exit_attempt(&exit), ExitAttempt::Ready);
}

#[test]
fn exit_event_without_an_exit_request_drains_once_synchronously() {
    // macOS terminate: (Cmd+Q, Dock Quit, logout, shutdown) delivers Exit alone.
    let exit = ExitControl::default();
    let attempts = AtomicUsize::new(0);
    let observed_loop_ended = AtomicUsize::new(0);
    assert_eq!(
        drain_on_exit_event(&exit, JOIN_LIMIT, || {
            attempts.fetch_add(1, Ordering::SeqCst);
            // Cleanup must already know the loop is gone, so it never waits on the main thread.
            if exit.event_loop_ended() {
                observed_loop_ended.fetch_add(1, Ordering::SeqCst);
            }
            true
        }),
        ExitEventCleanup::Drained
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert_eq!(observed_loop_ended.load(Ordering::SeqCst), 1);
    // A duplicate Exit, or a late ExitRequested, sees the proof and does nothing.
    assert_eq!(begin_exit_attempt(&exit), ExitAttempt::Ready);
    assert_eq!(
        drain_on_exit_event(&exit, JOIN_LIMIT, || panic!(
            "drained exit must not drain again"
        )),
        ExitEventCleanup::AlreadyDrained
    );
}

#[test]
fn failed_exit_event_drain_is_reported_once() {
    let exit = ExitControl::default();
    let attempts = AtomicUsize::new(0);
    assert_eq!(
        drain_on_exit_event(&exit, JOIN_LIMIT, || {
            attempts.fetch_add(1, Ordering::SeqCst);
            false
        }),
        ExitEventCleanup::Incomplete
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}

/// Mirrors the `ExitRequested` worker: one serialized `RuntimeShutdown` attempt with the given
/// result, held open until `release`, then `finish_exit_attempt`.
fn in_flight_exit_request(
    exit: &Arc<ExitControl>,
    shutdown: &Arc<RuntimeShutdown>,
    attempts: &Arc<AtomicUsize>,
    hold: Duration,
    clean: bool,
) -> std::thread::JoinHandle<()> {
    assert_eq!(begin_exit_attempt(exit), ExitAttempt::Start);
    let entered = Arc::new(Barrier::new(2));
    let worker = {
        let (exit, shutdown, attempts) = (exit.clone(), shutdown.clone(), attempts.clone());
        let entered = entered.clone();
        std::thread::spawn(move || {
            let result = shutdown.run(|| {
                attempts.fetch_add(1, Ordering::SeqCst);
                entered.wait();
                std::thread::sleep(hold);
                clean
            });
            finish_exit_attempt(&exit, result);
        })
    };
    entered.wait();
    worker
}

#[test]
fn exit_event_during_an_in_flight_exit_request_joins_the_same_single_cleanup() {
    // ExitRequested's worker is mid-drain when terminate: arrives. The Exit handler waits for
    // that one cleanup's outcome (it does not start a second one, and does not deadlock).
    let exit = Arc::new(ExitControl::default());
    let shutdown = Arc::new(RuntimeShutdown::default());
    let attempts = Arc::new(AtomicUsize::new(0));
    let worker =
        in_flight_exit_request(&exit, &shutdown, &attempts, Duration::from_millis(50), true);
    let outcome = drain_on_exit_event(&exit, JOIN_LIMIT, || {
        shutdown.run(|| {
            attempts.fetch_add(1, Ordering::SeqCst);
            true
        })
    });
    worker.join().unwrap();
    assert_eq!(outcome, ExitEventCleanup::Drained);
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert_eq!(begin_exit_attempt(&exit), ExitAttempt::Ready);
}

#[test]
fn exit_event_joining_a_failed_exit_request_never_starts_a_second_drain() {
    // The joined attempt fails (in production: wait_drained's 30 s timeout). RuntimeShutdown
    // caches success only, so re-running here would spend a second full bound on exit.
    let exit = Arc::new(ExitControl::default());
    let shutdown = Arc::new(RuntimeShutdown::default());
    let attempts = Arc::new(AtomicUsize::new(0));
    let hold = Duration::from_millis(100);
    let worker = in_flight_exit_request(&exit, &shutdown, &attempts, hold, false);
    let outcome = drain_on_exit_event(&exit, JOIN_LIMIT, || {
        shutdown.run(|| {
            attempts.fetch_add(1, Ordering::SeqCst);
            false
        })
    });
    worker.join().unwrap();
    assert_eq!(outcome, ExitEventCleanup::JoinFailed);
    // Exactly one drain in total: the joined attempt's. The exit never ran its own.
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}

#[test]
fn exit_event_join_is_bounded_even_if_the_in_flight_drain_overruns() {
    let exit = Arc::new(ExitControl::default());
    let shutdown = Arc::new(RuntimeShutdown::default());
    let attempts = Arc::new(AtomicUsize::new(0));
    let worker = in_flight_exit_request(&exit, &shutdown, &attempts, Duration::from_secs(2), true);
    let started = Instant::now();
    let outcome = drain_on_exit_event(&exit, Duration::from_millis(100), || {
        panic!("a joined exit must not start its own drain")
    });
    let elapsed = started.elapsed();
    assert_eq!(outcome, ExitEventCleanup::JoinFailed);
    assert!(elapsed < Duration::from_millis(1_500), "{elapsed:?}");
    worker.join().unwrap();
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}
