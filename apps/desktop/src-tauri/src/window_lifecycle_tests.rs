use std::sync::atomic::{AtomicUsize, Ordering};

use super::{
    ExitAttempt, begin_exit_attempt, finish_exit_attempt, route_main_close,
    runtime_shutdown::ExitControl,
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
