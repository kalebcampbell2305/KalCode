#![cfg(windows)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::time::Duration;

use kalcode_contracts::agent::ProviderId;
use kalcode_providers::detect::{DetectEnv, DetectionSpec, detect_guarded};
use kalcode_providers::env::EnvPolicy;
use kalcode_providers::guardian::protocol::{
    ChannelNonce, Envelope, Request, Response, read_frame, write_frame,
};
use kalcode_providers::guardian::{
    GuardianError, GuardianRuntime, GuardianSubjectKind, ProfileCapability, ProfileGeneration,
    ProfileIdentity,
};
use kalcode_providers::process::{ProcessSpec, SupervisedChild, run_probe_guarded};
use kalcode_providers::version::Version;
use kalcode_pty::{ProgramSpec, PtySession, TerminalSize};
use uuid::Uuid;

fn profile(
    profile_generation: ProfileGeneration,
) -> Result<ProfileIdentity, Box<dyn std::error::Error>> {
    Ok(ProfileIdentity::new(
        ProviderId::new(ProviderId::CODEX),
        Uuid::from_u128(0x0199aaaa_0000_7000_8000_000000000003),
        profile_generation,
    )?)
}

fn runtime() -> Result<(tempfile::TempDir, GuardianRuntime), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let runtime = GuardianRuntime::launch(
        std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
        temp.path(),
    )?;
    Ok((temp, runtime))
}

#[test]
fn completed_guarded_probes_retire_jobs_and_keep_runtime_state_bounded() {
    let (_temp, runtime) = runtime().expect("production guardian runtime");
    let guardian = runtime.probe_guardian().expect("probe guardian");
    let spec = ProcessSpec {
        program: std::path::PathBuf::from(env!("CARGO_BIN_EXE_kalcode-fake-provider")),
        args: vec![OsString::from("--version")],
        cwd: None,
        env: BTreeMap::new(),
    };
    for _ in 0..64 {
        let job = guardian
            .prepare_job("bounded-probe")
            .expect("prepared probe");
        let output = run_probe_guarded(&spec, job, Duration::from_secs(2), true, 4096)
            .expect("guarded probe");
        assert!(output.status.success());
        assert_eq!(
            runtime
                .supervisor()
                .retained_job_count()
                .expect("retained jobs"),
            0,
            "a completed probe retained desktop/helper job authority"
        );
    }
    runtime.seal_and_drain().expect("bounded runtime drain");
}

#[test]
fn typed_supervisor_seals_prepared_admission_and_returns_clean_only_after_external_drain() {
    let (_temp, runtime) = runtime().expect("production guardian runtime");
    let supervisor = runtime.supervisor();
    let guardian = runtime.authority();
    let profile = profile(runtime.profile_generation()).expect("valid profile");
    let lease = guardian
        .acquire(profile.clone(), ProfileCapability::SharedSession)
        .expect("profile lease");
    let registered = lease
        .prepare_job("provider-session".into())
        .expect("durable PREPARED");
    let system_root = std::env::var_os("SystemRoot").expect("SystemRoot");
    let powershell = std::path::Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let (provider, _lines) = SupervisedChild::spawn_guarded(
        &ProcessSpec {
            program: powershell,
            args: [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ]
            .into_iter()
            .map(OsString::from)
            .collect(),
            cwd: None,
            env: BTreeMap::new(),
        },
        registered,
    )
    .expect("guarded provider fixture");

    guardian.seal().expect("seal all new admission");
    assert!(matches!(
        guardian.acquire(profile, ProfileCapability::SharedSession),
        Err(GuardianError::Sealed)
    ));
    let proof = guardian.drain().expect("typed clean proof");
    assert_eq!(proof.desktop_generation(), runtime.desktop_generation());
    assert!(
        provider
            .wait_timeout(Duration::from_secs(2))
            .expect("provider status")
            .is_some(),
        "provider exited before clean proof"
    );
    assert!(supervisor.is_completed());
}

#[test]
fn conpty_root_is_atomically_admitted_to_the_external_guardian_job() {
    let (_temp, runtime) = runtime().expect("production guardian runtime");
    let guardian = runtime.authority();
    let lease = guardian
        .acquire(
            profile(runtime.profile_generation()).expect("valid profile"),
            ProfileCapability::SharedSession,
        )
        .expect("profile lease");
    let registered = lease.prepare_job("provider-pty".into()).expect("prepared");
    let system_root = std::env::var_os("SystemRoot").expect("SystemRoot");
    let powershell = std::path::Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let spec = ProgramSpec {
        program: powershell,
        args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 60",
        ]
        .into_iter()
        .map(OsString::from)
        .collect(),
        cwd: std::env::temp_dir(),
        env: vec![("SystemRoot".into(), system_root)],
        size: TerminalSize::new(80, 24).expect("terminal size"),
    };
    let baseline = PtySession::spawn_program(spec.clone(), |_| {})
        .expect("the exact ConPTY program spec must launch without guardian admission");
    baseline.kill().expect("stop baseline ConPTY process");

    let pty = PtySession::spawn_program_guarded(spec, Box::new(registered), |_| {})
        .expect("guarded ConPTY provider");

    guardian.seal().expect("seal");
    guardian.drain().expect("external clean proof");
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while pty.exit_info().is_none() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        pty.exit_info().is_some(),
        "PTY exited before clean proof returned"
    );
}

#[test]
fn production_detection_probe_uses_the_internal_guardian_namespace() {
    let (temp, runtime) = runtime().expect("production guardian runtime");
    let bin = temp.path().join("bin");
    std::fs::create_dir(&bin).expect("probe bin");
    let probe = bin.join("probe.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_kalcode-fake-provider"), &probe)
        .expect("fake probe executable");
    let env = DetectEnv {
        vars: vec![
            ("PATH".into(), bin.into_os_string()),
            ("PATHEXT".into(), ".EXE".into()),
        ],
        windows: true,
        probe_timeout: Some(Duration::from_secs(5)),
    };
    let spec = DetectionSpec {
        provider_id: "probe",
        display_name: "Probe",
        executable: "probe",
        install_dirs: &[],
        appdata_dirs: &[],
        local_appdata_dirs: &[],
        minimum_version: Some(Version::new(1, 0, 0)),
        auth: None,
        env_policy: EnvPolicy::BASE,
    };

    let detected = detect_guarded(
        &spec,
        &env,
        &runtime.probe_guardian().expect("probe guardian"),
    );
    assert_eq!(
        detected.detection.state,
        kalcode_contracts::agent::DetectionState::Installed
    );
    let proof = runtime.seal_and_drain().expect("probe generation drain");
    assert!(
        proof
            .profiles()
            .iter()
            .any(|profile| profile.subject_kind() == GuardianSubjectKind::InternalProbe),
        "the production probe must leave a guarded admission record"
    );
}

#[test]
fn sealed_probe_admission_fails_closed_before_the_cli_starts() {
    let (temp, runtime) = runtime().expect("production guardian runtime");
    let bin = temp.path().join("denied-bin");
    std::fs::create_dir(&bin).expect("probe bin");
    let probe = bin.join("denied.exe");
    std::fs::copy(env!("CARGO_BIN_EXE_kalcode-fake-provider"), &probe)
        .expect("fake probe executable");
    let env = DetectEnv {
        vars: vec![
            ("PATH".into(), bin.clone().into_os_string()),
            ("PATHEXT".into(), ".EXE".into()),
        ],
        windows: true,
        probe_timeout: Some(Duration::from_secs(5)),
    };
    let spec = DetectionSpec {
        provider_id: "denied",
        display_name: "Denied",
        executable: "denied",
        install_dirs: &[],
        appdata_dirs: &[],
        local_appdata_dirs: &[],
        minimum_version: Some(Version::new(1, 0, 0)),
        auth: None,
        env_policy: EnvPolicy::BASE,
    };
    let probe_guardian = runtime.probe_guardian().expect("probe guardian");
    let authority = runtime.authority();
    authority.seal().expect("seal before admission");

    let detected = detect_guarded(&spec, &env, &probe_guardian);

    assert_eq!(detected.error_code, Some("probe_guardian_unavailable"));
    assert!(
        !bin.join("runs.log").exists(),
        "the provider executable must not start after guardian admission is sealed"
    );
    authority.drain().expect("empty sealed generation drains");
}

#[test]
fn failed_process_start_remains_owned_as_a_rootless_prepared_job() {
    let (temp, runtime) = runtime().expect("production guardian runtime");
    let profile = profile(runtime.profile_generation()).expect("valid profile");
    let lease = runtime
        .authority()
        .acquire(profile.clone(), ProfileCapability::SharedSession)
        .expect("profile lease");
    let registered = lease
        .prepare_job("failed-provider-start".into())
        .expect("durable prepared job");
    let result = SupervisedChild::spawn_guarded(
        &ProcessSpec {
            program: temp.path().join("missing-provider.exe"),
            args: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
        },
        registered,
    );
    assert!(result.is_err(), "the missing executable must fail to start");

    let proof = runtime
        .seal_and_drain()
        .expect("rootless prepared job drains cleanly");
    assert_eq!(proof.profiles(), &[profile]);
    assert!(runtime.supervisor().is_completed());
}

#[test]
fn surviving_helper_durably_closes_an_interrupted_desktop_epoch() {
    let temp = tempfile::tempdir().expect("data root");
    let helper = std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian"));
    let interrupted = GuardianRuntime::launch(helper, temp.path()).expect("initial runtime");

    // Model loss of the desktop owners without asking the runtime to seal or drain. The helper
    // survives the broken control pipe and is the only authority allowed to make the epoch clean.
    drop(interrupted);

    let replacement = GuardianRuntime::launch(helper, temp.path())
        .expect("replacement after the surviving helper proves cleanup");
    replacement
        .seal_and_drain()
        .expect("replacement generation drains cleanly");
}

#[test]
fn replacement_helper_waits_for_prior_helper_drain_after_desktop_loss() {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let temp = tempfile::tempdir().expect("data root");
    let helper_path = std::path::PathBuf::from(env!("CARGO_BIN_EXE_kalcode-provider-guardian"));
    let initialized = GuardianRuntime::launch(&helper_path, temp.path()).expect("initial runtime");
    let generation = initialized.desktop_generation();
    initialized
        .seal_and_drain()
        .expect("initial clean epoch evidence");
    drop(initialized);
    let recovery_root = temp.path().join("provider-guardian-markers");
    let recovery_identity =
        kalcode_providers::guardian::platform::recovery_root_identity(&recovery_root)
            .expect("recovery root identity");
    let mut prior = Command::new(&helper_path);
    prior
        .arg("--recovery-root")
        .arg(&recovery_root)
        .arg("--recovery-root-id")
        .arg(&recovery_identity)
        .creation_flags(0x0800_0000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut prior = prior.spawn().expect("prior helper");
    let mut input = prior.stdin.take().expect("prior input");
    let mut output = prior.stdout.take().expect("prior output");
    let nonce = ChannelNonce::from_bytes([0x6e; 16]);
    write_frame(
        &mut input,
        &Envelope::new(nonce, generation, 1, Uuid::new_v4(), Request::Health),
    )
    .expect("prior health request");
    let response: Envelope<Response> = read_frame(&mut output).expect("prior health response");
    assert_eq!(response.body, Response::Healthy);

    let data_dir = temp.path().to_path_buf();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let replacement_path = helper_path.clone();
    let replacement = std::thread::spawn(move || {
        started_tx
            .send(GuardianRuntime::launch(&replacement_path, &data_dir))
            .expect("replacement result receiver");
    });
    assert!(
        matches!(
            started_rx.recv_timeout(Duration::from_millis(250)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ),
        "replacement authority became available while the prior helper retained its drain lease"
    );

    drop(input);
    assert!(prior.wait().expect("prior helper exit").success());
    let second = started_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("replacement unblocked after prior drain")
        .expect("replacement guardian runtime");
    replacement.join().expect("replacement launcher");
    second.seal_and_drain().expect("replacement drains");
}

#[test]
fn dead_helper_with_no_admitted_jobs_recovers_without_reboot() {
    let temp = tempfile::tempdir().expect("temp");
    let status = std::process::Command::new(std::env::current_exe().expect("test executable"))
        .args(["--exact", "empty_epoch_owner_crash_fixture", "--nocapture"])
        .env("KALCODE_EMPTY_EPOCH_CRASH_FIXTURE", temp.path())
        .status()
        .expect("fixture subprocess");
    assert!(
        status.success(),
        "fixture must exit after creating crash residue"
    );
    let recovered = GuardianRuntime::launch(
        std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
        temp.path(),
    )
    .expect("both owners exited and durable inventory proves no admitted jobs");
    recovered
        .seal_and_drain()
        .expect("recovered runtime drains");
}

#[test]
fn empty_epoch_owner_crash_fixture() {
    let Some(root) = std::env::var_os("KALCODE_EMPTY_EPOCH_CRASH_FIXTURE") else {
        return;
    };
    let first = GuardianRuntime::launch(
        std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
        std::path::Path::new(&root),
    )
    .expect("fixture runtime");
    let _lease = first
        .authority()
        .acquire(
            profile(first.profile_generation()).expect("valid profile"),
            ProfileCapability::SharedSession,
        )
        .expect("empty profile lease");
    force_terminate_process(first.supervisor().process_identity().pid())
        .expect("terminate guardian fixture");
    assert!(
        GuardianRuntime::launch(
            std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
            std::path::Path::new(&root),
        )
        .is_err(),
        "a live desktop lease must still prevent replacement"
    );
    // Exit without Rust Drop: leave the exact RUNNING epoch and CLEAN empty profile on disk.
    std::process::exit(0);
}

#[test]
fn helper_hard_kill_cannot_release_a_live_desktop_epoch() {
    let (temp, first) = runtime().expect("production guardian runtime");
    let lease = first
        .authority()
        .acquire(
            profile(first.profile_generation()).expect("valid profile"),
            ProfileCapability::SharedSession,
        )
        .expect("first-generation lease");
    let registered = lease
        .prepare_job("hard-kill-provider".into())
        .expect("first-generation prepared job");
    let (provider, _lines) = SupervisedChild::spawn_guarded(
        &ProcessSpec {
            program: std::path::PathBuf::from(env!("CARGO_BIN_EXE_kalcode-fake-provider")),
            args: vec![OsString::from("--fake-grandchild")],
            cwd: None,
            env: BTreeMap::new(),
        },
        registered,
    )
    .expect("first-generation provider");
    assert!(
        provider
            .wait_timeout(Duration::from_millis(100))
            .expect("initial provider status")
            .is_none(),
        "the adversarial provider fixture must be live before the helper is killed"
    );

    force_terminate_process(first.supervisor().process_identity().pid())
        .expect("terminate guardian fixture");
    assert!(
        provider
            .wait_timeout(Duration::from_millis(250))
            .expect("provider status after helper kill")
            .is_none(),
        "the desktop's retained Job Object handle must keep the provider owned after helper loss"
    );
    assert!(
        GuardianRuntime::launch(
            std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
            temp.path(),
        )
        .is_err(),
        "helper abandonment must not admit a replacement while the desktop epoch remains live"
    );

    provider
        .terminate(Duration::ZERO)
        .expect("terminate retained provider");
    drop(provider);
    drop(lease);
    drop(first);
    assert!(
        GuardianRuntime::launch(
            std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
            temp.path(),
        )
        .is_err(),
        "an unclean helper+desktop generation must remain blocked on the same Windows boot"
    );
}

fn force_terminate_process(pid: u32) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;

    let system_root = std::env::var_os("SystemRoot").ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "SystemRoot for taskkill")
    })?;
    let taskkill = std::path::Path::new(&system_root)
        .join("System32")
        .join("taskkill.exe");
    let pid = pid.to_string();
    let status = std::process::Command::new(taskkill)
        .args(["/PID", &pid, "/F"])
        .creation_flags(0x0800_0000)
        .status()?;
    assert!(status.success(), "taskkill failed: {status}");
    Ok(())
}
