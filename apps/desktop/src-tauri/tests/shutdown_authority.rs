//! Source-level architecture guard: account/runtime teardown must consume typed shutdown proof.

#![allow(clippy::expect_used)]

const COORDINATOR: &str = include_str!("../src/runtime_coordinator.rs");

#[test]
fn coordinator_requires_checked_thread_and_bridge_shutdown() {
    assert!(
        COORDINATOR.contains("threads.shutdown_checked().is_ok()"),
        "runtime coordinator must treat unproven thread termination as an unclean drain"
    );
    assert!(
        COORDINATOR.contains("panes.shutdown_checked().is_ok()"),
        "runtime coordinator must treat an unjoined hook listener as an unclean drain"
    );
}
