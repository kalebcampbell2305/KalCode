mod common;

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use kalcode_doctor::checks::{CheckOutput, def};
use kalcode_doctor::context::{Budget, HostFacts, RunContext};
use kalcode_doctor::runner::Runner;
use kalcode_doctor::{CheckStatus, DoctorArea, RunStatus};

fn context(timeout: Duration) -> std::io::Result<(tempfile::TempDir, Arc<RunContext>)> {
    let dir = tempfile::tempdir()?;
    let core = common::core(dir.path());
    let ctx = RunContext::new(
        core,
        HostFacts {
            vars: Vec::new(),
            windows: cfg!(windows),
            webview_version: Err("not supplied".into()),
            migrations: kalcode_core::db::MIGRATIONS,
        },
        None,
        None,
        None,
        None,
        Budget::new(timeout),
    );
    Ok((dir, Arc::new(ctx)))
}

#[test]
fn panics_and_timeouts_are_isolated_as_could_not_check() {
    let (_dir, ctx) = context(Duration::from_secs(1)).expect("context");
    let plan = vec![
        def("test.ok", DoctorArea::System, "OK", |_| {
            CheckOutput::passed("OK")
        }),
        def("test.panic", DoctorArea::System, "Panic", |_| {
            panic!("private panic payload")
        }),
        def(
            "test.private_error",
            DoctorArea::System,
            "Private error",
            |_| {
                CheckOutput::could_not_check(
                    "C:\\Users\\owner\\private provider-output token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
                )
            },
        ),
        def("test.slow", DoctorArea::System, "Slow", |ctx| {
            while !ctx.budget.should_stop() {
                thread::yield_now();
            }
            CheckOutput::passed("late")
        }),
    ];
    let batch = Runner::new(Duration::from_millis(25), 8).run(Arc::clone(&ctx), plan);
    assert_eq!(batch.status, RunStatus::Completed);
    assert_eq!(batch.checks[0].status, CheckStatus::Passed);
    assert_eq!(batch.checks[1].status, CheckStatus::CouldNotCheck);
    assert_eq!(
        batch.checks[1].reason.as_deref(),
        Some("The check stopped unexpectedly.")
    );
    assert_eq!(batch.checks[2].status, CheckStatus::CouldNotCheck);
    assert_eq!(
        batch.checks[2].reason.as_deref(),
        Some("The check could not be completed safely.")
    );
    assert_eq!(batch.checks[3].status, CheckStatus::CouldNotCheck);
    assert_eq!(
        batch.checks[3].reason.as_deref(),
        Some("The check timed out.")
    );
    let encoded = serde_json::to_string(&batch).expect("json");
    assert!(!encoded.contains("private panic payload"));
    assert!(!encoded.contains("Users\\owner"));
    assert!(!encoded.contains("ghp_"));
}

#[test]
fn cancellation_marks_unfinished_checks_and_returns_promptly() {
    let (_dir, ctx) = context(Duration::from_secs(5)).expect("context");
    let token = ctx.budget.clone();
    let plan = vec![def("test.wait", DoctorArea::System, "Wait", |ctx| {
        while !ctx.budget.should_stop() {
            thread::yield_now();
        }
        CheckOutput::passed("late")
    })];
    let handle = thread::spawn(move || Runner::new(Duration::from_secs(2), 8).run(ctx, plan));
    thread::sleep(Duration::from_millis(20));
    token.cancel();
    let batch = handle.join().expect("runner");
    assert_eq!(batch.status, RunStatus::Cancelled);
    assert_eq!(batch.checks[0].status, CheckStatus::Cancelled);
}

#[test]
fn runner_refuses_an_unbounded_dynamic_plan() {
    let (_dir, ctx) = context(Duration::from_secs(1)).expect("context");
    let plan = (0..9)
        .map(|n| {
            def(format!("test.{n}"), DoctorArea::System, "x", |_| {
                CheckOutput::passed("OK")
            })
        })
        .collect();
    let batch = Runner::new(Duration::from_secs(1), 8).run(ctx, plan);
    assert_eq!(batch.status, RunStatus::Completed);
    assert!(batch.checks.is_empty());
    assert_eq!(batch.error.as_deref(), Some("check_limit_exceeded"));
}

#[test]
fn progress_reports_each_terminal_check_without_publishing_partial_findings() {
    let (_dir, ctx) = context(Duration::from_secs(1)).expect("context");
    let plan = vec![
        def("test.one", DoctorArea::System, "One", |_| {
            CheckOutput::passed("OK")
        }),
        def("test.two", DoctorArea::System, "Two", |_| {
            CheckOutput::passed("OK")
        }),
    ];
    let mut terminal_counts = Vec::new();
    let batch =
        Runner::new(Duration::from_secs(1), 8).run_with_progress(ctx, plan, |checks, _findings| {
            terminal_counts.push(
                checks
                    .iter()
                    .filter(|check| check.status != CheckStatus::Running)
                    .count(),
            );
        });
    assert_eq!(batch.status, RunStatus::Completed);
    assert_eq!(terminal_counts, vec![1, 2]);
}
