//! Real-PTY regression tests for Operations-owned terminal sessions.

#![allow(clippy::expect_used)]

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_core::events::EventPayload;
use kalcode_core::flags::BuildChannel;
use kalcode_core::plans::{Limited, PlanLimit, PlanTier};
use kalcode_core::workspaces::TerminalStatus;
use kalcode_core::{Core, CoreConfig, Paths};
use kalcode_pty::TerminalSize;

fn config(dir: &Path) -> CoreConfig {
    CoreConfig {
        paths: Paths::new(dir),
        app_version: "0.1.7-test".into(),
        channel: BuildChannel::Development,
    }
}

fn open(dir: &Path) -> Arc<Core> {
    Arc::new(Core::open(config(dir)).expect("open core"))
}

fn size() -> TerminalSize {
    TerminalSize::new(120, 30).expect("size")
}

fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    condition()
}

fn long_running_command(core: &Core) -> &'static str {
    match core.shells().first().map(|shell| shell.id.as_str()) {
        Some("pwsh" | "powershell") => {
            "Write-Output operation-running; while ($true) { Start-Sleep -Seconds 1 }"
        }
        Some("cmd") => "echo operation-running && ping -t 127.0.0.1",
        _ => "echo operation-running; while :; do sleep 1; done",
    }
}

#[test]
fn operation_terminal_runs_command_and_reports_nonzero_exit() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace = core.open_workspace(project.path()).expect("workspace");
    let success_id = uuid::Uuid::now_v7().to_string();

    let terminal = core
        .create_operation_terminal(
            &workspace.id,
            &success_id,
            "echo operation-ready",
            size(),
            None,
        )
        .expect("start operation");
    assert_eq!(terminal.id, success_id);
    assert!(terminal.shell_id.starts_with("operation:"));
    assert!(wait_until(Duration::from_secs(20), || {
        core.terminal(&terminal.id)
            .is_ok_and(|terminal| terminal.status == TerminalStatus::Exited)
    }));
    let output = core
        .terminal_output(&terminal.id)
        .expect("output")
        .expect("session output");
    assert!(output.contains("operation-ready"), "{output:?}");

    let secret_id = uuid::Uuid::now_v7().to_string();
    let secret = format!("{}{}", "ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
    core.create_operation_terminal(
        &workspace.id,
        &secret_id,
        &format!("echo TOKEN={secret}"),
        size(),
        None,
    )
    .expect("start redaction operation");
    assert!(wait_until(Duration::from_secs(20), || {
        core.terminal(&secret_id)
            .is_ok_and(|terminal| terminal.status == TerminalStatus::Exited)
    }));
    let output = core
        .terminal_output(&secret_id)
        .expect("redacted output")
        .expect("session output");
    assert!(!output.contains(&secret));
    assert!(output.contains("[REDACTED:"), "{output:?}");

    let failure_id = uuid::Uuid::now_v7().to_string();
    core.create_operation_terminal(&workspace.id, &failure_id, "exit 7", size(), None)
        .expect("start failing operation");
    assert!(wait_until(Duration::from_secs(20), || {
        core.terminal(&failure_id)
            .is_ok_and(|terminal| terminal.exit_code == Some(7))
    }));
}

#[test]
fn stop_is_generation_bound_keeps_logs_and_restart_replaces_generation() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace = core.open_workspace(project.path()).expect("workspace");
    let operation_id = uuid::Uuid::now_v7().to_string();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    core.subscribe(move |event| {
        sink.lock().expect("events").push(event.clone());
        true
    });
    core.create_operation_terminal(
        &workspace.id,
        &operation_id,
        long_running_command(&core),
        size(),
        None,
    )
    .expect("start operation");
    assert!(wait_until(Duration::from_secs(20), || {
        core.terminal_output(&operation_id)
            .ok()
            .flatten()
            .is_some_and(|output| output.contains("operation-running"))
    }));

    let first = core
        .terminal_session_identity(&operation_id)
        .expect("running identity");
    let stale = core
        .stop_operation_terminal(&operation_id, Some(first.generation + 1))
        .expect_err("stale generation refused");
    assert_eq!(stale.code, "terminal_replaced");
    let stale_interrupt = core
        .interrupt_terminal(&operation_id, first.generation + 1)
        .expect_err("stale interrupt refused");
    assert_eq!(stale_interrupt.code, "terminal_replaced");
    assert_eq!(
        core.terminal_session_identity(&operation_id),
        Some(first),
        "stale stop must not mutate the live session"
    );

    core.stop_operation_terminal(&operation_id, Some(first.generation))
        .expect("stop current operation");
    let output = core
        .terminal_output(&operation_id)
        .expect("output")
        .expect("retained scrollback");
    assert!(output.contains("operation-running"), "{output:?}");
    assert!(core.terminal_session_identity(&operation_id).is_none());
    assert!(wait_until(Duration::from_secs(20), || {
        events.lock().expect("events").iter().any(|event| {
            matches!(
                &event.event,
                EventPayload::ShellCompleted {
                    terminal_id,
                    closed_by_user: false,
                    ..
                } if terminal_id == &operation_id
            )
        })
    }));
    assert!(!events.lock().expect("events").iter().any(|event| {
        matches!(
            &event.event,
            EventPayload::ShellFailed { terminal_id, .. } if terminal_id == &operation_id
        )
    }));

    core.create_operation_terminal(
        &workspace.id,
        &operation_id,
        long_running_command(&core),
        size(),
        None,
    )
    .expect("restart operation");
    let second = core
        .terminal_session_identity(&operation_id)
        .expect("replacement identity");
    assert_ne!(second.generation, first.generation);
    core.stop_operation_terminal(&operation_id, Some(second.generation))
        .expect("stop replacement operation");
}

#[test]
fn operation_identity_cannot_cross_workspaces_or_stop_an_ordinary_terminal() {
    let data = tempfile::tempdir().expect("data");
    let first_project = tempfile::tempdir().expect("first project");
    let second_project = tempfile::tempdir().expect("second project");
    let core = open(data.path());
    let first = core
        .open_workspace(first_project.path())
        .expect("first workspace");
    let second = core
        .open_workspace(second_project.path())
        .expect("second workspace");

    for invalid in [
        String::new(),
        "echo before\0echo after".to_owned(),
        "x".repeat(64 * 1024 + 1),
    ] {
        let invalid_id = uuid::Uuid::now_v7().to_string();
        let error = core
            .create_operation_terminal(&first.id, &invalid_id, &invalid, size(), None)
            .expect_err("invalid operation command");
        assert_eq!(error.code, "invalid_operation_command");
    }

    let operation_id = uuid::Uuid::now_v7().to_string();
    core.create_operation_terminal(&first.id, &operation_id, "echo first", size(), None)
        .expect("first operation");
    let conflict = core
        .create_operation_terminal(&second.id, &operation_id, "echo second", size(), None)
        .expect_err("operation id cannot move workspaces");
    assert_eq!(conflict.code, "terminal_id_conflict");

    let ordinary = core
        .create_terminal(&first.id, None, size(), None)
        .expect("ordinary terminal");
    let refused = core
        .stop_operation_terminal(&ordinary.id, None)
        .expect_err("ordinary terminal is not operation-owned");
    assert_eq!(refused.code, "terminal_not_operation_owned");
    core.close_terminal(&ordinary.id).expect("close ordinary");
}

#[test]
fn operation_terminal_counts_toward_the_plan_terminal_limit() {
    let data = tempfile::tempdir().expect("data");
    let project = tempfile::tempdir().expect("project");
    let core = open(data.path());
    let workspace = core.open_workspace(project.path()).expect("workspace");
    let limit = Some(PlanLimit {
        tier: PlanTier::Free,
        kind: Limited::OpenTerminals,
        max: 1,
    });
    let ordinary = core
        .create_terminal(&workspace.id, None, size(), limit)
        .expect("first terminal fits the plan");

    let operation_id = uuid::Uuid::now_v7().to_string();
    let refused = core
        .create_operation_terminal(&workspace.id, &operation_id, "echo capped", size(), limit)
        .expect_err("a capped plan refuses another terminal");
    assert_eq!(refused.code, "too_many_terminals");
    assert!(
        refused
            .message
            .starts_with("The Free plan allows 1 open terminal.")
    );

    // A finished operation terminal is only the run's log: it doesn't count as open.
    core.close_terminal(&ordinary.id).expect("close ordinary");
    let finished_id = uuid::Uuid::now_v7().to_string();
    let finished = core
        .create_operation_terminal(&workspace.id, &finished_id, "exit 0", size(), limit)
        .expect("the only terminal fits the plan");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while core
        .terminals(&workspace.id)
        .expect("list")
        .iter()
        .any(|t| t.id == finished.id && t.ended_at.is_none())
    {
        assert!(
            std::time::Instant::now() < deadline,
            "operation never finished"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let ordinary = core
        .create_terminal(&workspace.id, None, size(), limit)
        .expect("a finished operation terminal leaves room");
    // Running the finished operation again needs room like a new terminal.
    let again = core
        .create_operation_terminal(&workspace.id, &finished_id, "exit 0", size(), limit)
        .expect_err("rerunning a finished operation is admitted like a new terminal");
    assert_eq!(again.code, "too_many_terminals");

    // No numeric cap (Owner, MAX, MAX 2X) never refuses an operation terminal.
    core.create_operation_terminal(&workspace.id, &operation_id, "echo uncapped", size(), None)
        .expect("an uncapped plan starts the operation");
    core.close_terminal(&ordinary.id).expect("close ordinary");
}
