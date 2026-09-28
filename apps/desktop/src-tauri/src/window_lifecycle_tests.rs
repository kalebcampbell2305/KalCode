use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};

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

#[test]
fn exit_event_after_a_completed_exit_request_does_not_drain_again() {
    // Red close button / app.exit / updater: ExitRequested drained, then the loop ends.
    let exit = ExitControl::default();
    assert_eq!(begin_exit_attempt(&exit), ExitAttempt::Start);
    finish_exit_attempt(&exit, true);
    assert_eq!(
        drain_on_exit_event(&exit, || panic!("a completed drain must not run again")),
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
        drain_on_exit_event(&exit, || {
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
        drain_on_exit_event(&exit, || panic!("drained exit must not drain again")),
        ExitEventCleanup::AlreadyDrained
    );
}

#[test]
fn failed_exit_event_drain_is_reported_and_stays_retryable() {
    let exit = ExitControl::default();
    assert_eq!(
        drain_on_exit_event(&exit, || false),
        ExitEventCleanup::Incomplete
    );
    assert_eq!(begin_exit_attempt(&exit), ExitAttempt::Start);
}

#[test]
fn exit_event_during_an_in_flight_exit_request_joins_the_same_single_cleanup() {
    // ExitRequested's worker is mid-drain when terminate: arrives. The Exit handler must wait
    // for that one serialized cleanup (not start a second one, and not deadlock).
    let exit = Arc::new(ExitControl::default());
    let shutdown = Arc::new(RuntimeShutdown::default());
    let attempts = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    assert_eq!(begin_exit_attempt(&exit), ExitAttempt::Start);
    let worker = {
        let (exit, shutdown, attempts) = (exit.clone(), shutdown.clone(), attempts.clone());
        let (entered, release) = (entered.clone(), release.clone());
        std::thread::spawn(move || {
            let clean = shutdown.run(|| {
                attempts.fetch_add(1, Ordering::SeqCst);
                entered.wait();
                release.wait();
                true
            });
            finish_exit_attempt(&exit, clean);
        })
    };
    entered.wait();
    let releaser = {
        let release = release.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            release.wait();
        })
    };
    let outcome = drain_on_exit_event(&exit, || {
        shutdown.run(|| {
            attempts.fetch_add(1, Ordering::SeqCst);
            true
        })
    });
    releaser.join().unwrap();
    worker.join().unwrap();
    assert_eq!(outcome, ExitEventCleanup::Drained);
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert_eq!(begin_exit_attempt(&exit), ExitAttempt::Ready);
}
