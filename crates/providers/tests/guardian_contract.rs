use std::io::Cursor;

use guardian::marker::{JobId, ProfileMarker, decode_marker, encode_marker};
#[cfg(windows)]
use guardian::protocol::Response;
use guardian::protocol::{
    ChannelNonce, Envelope, InboundGuard, MAX_FRAME_BYTES, ProtocolError, Request, read_frame,
    write_frame,
};
use guardian::{
    DesktopGeneration, ProcessIdentity, ProfileCapability, ProfileGeneration, ProfileIdentity,
};
use kalcode_contracts::agent::ProviderId;
use kalcode_providers::guardian;
use uuid::Uuid;

fn desktop_generation() -> DesktopGeneration {
    DesktopGeneration::from_uuid(Uuid::from_u128(0x0199aaaa_0000_7000_8000_000000000001))
}

fn profile_generation() -> ProfileGeneration {
    ProfileGeneration::from_uuid(Uuid::from_u128(0x0199aaaa_0000_7000_8000_000000000002))
}

fn profile() -> Result<ProfileIdentity, Box<dyn std::error::Error>> {
    Ok(ProfileIdentity::new(
        ProviderId::new(ProviderId::CODEX),
        Uuid::from_u128(0x0199aaaa_0000_7000_8000_000000000003),
        profile_generation(),
    )?)
}

fn process(pid: u32, birth_time_100ns: u64) -> Result<ProcessIdentity, Box<dyn std::error::Error>> {
    Ok(ProcessIdentity::new(pid, birth_time_100ns)?)
}

#[cfg(windows)]
fn initialized_running_recovery_epoch() -> Result<
    (
        tempfile::TempDir,
        guardian::GuardianRuntime,
        std::path::PathBuf,
        DesktopGeneration,
    ),
    Box<dyn std::error::Error>,
> {
    let data_dir = tempfile::tempdir()?;
    let helper = std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian"));
    let runtime = guardian::GuardianRuntime::launch(helper, data_dir.path())?;
    let generation = runtime.desktop_generation();
    let helper_pid = runtime.supervisor().process_identity().pid();
    force_terminate_and_wait(helper_pid)?;
    let recovery_root = data_dir.path().join("provider-guardian-markers");
    Ok((data_dir, runtime, recovery_root, generation))
}

#[cfg(windows)]
fn force_terminate_and_wait(pid: u32) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::windows::process::CommandExt;
    use std::time::{Duration, Instant};

    let system_root = std::env::var_os("SystemRoot").ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "SystemRoot for taskkill")
    })?;
    let taskkill = std::path::Path::new(&system_root)
        .join("System32")
        .join("taskkill.exe");
    let tasklist = std::path::Path::new(&system_root)
        .join("System32")
        .join("tasklist.exe");
    let pid_text = pid.to_string();
    let status = std::process::Command::new(taskkill)
        .args(["/PID", &pid_text, "/F"])
        .creation_flags(0x0800_0000)
        .status()?;
    if !status.success() {
        return Err(std::io::Error::other(format!("taskkill failed: {status}")).into());
    }

    let quoted_pid = format!("\"{pid}\"");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let output = std::process::Command::new(&tasklist)
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .creation_flags(0x0800_0000)
            .output()?;
        if !output.status.success() {
            return Err(
                std::io::Error::other(format!("tasklist failed: {}", output.status)).into(),
            );
        }
        if !String::from_utf8_lossy(&output.stdout).contains(&quoted_pid) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(std::io::Error::other("initial helper did not terminate").into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn nonce() -> ChannelNonce {
    ChannelNonce::from_bytes([0x5a; 16])
}

fn envelope(sequence: u64) -> Envelope<Request> {
    Envelope::new(
        nonce(),
        desktop_generation(),
        sequence,
        Uuid::from_u128(0x0199aaaa_0000_7000_8000_000000000004),
        Request::Health,
    )
}

#[test]
fn frame_codec_bounds_allocation_and_rejects_replay() {
    let expected = envelope(1);
    let mut bytes = Vec::new();
    write_frame(&mut bytes, &expected).expect("encode bounded frame");
    let decoded: Envelope<Request> =
        read_frame(&mut Cursor::new(bytes)).expect("decode bounded frame");
    assert_eq!(decoded, expected);

    let declared = u32::try_from(MAX_FRAME_BYTES + 1)
        .expect("frame limit fits u32")
        .to_le_bytes();
    assert!(matches!(
        read_frame::<_, Envelope<Request>>(&mut Cursor::new(declared)),
        Err(ProtocolError::FrameTooLarge {
            declared,
            maximum: MAX_FRAME_BYTES
        }) if declared == MAX_FRAME_BYTES + 1
    ));

    let mut guard = InboundGuard::new(nonce(), desktop_generation());
    guard.accept(&envelope(1)).expect("first sequence");
    assert!(matches!(
        guard.accept(&envelope(1)),
        Err(ProtocolError::SequenceMismatch {
            expected: 2,
            actual: 1
        })
    ));
    assert!(matches!(
        guard.accept(&envelope(3)),
        Err(ProtocolError::SequenceMismatch {
            expected: 2,
            actual: 3
        })
    ));
}

#[test]
fn protocol_rejects_wrong_version_nonce_and_generation() {
    let mut guard = InboundGuard::new(nonce(), desktop_generation());

    let mut wrong_version = envelope(1);
    wrong_version.protocol_version += 1;
    assert!(matches!(
        guard.accept(&wrong_version),
        Err(ProtocolError::VersionMismatch { .. })
    ));

    let mut wrong_nonce = envelope(1);
    wrong_nonce.nonce = ChannelNonce::from_bytes([0x7c; 16]);
    assert!(matches!(
        guard.accept(&wrong_nonce),
        Err(ProtocolError::AuthenticationFailed)
    ));

    let mut wrong_generation = envelope(1);
    wrong_generation.desktop_generation = DesktopGeneration::from_uuid(Uuid::new_v4());
    assert!(matches!(
        guard.accept(&wrong_generation),
        Err(ProtocolError::DesktopGenerationMismatch)
    ));
}

#[test]
fn marker_decoder_fails_closed_and_transitions_are_object_bound() {
    assert!(decode_marker(b"not-json").is_err());

    let mut marker = ProfileMarker::new(
        Uuid::parse_str("0199aaaa-0000-7000-8000-000000000005").expect("boot"),
        desktop_generation(),
        profile().expect("valid profile"),
        process(100, 101).expect("desktop process"),
        process(200, 201).expect("guardian process"),
    );
    let lease_id = Uuid::parse_str("0199aaaa-0000-7000-8000-000000000006").expect("lease");
    marker
        .acquire(lease_id, ProfileCapability::SharedSession)
        .expect("lease");
    let job =
        JobId::from_uuid(Uuid::parse_str("0199aaaa-0000-7000-8000-000000000007").expect("job"));
    marker
        .prepare_job(
            lease_id,
            profile().expect("valid profile"),
            job,
            "fixture-job".into(),
        )
        .expect("prepared");

    let bytes = encode_marker(&marker).expect("encode marker");
    assert_eq!(decode_marker(&bytes).expect("decode marker"), marker);
    let json = String::from_utf8(bytes).expect("utf8").to_ascii_lowercase();
    for forbidden in [
        "path",
        "argv",
        "command",
        "environment",
        "credential",
        "token",
        "secret",
        "auth_material",
    ] {
        assert!(!json.contains(forbidden), "marker leaked {forbidden}");
    }

    let encoded = encode_marker(&marker).expect("encoded marker");
    let mut value: serde_json::Value = serde_json::from_slice(&encoded).expect("marker value");
    value["schema_version"] = serde_json::json!(2);
    assert!(decode_marker(&serde_json::to_vec(&value).expect("unknown schema JSON")).is_err());
    value["schema_version"] = serde_json::json!(1);
    value["state"] = serde_json::json!("FUTURE_STATE");
    assert!(decode_marker(&serde_json::to_vec(&value).expect("unknown state JSON")).is_err());

    let mut value: serde_json::Value = serde_json::from_slice(&encoded).expect("marker value");
    value["profile"]["provider_id"] = serde_json::json!("../swapped");
    assert!(decode_marker(&serde_json::to_vec(&value).expect("invalid identity JSON")).is_err());

    let mut value: serde_json::Value = serde_json::from_slice(&encoded).expect("marker value");
    value["profile"]["subject_kind"] = serde_json::json!("future_subject");
    assert!(decode_marker(&serde_json::to_vec(&value).expect("unknown subject JSON")).is_err());

    let mut value: serde_json::Value = serde_json::from_slice(&encoded).expect("marker value");
    value["guardian_process"]["birth_time_100ns"] = serde_json::json!(0);
    assert!(decode_marker(&serde_json::to_vec(&value).expect("invalid process JSON")).is_err());
}

#[cfg(windows)]
#[test]
fn windows_unnamed_job_survives_least_rights_handoff_and_proves_process_zero() {
    use std::time::{Duration, Instant};

    use guardian::platform::WindowsJob;

    let owner = WindowsJob::create("handoff-test").expect("create private job");
    let observer = owner
        .duplicate_for_current_process()
        .expect("duplicate least-rights authority");
    let system_root = std::env::var_os("SystemRoot").expect("SystemRoot");
    let powershell = std::path::Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let child = owner
        .spawn_hidden_suspended_then_assign(
            &powershell,
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ],
        )
        .expect("spawn guarded helper");
    assert!(child.identity().pid() > 0);
    assert_eq!(owner.active_processes().expect("active count"), 1);
    drop(owner);
    assert_eq!(observer.active_processes().expect("handoff count"), 1);

    observer.terminate().expect("terminate job");
    let deadline = Instant::now() + Duration::from_secs(10);
    while observer.active_processes().expect("poll count") != 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(observer.active_processes().expect("zero count"), 0);
    child.wait(Duration::from_secs(2)).expect("reap helper");
}

#[cfg(windows)]
#[test]
fn external_guardian_owns_job_until_desktop_channel_loss_drains_it() {
    use std::os::windows::io::AsHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use guardian::platform::WindowsJob;

    let (_data_dir, _epoch_owner, recovery_root, generation) =
        initialized_running_recovery_epoch().expect("initialize running recovery epoch");
    let recovery_identity =
        guardian::platform::recovery_root_identity(&recovery_root).expect("recovery root identity");
    let mut guardian_process = Command::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian"));
    guardian_process
        .arg("--recovery-root")
        .arg(&recovery_root)
        .arg("--recovery-root-id")
        .arg(&recovery_identity)
        .creation_flags(0x0800_0000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut guardian_process = guardian_process.spawn().expect("guardian process");
    let mut input = guardian_process.stdin.take().expect("guardian stdin");
    let mut output = guardian_process.stdout.take().expect("guardian stdout");
    let nonce = ChannelNonce::from_bytes([0x3c; 16]);
    write_frame(
        &mut input,
        &Envelope::new(nonce, generation, 1, Uuid::new_v4(), Request::Health),
    )
    .expect("guardian handshake");
    let response: Envelope<Response> = read_frame(&mut output).expect("handshake response");
    assert_eq!(response.body, Response::Healthy);

    let job = JobId::new();
    let owner = WindowsJob::create("external-channel-loss").expect("create private job");
    let handle = owner
        .duplicate_for_helper(guardian_process.as_handle())
        .expect("duplicate helper authority");
    write_frame(
        &mut input,
        &Envelope::new(
            nonce,
            generation,
            2,
            Uuid::new_v4(),
            Request::HoldJob { job, handle },
        ),
    )
    .expect("transfer job authority");
    let response: Envelope<Response> = read_frame(&mut output).expect("hold response");
    assert_eq!(response.body, Response::Accepted);

    let system_root = std::env::var_os("SystemRoot").expect("SystemRoot");
    let powershell = std::path::Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let provider = owner
        .spawn_hidden_suspended_then_assign(
            &powershell,
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ],
        )
        .expect("guarded provider fixture");
    assert_eq!(owner.active_processes().expect("active provider"), 1);

    drop(owner);
    drop(input);

    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = guardian_process.try_wait().expect("guardian status") {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "guardian did not drain after channel loss"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(status.success(), "guardian cleanup failed: {status}");
    provider
        .wait(Duration::from_secs(2))
        .expect("provider tree ended before guardian exit");
}

#[cfg(windows)]
#[test]
fn external_guardian_drains_when_the_response_channel_breaks() {
    use std::os::windows::io::AsHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use guardian::platform::WindowsJob;

    let (_data_dir, _epoch_owner, recovery_root, generation) =
        initialized_running_recovery_epoch().expect("initialize running recovery epoch");
    let recovery_identity =
        guardian::platform::recovery_root_identity(&recovery_root).expect("recovery root identity");
    let mut helper = Command::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian"));
    helper
        .arg("--recovery-root")
        .arg(&recovery_root)
        .arg("--recovery-root-id")
        .arg(&recovery_identity)
        .creation_flags(0x0800_0000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut helper = helper.spawn().expect("guardian process");
    let mut input = helper.stdin.take().expect("guardian stdin");
    let mut output = helper.stdout.take().expect("guardian stdout");
    let nonce = ChannelNonce::from_bytes([0x4d; 16]);
    write_frame(
        &mut input,
        &Envelope::new(nonce, generation, 1, Uuid::new_v4(), Request::Health),
    )
    .expect("handshake");
    let response: Envelope<Response> = read_frame(&mut output).expect("handshake response");
    assert_eq!(response.body, Response::Healthy);

    let job = JobId::new();
    let owner = WindowsJob::create("external-response-loss").expect("private job owner");
    let handle = owner
        .duplicate_for_helper(helper.as_handle())
        .expect("duplicate helper authority");
    write_frame(
        &mut input,
        &Envelope::new(
            nonce,
            generation,
            2,
            Uuid::new_v4(),
            Request::HoldJob { job, handle },
        ),
    )
    .expect("hold request");
    let response: Envelope<Response> = read_frame(&mut output).expect("hold response");
    assert_eq!(response.body, Response::Accepted);

    let system_root = std::env::var_os("SystemRoot").expect("SystemRoot");
    let powershell = std::path::Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let provider = owner
        .spawn_hidden_suspended_then_assign(
            &powershell,
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ],
        )
        .expect("provider fixture");
    drop(owner);

    // Keep the request side alive and break only responses. The helper's response write must
    // still flow through its unconditional drain path.
    drop(output);
    write_frame(
        &mut input,
        &Envelope::new(nonce, generation, 3, Uuid::new_v4(), Request::Health),
    )
    .expect("request triggering broken response");

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = helper.try_wait().expect("guardian status") {
            assert!(
                !status.success(),
                "broken response is an abnormal helper exit"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "guardian did not exit after response loss"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    provider
        .wait(Duration::from_secs(2))
        .expect("provider ended before helper exit");
}

#[cfg(windows)]
#[test]
fn external_guardian_fails_closed_without_authenticated_epoch_evidence() {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let recovery = tempfile::tempdir().expect("recovery root");
    let recovery_identity = guardian::platform::recovery_root_identity(recovery.path())
        .expect("recovery root identity");
    let mut helper = Command::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian"));
    helper
        .arg("--recovery-root")
        .arg(recovery.path())
        .arg("--recovery-root-id")
        .arg(&recovery_identity)
        .creation_flags(0x0800_0000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut helper = helper.spawn().expect("guardian process");
    let mut input = helper.stdin.take().expect("guardian stdin");
    let mut output = helper.stdout.take().expect("guardian stdout");
    let nonce = ChannelNonce::from_bytes([0x5e; 16]);

    write_frame(
        &mut input,
        &Envelope::new(
            nonce,
            desktop_generation(),
            1,
            Uuid::new_v4(),
            Request::Health,
        ),
    )
    .expect("handshake");
    let response: Envelope<Response> = read_frame(&mut output).expect("handshake response");
    assert_eq!(response.body, Response::Healthy);
    drop(input);

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = helper.try_wait().expect("guardian status") {
            assert!(
                !status.success(),
                "missing authenticated epoch evidence must fail closed"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "guardian did not reject missing epoch evidence"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
