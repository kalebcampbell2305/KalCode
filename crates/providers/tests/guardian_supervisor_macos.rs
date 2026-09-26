#![cfg(target_os = "macos")]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kalcode_contracts::agent::ProviderId;
use kalcode_providers::guardian::{GuardianRuntime, ProfileCapability, ProfileIdentity};
use kalcode_providers::process::{ProcessError, ProcessSpec, run_probe_guarded};
use kalcode_pty::{ProgramSpec, PtySession, TerminalSize};
use uuid::Uuid;

fn helper() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kalcode-provider-guardian"))
}

fn runtime() -> (tempfile::TempDir, GuardianRuntime) {
    let data = tempfile::tempdir().expect("temporary guardian data root");
    let runtime = GuardianRuntime::launch(&helper(), data.path()).expect("macOS guardian runtime");
    (data, runtime)
}

fn probe_lease(runtime: &GuardianRuntime) -> kalcode_providers::guardian::GuardianLease {
    let profile = ProfileIdentity::new(
        ProviderId::new(ProviderId::CODEX),
        Uuid::new_v4(),
        runtime.profile_generation(),
    )
    .expect("profile identity");
    runtime
        .authority()
        .acquire(profile, ProfileCapability::SharedSession)
        .expect("guardian lease")
}

#[test]
fn guarded_probe_activates_then_proves_the_reserved_group_absent() {
    let (_data, runtime) = runtime();
    let lease = probe_lease(&runtime);
    let admission = lease
        .prepare_job("mac-natural-exit".into())
        .expect("prepared admission");
    let spec = ProcessSpec {
        program: PathBuf::from("/bin/sh"),
        args: vec![OsString::from("-c"), OsString::from("printf mac-custody")],
        cwd: None,
        env: BTreeMap::from([(OsString::from("PATH"), OsString::from("/usr/bin:/bin"))]),
    };
    let output = run_probe_guarded(&spec, admission, Duration::from_secs(5), true, 1024)
        .expect("guarded probe");
    assert!(output.status.success());
    assert_eq!(output.stdout, "mac-custody");
    assert_eq!(runtime.supervisor().retained_job_count().unwrap(), 0);
    drop(lease);
    runtime.seal_and_drain().expect("clean generation proof");
}

#[test]
fn guarded_timeout_reaps_stubborn_root_before_the_anchor_and_group() {
    let (_data, runtime) = runtime();
    let lease = probe_lease(&runtime);
    let admission = lease
        .prepare_job("mac-stubborn-tree".into())
        .expect("prepared admission");
    let spec = ProcessSpec {
        program: PathBuf::from("/bin/sh"),
        args: vec![
            OsString::from("-c"),
            OsString::from(
                "trap '' TERM; (trap '' TERM; while :; do sleep 1; done) & while :; do sleep 1; done",
            ),
        ],
        cwd: None,
        env: BTreeMap::from([(OsString::from("PATH"), OsString::from("/usr/bin:/bin"))]),
    };
    let error = run_probe_guarded(&spec, admission, Duration::from_millis(150), false, 0)
        .expect_err("probe must time out");
    assert!(matches!(error, ProcessError::TimedOut(_)));
    assert_eq!(runtime.supervisor().retained_job_count().unwrap(), 0);
    drop(lease);
    runtime.seal_and_drain().expect("clean generation proof");
}

#[test]
fn guarded_pty_uses_the_provider_root_pid_and_completes_custody() {
    let (_data, runtime) = runtime();
    let guardian = runtime.terminal_guardian().expect("terminal guardian");
    let admission = guardian.prepare("mac-pty").expect("PTY admission");
    let output = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&output);
    let (exited_tx, exited_rx) = std::sync::mpsc::channel();
    let session = PtySession::spawn_program_guarded(
        ProgramSpec {
            program: PathBuf::from("/bin/sh"),
            args: vec![OsString::from("-c"), OsString::from("printf mac-pty")],
            cwd: PathBuf::from("/tmp"),
            env: vec![(OsString::from("PATH"), OsString::from("/usr/bin:/bin"))],
            size: TerminalSize::new(80, 24).expect("terminal size"),
        },
        admission,
        move |exit| {
            exited_tx.send(exit).expect("exit receiver");
        },
    )
    .expect("custodied PTY");
    assert!(session.pid().is_some_and(|pid| pid > 0));
    session.attach(move |bytes| {
        captured
            .lock()
            .expect("output lock")
            .extend_from_slice(bytes);
        true
    });
    let exit = exited_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("PTY exit");
    assert!(exit.success);
    assert!(String::from_utf8_lossy(&output.lock().expect("output lock")).contains("mac-pty"));
    assert_eq!(runtime.supervisor().retained_job_count().unwrap(), 0);
    drop(session);
    drop(guardian);
    runtime.seal_and_drain().expect("clean generation proof");
}
