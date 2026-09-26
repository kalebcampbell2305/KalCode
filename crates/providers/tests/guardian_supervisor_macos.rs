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

type FixtureResult<T> = Result<T, Box<dyn std::error::Error>>;

fn helper() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_kalcode-provider-guardian"))
}

fn runtime() -> FixtureResult<(tempfile::TempDir, GuardianRuntime)> {
    let data = tempfile::tempdir()?;
    let runtime = GuardianRuntime::launch(&helper(), data.path())?;
    Ok((data, runtime))
}

fn probe_lease(
    runtime: &GuardianRuntime,
) -> FixtureResult<kalcode_providers::guardian::GuardianLease> {
    let profile = ProfileIdentity::new(
        ProviderId::new(ProviderId::CODEX),
        Uuid::new_v4(),
        runtime.profile_generation(),
    )?;
    Ok(runtime
        .authority()
        .acquire(profile, ProfileCapability::SharedSession)?)
}

#[test]
fn guarded_probe_activates_then_proves_the_reserved_group_absent() {
    let (_data, runtime) = runtime().expect("macOS guardian runtime");
    let lease = probe_lease(&runtime).expect("guardian lease");
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
    let (_data, runtime) = runtime().expect("macOS guardian runtime");
    let lease = probe_lease(&runtime).expect("guardian lease");
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
    let (_data, runtime) = runtime().expect("macOS guardian runtime");
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

#[test]
fn existing_nonprivate_guardian_root_is_rejected_without_changing_its_mode() {
    use std::os::unix::fs::PermissionsExt;
    let (data, runtime) = runtime().expect("macOS guardian runtime");
    runtime.seal_and_drain().expect("clean initial generation");
    drop(runtime);
    let markers = data.path().join("provider-guardian-markers");
    std::fs::set_permissions(&markers, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(GuardianRuntime::launch(&helper(), data.path()).is_err());
    assert_eq!(
        std::fs::metadata(markers).unwrap().permissions().mode() & 0o777,
        0o777
    );
}

#[test]
fn new_guardian_root_is_private() {
    use std::os::unix::fs::PermissionsExt;
    let (data, runtime) = runtime().expect("macOS guardian runtime");
    let mode = std::fs::metadata(data.path().join("provider-guardian-markers"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o700);
    runtime.seal_and_drain().expect("clean empty generation");
}

// Exercise the actual helper boundary, including death between READY and activation.
// The wire fixture contains no provider credentials and starts only a synthetic shell.
#[allow(unsafe_code)]
fn custodian_loss_drains_reserved_group(activate: bool) -> FixtureResult<()> {
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;
    let data = tempfile::tempdir()?;
    let started = data.path().join("activated");
    let (mut desktop, child_control) = UnixStream::pair()?;
    desktop.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut command = Command::new(helper());
    command
        .args(["--custodian", "--control-fd", "3"])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: pre_exec performs only async-signal-safe descriptor operations and
    // retains the exclusively owned child endpoint until spawn.
    unsafe {
        command.pre_exec(move || {
            let fd = child_control.as_raw_fd();
            if fd == 3 {
                if libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            } else if libc::dup2(fd, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    drop(command);
    let job = Uuid::new_v4();
    let script = "trap '' TERM; (trap '' TERM; while :; do /bin/sleep 1; done) & printf ready > \"$1\"; while :; do /bin/sleep 1; done";
    let send = |stream: &mut UnixStream, value: serde_json::Value| -> FixtureResult<()> {
        let bytes = serde_json::to_vec(&value)?;
        stream.write_all(&(bytes.len() as u32).to_be_bytes())?;
        stream.write_all(&bytes)?;
        Ok(())
    };
    send(
        &mut desktop,
        serde_json::json!({"Launch":{"job":job,"target":{
            "program":b"/bin/sh".to_vec(), "args":[b"-c".to_vec(),script.as_bytes().to_vec(),b"fixture".to_vec(),started.as_os_str().as_encoded_bytes().to_vec()],
            "cwd":null,"env":[],"pty":false
        }}}),
    )?;
    let mut length = [0; 4];
    desktop.read_exact(&mut length)?;
    let mut bytes = vec![0; u32::from_be_bytes(length) as usize];
    desktop.read_exact(&mut bytes)?;
    let ready: serde_json::Value = serde_json::from_slice(&bytes)?;
    assert_eq!(
        ready["Ready"]["custodian_pid"]
            .as_u64()
            .ok_or("missing custodian PID")?,
        u64::from(child.id())
    );
    let anchor = ready["Ready"]["anchor_pid"]
        .as_i64()
        .ok_or("missing anchor PID")? as libc::pid_t;
    if activate {
        send(&mut desktop, serde_json::json!({"Activate":{"job":job}}))?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while !started.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            started.exists(),
            "synthetic root activated before custodian loss"
        );
    }
    desktop.shutdown(std::net::Shutdown::Both)?;
    child.kill()?;
    child.wait()?;
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        // SAFETY: signal 0 is a read-only absence query for the just-created group.
        if unsafe { libc::kill(-anchor, 0) } < 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "reserved group survived custodian death"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    if !activate {
        assert!(!started.exists(), "gated root must never execute");
    }
    Ok(())
}

#[test]
fn killed_custodian_before_activation_cannot_orphan_gated_root_or_anchor() {
    custodian_loss_drains_reserved_group(false).expect("gated group drained after custodian loss");
}

#[test]
fn killed_custodian_after_activation_cannot_orphan_stubborn_group() {
    custodian_loss_drains_reserved_group(true).expect("active group drained after custodian loss");
}
