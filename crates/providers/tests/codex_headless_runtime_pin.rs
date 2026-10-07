//! The real managed Codex headless consumer pins one immutable runtime for every turn in a
//! session. The provider is the deterministic local fixture; no credentials, network, prompt, or
//! model call leaves the test process.

#![cfg(any(windows, target_os = "macos"))]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{
    AgentEvent, AgentInput, AgentProvider, AgentSession, SessionConfig,
};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_providers::codex::managed_policy::CloudConfigEligibility;
use kalcode_providers::codex::runtime::{ManagedRuntimeSource, prewarm_managed_runtime};
use kalcode_providers::managed::ManagedProfiles;
use kalcode_providers::{CodexProvider, DetectEnv};
use serde_json::json;

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const GUARDIAN: &str = env!("CARGO_BIN_EXE_kalcode-provider-guardian");
const WAIT: Duration = Duration::from_secs(30);

struct Distribution {
    _root: tempfile::TempDir,
    executable: PathBuf,
    config: PathBuf,
}

impl Distribution {
    fn new(marker: &str, version: &str) -> Self {
        let root = tempfile::tempdir().expect("fake Codex distribution");
        let bin = root.path().join("bin");
        let resources = root.path().join("codex-resources");
        std::fs::create_dir(&bin).expect("distribution bin");
        std::fs::create_dir(&resources).expect("distribution resources");
        let executable = bin.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        std::fs::copy(FAKE, &executable).expect("copy fake Codex");
        let config = resources.join("fake-provider.json");
        Self::write_config(&config, marker, version);
        Self {
            _root: root,
            executable,
            config,
        }
    }

    fn write_config(path: &Path, marker: &str, version: &str) {
        std::fs::write(
            path,
            json!({
                "version": format!("codex-cli {version}"),
                "codexTurnMarker": marker,
                "recordAdjacentArtifacts": false,
            })
            .to_string(),
        )
        .expect("write fake Codex config");
    }

    fn replace(&self, marker: &str, version: &str) {
        let replacement = self.executable.with_extension("replacement");
        std::fs::copy(FAKE, &replacement).expect("copy replacement Codex");
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&replacement)
            .expect("open replacement Codex");
        file.write_all(b"\0KALCODE_REPLACEMENT_RUNTIME")
            .expect("change replacement fingerprint");
        file.flush().expect("flush replacement Codex");

        #[cfg(windows)]
        {
            let deadline = Instant::now() + WAIT;
            loop {
                match std::fs::remove_file(&self.executable) {
                    Ok(()) => break,
                    Err(_) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    Err(error) => panic!("replace active global Codex binary: {error}"),
                }
            }
        }
        #[cfg(not(windows))]
        std::fs::remove_file(&self.executable).expect("remove old global Codex");
        std::fs::rename(&replacement, &self.executable).expect("install replacement Codex");
        Self::write_config(&self.config, marker, version);
    }

    fn env(&self, person_home: &Path) -> DetectEnv {
        let mut vars: Vec<(OsString, OsString)> = vec![
            ("PATH".into(), self.executable.parent().unwrap().into()),
            ("HOME".into(), person_home.into()),
            ("USERPROFILE".into(), person_home.into()),
        ];
        for name in [
            "PATHEXT",
            "SystemRoot",
            "SystemDrive",
            "ComSpec",
            "TEMP",
            "TMP",
            "TMPDIR",
        ] {
            if let Some(value) = std::env::var_os(name) {
                vars.push((name.into(), value));
            }
        }
        DetectEnv {
            vars,
            windows: cfg!(windows),
            probe_timeout: Some(Duration::from_secs(10)),
            system_root: None,
        }
    }
}

fn until(rx: &Receiver<AgentEvent>, done: impl Fn(&AgentEvent) -> bool) -> Vec<AgentEvent> {
    let deadline = Instant::now() + WAIT;
    let mut events = Vec::new();
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|_| panic!("timed out waiting for managed Codex; got {events:#?}"));
        let finished = done(&event);
        events.push(event);
        if finished {
            return events;
        }
    }
}

fn turn(session: &dyn AgentSession, rx: &Receiver<AgentEvent>, text: &str) -> Vec<AgentEvent> {
    session
        .send(AgentInput::Text { text: text.into() })
        .expect("send managed Codex turn");
    until(rx, |event| {
        matches!(event, AgentEvent::TurnCompleted { .. })
    })
}

fn messages(events: &[AgentEvent]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::MessageCompleted { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn session_config(account_id: &str, workspace: &Path) -> SessionConfig {
    SessionConfig {
        thread_id: kalcode_contracts::ids::new_id(),
        workspace_id: kalcode_contracts::ids::new_id(),
        provider_account_id: Some(account_id.into()),
        working_directory: workspace.display().to_string(),
        model: None,
        effort: Some("high".into()),
        permission_mode: PermissionMode::Approve,
        resume_session_id: None,
        secret_ref: None,
        launch_origin: Default::default(),
    }
}

#[test]
fn cold_managed_headless_session_keeps_its_runtime_while_new_sessions_adopt_the_update() {
    let distribution = Distribution::new("old-runtime", "0.161.0");
    let data = tempfile::tempdir().expect("managed provider data");
    let data_root = if cfg!(target_os = "macos") {
        data.path().canonicalize().expect("canonical provider data")
    } else {
        data.path().to_path_buf()
    };
    let person = tempfile::tempdir().expect("synthetic person home");
    let workspace = tempfile::tempdir().expect("workspace");
    let guardian =
        kalcode_providers::guardian::GuardianRuntime::launch(Path::new(GUARDIAN), &data_root)
            .expect("provider guardian");
    let profiles = Arc::new(
        ManagedProfiles::for_data_dir_guarded(
            &data_root,
            guardian.authority(),
            guardian.profile_generation(),
        )
        .expect("guarded managed profiles"),
    );
    let account_id = kalcode_contracts::ids::new_id();
    let provider = CodexProvider::new_managed(
        distribution.env(person.path()),
        Arc::clone(&profiles),
        account_id.clone(),
        CloudConfigEligibility::Ineligible,
    )
    .expect("managed Codex provider");
    let (tx, rx) = mpsc::channel();
    let cold_started = Instant::now();
    let session = provider
        .start_session(
            session_config(&account_id, workspace.path()),
            Box::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .expect("cold managed headless session");

    let first = turn(session.as_ref(), &rx, "first turn");
    assert_eq!(messages(&first), ["old-runtime"]);
    eprintln!(
        "managed Codex cold pin plus first turn: {:?}",
        cold_started.elapsed()
    );
    distribution.replace("new-runtime", "0.162.0");

    let second = turn(session.as_ref(), &rx, "second turn");
    assert_eq!(
        messages(&second),
        ["old-runtime"],
        "an active headless session changed provider bytes between turns"
    );

    // Before the asynchronous watcher validates the replacement, foreground startup stays fast
    // and safe by using the already validated old snapshot.
    let (interim_tx, interim_rx) = mpsc::channel();
    let interim_started = Instant::now();
    let interim_session = provider
        .start_session(
            session_config(&account_id, workspace.path()),
            Box::new(move |event| {
                let _ = interim_tx.send(event);
            }),
        )
        .expect("managed session while updated Codex awaits background validation");
    let interim = turn(
        interim_session.as_ref(),
        &interim_rx,
        "interim session turn",
    );
    assert_eq!(
        messages(&interim),
        ["old-runtime"],
        "foreground launch adopted unvalidated replacement bytes"
    );
    eprintln!(
        "managed Codex last-known-good session plus first turn: {:?}",
        interim_started.elapsed()
    );
    interim_session
        .terminate()
        .expect("terminate last-known-good managed session");
    until(&interim_rx, |event| {
        matches!(event, AgentEvent::Exited { .. })
    });
    drop(interim_session);

    // Model the desktop's asynchronous installation watcher. It validates and snapshots the new
    // bytes without touching the active session or its old runtime lease.
    let spec = kalcode_providers::catalog::codex_spec();
    let source_env = distribution.env(person.path());
    let probe_env = source_env.provider_env(&spec.env_policy);
    let probe_guardian = guardian.probe_guardian().expect("provider probe guardian");
    let runtime_store = profiles.runtime_store();
    let neutral_cwd = profiles
        .compatibility_probe_dir()
        .expect("compatibility probe directory");
    let prewarm_started = Instant::now();
    let warmed = prewarm_managed_runtime(
        Some(&distribution.executable),
        &probe_env,
        &neutral_cwd,
        &runtime_store,
        |label| {
            probe_guardian
                .prepare_job(label)
                .map_err(|error| kalcode_contracts::agent::ProviderError::Start(error.to_string()))
        },
        None,
    )
    .expect("background validation of updated Codex");
    assert_eq!(warmed.source(), ManagedRuntimeSource::ValidatedSnapshot);
    assert_eq!(warmed.version().to_string(), "0.162.0");
    eprintln!(
        "managed Codex background update validation: {:?}",
        prewarm_started.elapsed()
    );

    let (updated_tx, updated_rx) = mpsc::channel();
    let updated_started = Instant::now();
    let updated_session = provider
        .start_session(
            session_config(&account_id, workspace.path()),
            Box::new(move |event| {
                let _ = updated_tx.send(event);
            }),
        )
        .expect("new managed session after global Codex update");
    let updated = turn(
        updated_session.as_ref(),
        &updated_rx,
        "updated session turn",
    );
    assert_eq!(
        messages(&updated),
        ["new-runtime"],
        "a new session did not adopt the validated provider update"
    );
    eprintln!(
        "managed Codex validated update session plus first turn: {:?}",
        updated_started.elapsed()
    );

    updated_session
        .terminate()
        .expect("terminate updated managed session");
    until(&updated_rx, |event| {
        matches!(event, AgentEvent::Exited { .. })
    });
    session.terminate().expect("terminate managed session");
    until(&rx, |event| matches!(event, AgentEvent::Exited { .. }));
    drop(updated_session);
    drop(session);
    drop(provider);
    guardian.seal_and_drain().expect("clean guardian drain");
    drop(warmed);
}
