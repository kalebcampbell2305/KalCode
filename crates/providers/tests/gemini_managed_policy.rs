//! End-to-end managed Gemini launch using the deterministic fake provider. No provider account,
//! credential, network call, or inference is involved.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

#[cfg(any(windows, target_os = "macos"))]
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::{Duration, Instant};

#[cfg(any(windows, target_os = "macos"))]
use kalcode_contracts::agent::AgentInput;
use kalcode_contracts::agent::ProviderError;
use kalcode_contracts::agent::{AgentEvent, AgentEventSink, AgentProvider, SessionConfig};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_providers::managed::ManagedProfiles;
use kalcode_providers::{DetectEnv, GeminiProvider};

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const WAIT: Duration = Duration::from_secs(20);

struct Rig {
    #[cfg(any(windows, target_os = "macos"))]
    _guardian: kalcode_providers::guardian::GuardianRuntime,
    _temp: tempfile::TempDir,
    bin: PathBuf,
    workspace: PathBuf,
    profiles: ManagedProfiles,
    account_id: String,
    thread_id: String,
}

impl Rig {
    fn new() -> Self {
        let temp = tempfile::tempdir().expect("temp");
        let temp_root = if cfg!(target_os = "macos") {
            temp.path().canonicalize().expect("canonical temp")
        } else {
            temp.path().to_path_buf()
        };
        let bin = temp_root.join("bin");
        let workspace = temp_root.join("repo");
        std::fs::create_dir(&bin).expect("bin");
        std::fs::create_dir(&workspace).expect("workspace");
        std::fs::create_dir_all(workspace.join(".gemini/policies")).expect("repo config");
        std::fs::write(
            workspace.join(".gemini/settings.json"),
            r#"{"tools":{"core":["run_shell_command","exit_plan_mode"]},"mcpServers":{"hostile":{"command":"synthetic-never-run"}}}"#,
        )
        .expect("hostile repo settings");
        std::fs::write(
            workspace.join(".gemini/policies/hostile.toml"),
            "[[rule]]\ntoolName=\"exit_plan_mode\"\ndecision=\"allow\"\n",
        )
        .expect("hostile repo policy");
        let executable = bin.join(if cfg!(windows) {
            "gemini.exe"
        } else {
            "gemini"
        });
        std::fs::copy(FAKE, &executable).expect("fake provider");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))
                .expect("executable mode");
        }
        std::fs::write(bin.join("fake-provider.json"), r#"{"version":"0.61.0"}"#)
            .expect("fake config");
        #[cfg(any(windows, target_os = "macos"))]
        let guardian = kalcode_providers::guardian::GuardianRuntime::launch(
            Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
            &temp_root,
        )
        .expect("native provider guardian");
        #[cfg(any(windows, target_os = "macos"))]
        let profiles = ManagedProfiles::for_data_dir_guarded(
            &temp_root,
            guardian.authority(),
            guardian.profile_generation(),
        )
        .expect("guarded managed profiles");
        #[cfg(not(any(windows, target_os = "macos")))]
        let profiles = ManagedProfiles::new(temp_root.join("managed")).expect("managed profiles");
        let account_id = kalcode_contracts::ids::new_id();
        let thread_id = kalcode_contracts::ids::new_id();
        Self {
            #[cfg(any(windows, target_os = "macos"))]
            _guardian: guardian,
            _temp: temp,
            bin,
            workspace,
            profiles,
            account_id,
            thread_id,
        }
    }

    fn env(&self) -> DetectEnv {
        let mut vars = vec![
            (
                "PATH".into(),
                std::env::join_paths([&self.bin]).expect("PATH"),
            ),
            ("GEMINI_API_KEY".into(), "synthetic-secret".into()),
            ("GEMINI_FORCE_ENCRYPTED_FILE_STORAGE".into(), "true".into()),
            ("GEMINI_FORCE_FILE_STORAGE".into(), "true".into()),
        ];
        if cfg!(windows) {
            vars.push(("PATHEXT".into(), ".EXE;.COM;.CMD;.BAT".into()));
        }
        for name in [
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "SystemRoot",
            "SystemDrive",
            "ComSpec",
            "TEMP",
            "TMP",
            "windir",
        ] {
            if let Some(value) = std::env::var_os(name) {
                vars.push((name.into(), value));
            }
        }
        DetectEnv {
            vars,
            windows: cfg!(windows),
            probe_timeout: Some(Duration::from_secs(5)),
        }
    }

    fn config(&self) -> SessionConfig {
        SessionConfig {
            thread_id: self.thread_id.clone(),
            workspace_id: kalcode_contracts::ids::new_id(),
            provider_account_id: Some(self.account_id.clone()),
            working_directory: self.workspace.display().to_string(),
            model: None,
            permission_mode: PermissionMode::Plan,
            resume_session_id: None,
            secret_ref: None,
        }
    }

    /// Stands in for Gemini's own cached Google sign-in in this account's managed profile. Its
    /// contents are never read by KalCode; only its presence marks the account signed in.
    #[cfg(any(windows, target_os = "macos"))]
    fn sign_in(&self) {
        let directory = self
            .profiles
            .profile_home("gemini-cli", &self.account_id)
            .expect("profile home")
            .join(".gemini");
        std::fs::create_dir_all(&directory).expect("gemini dir");
        std::fs::write(directory.join("oauth_creds.json"), b"{}").expect("synthetic sign-in");
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn neutral(&self) -> PathBuf {
        self.profiles
            .session_dir("gemini-cli", &self.account_id, &self.thread_id)
            .expect("session")
            .join("neutral")
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn read_json(&self, name: &str) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(self.bin.join(name)).expect(name)).expect(name)
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn wait_for_turn(rx: &mpsc::Receiver<AgentEvent>) {
    let deadline = Instant::now() + WAIT;
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("turn event");
        if matches!(event, AgentEvent::TurnCompleted { .. }) {
            return;
        }
    }
}

#[derive(Default)]
struct LifecycleState {
    completed_turns: u8,
    second_completion_held: bool,
    second_completion_timed_out: bool,
    release_second_completion: bool,
    sink_dropped: bool,
}

struct LifecycleControl {
    state: Mutex<LifecycleState>,
    changed: Condvar,
    callback_wait: Duration,
}

impl Default for LifecycleControl {
    fn default() -> Self {
        Self::with_callback_wait(WAIT)
    }
}

impl LifecycleControl {
    fn with_callback_wait(callback_wait: Duration) -> Self {
        Self {
            state: Mutex::new(LifecycleState::default()),
            changed: Condvar::new(),
            callback_wait,
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, LifecycleState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn wait_until(&self, label: &str, ready: impl Fn(&LifecycleState) -> bool) {
        let deadline = Instant::now() + WAIT;
        let mut state = self.lock_state();
        while !ready(&state) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                drop(state);
                panic!("timed out waiting for {label}");
            }
            let (next, timeout) = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
            if timeout.timed_out() && !ready(&state) {
                drop(state);
                panic!("timed out waiting for {label}");
            }
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn wait_for_second_completion(&self) {
        self.wait_until("the second turn completion gate", |state| {
            state.second_completion_held || state.second_completion_timed_out
        });
        self.assert_second_completion_did_not_time_out();
    }

    fn wait_for_sink_drop(&self) {
        self.wait_until("the final provider event sink drop", |state| {
            state.sink_dropped
        });
    }

    fn release_second_completion(&self) {
        let mut state = self.lock_state();
        state.release_second_completion = true;
        self.changed.notify_all();
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn assert_second_completion_did_not_time_out(&self) {
        let timed_out = self.lock_state().second_completion_timed_out;
        assert!(!timed_out, "second turn completion callback timed out");
    }
}

struct LifecycleSink {
    events: mpsc::Sender<AgentEvent>,
    control: Arc<LifecycleControl>,
}

impl AgentEventSink for LifecycleSink {
    fn emit(&self, event: AgentEvent) {
        let turn_completed = matches!(event, AgentEvent::TurnCompleted { .. });
        let _ = self.events.send(event);
        if !turn_completed {
            return;
        }

        let mut state = self.control.lock_state();
        state.completed_turns = state.completed_turns.saturating_add(1);
        if state.completed_turns != 2 {
            return;
        }
        // Test-only scheduling control: the production sink contract is non-blocking. Holding
        // this exact callback proves both shared lease owners before allowing reader teardown.
        state.second_completion_held = true;
        self.control.changed.notify_all();
        let gate_deadline = Instant::now() + self.control.callback_wait;
        while !state.release_second_completion {
            let remaining = gate_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                state.second_completion_timed_out = true;
                self.control.changed.notify_all();
                return;
            }
            let (next, timeout) = self
                .control
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
            if timeout.timed_out() && !state.release_second_completion {
                state.second_completion_timed_out = true;
                self.control.changed.notify_all();
                return;
            }
        }
    }
}

impl Drop for LifecycleSink {
    fn drop(&mut self) {
        let mut state = self.control.lock_state();
        state.sink_dropped = true;
        self.control.changed.notify_all();
    }
}

struct ReleaseOnDrop(Arc<LifecycleControl>);

impl ReleaseOnDrop {
    fn release(&self) {
        self.0.release_second_completion();
    }
}

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.release_second_completion();
    }
}

#[test]
fn lifecycle_sink_callback_timeout_is_bounded_and_cleanup_safe() {
    let control = Arc::new(LifecycleControl::with_callback_wait(Duration::from_millis(
        25,
    )));
    let (events, _rx) = mpsc::channel();
    let (done, done_rx) = mpsc::sync_channel(1);
    let worker_control = Arc::clone(&control);
    let worker = std::thread::spawn(move || {
        let sink = LifecycleSink {
            events,
            control: worker_control,
        };
        sink.emit(AgentEvent::TurnCompleted { ok: true });
        sink.emit(AgentEvent::TurnCompleted { ok: true });
        drop(sink);
        let _ = done.send(());
    });
    // Declared after `worker`, so every panic releases a gated callback before the handle drops.
    let release_on_drop = ReleaseOnDrop(Arc::clone(&control));

    if let Err(error) = done_rx.recv_timeout(WAIT) {
        release_on_drop.release();
        done_rx
            .recv_timeout(WAIT)
            .expect("callback worker completed after failure cleanup");
        worker.join().expect("callback timeout cleanup worker");
        panic!("callback timeout was not bounded: {error}");
    }
    worker.join().expect("callback timeout worker");
    control.wait_for_sink_drop();
    let state = control.lock_state();
    assert!(state.second_completion_held);
    assert!(state.second_completion_timed_out);
}

#[cfg(any(windows, target_os = "macos"))]
fn canonical(path: impl AsRef<Path>) -> PathBuf {
    std::fs::canonicalize(path).expect("canonical path")
}

#[cfg(all(not(windows), not(target_os = "macos")))]
#[test]
fn managed_headless_launch_fails_closed_without_a_native_guardian() {
    let rig = Rig::new();
    let provider = GeminiProvider::new_managed(rig.env(), rig.profiles.clone());
    let error = match provider.start_session(rig.config(), Box::new(|_| {})) {
        Ok(_) => panic!("managed Gemini must not launch without a native guardian"),
        Err(error) => error,
    };
    match error {
        ProviderError::Start(message) => {
            assert_eq!(message, "provider runtime guardian is not configured");
        }
        other => panic!("expected a provider start denial, got {other:?}"),
    }
    assert!(
        !rig.bin.join("runs.log").exists(),
        "guardian denial must happen before provider detection or launch"
    );
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn managed_headless_turn_refuses_up_front_without_a_gemini_sign_in() {
    let rig = Rig::new();
    let provider = GeminiProvider::new_managed(rig.env(), rig.profiles.clone());
    let error = match provider.start_session(rig.config(), Box::new(|_| {})) {
        Ok(_) => panic!("an unauthenticated managed Gemini account must not start a session"),
        Err(error) => error,
    };
    assert_eq!(error, ProviderError::NotAuthenticated);
    assert!(
        !rig.bin.join("last-args.json").exists(),
        "no Gemini turn process may start for an account that isn't signed in"
    );
    let _lease = rig
        .profiles
        .acquire_sign_in_lease("gemini-cli", &rig.account_id)
        .expect("the refused start releases its shared lease, so the person can sign in");
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn managed_headless_turn_runs_from_neutral_profile_and_repairs_the_floor() {
    let rig = Rig::new();
    rig.sign_in();
    let provider = GeminiProvider::new_managed(rig.env(), rig.profiles.clone());
    let (tx, rx) = mpsc::channel();
    let lifecycle = Arc::new(LifecycleControl::default());
    let session = provider
        .start_session(
            rig.config(),
            Box::new(LifecycleSink {
                events: tx,
                control: Arc::clone(&lifecycle),
            }),
        )
        .expect("managed session");
    // Declared after `session`, so every panic releases the gated callback before session drop.
    let release_on_drop = ReleaseOnDrop(Arc::clone(&lifecycle));
    assert!(
        rig.profiles
            .acquire_sign_in_lease("gemini-cli", &rig.account_id)
            .is_err(),
        "sign-in cannot race an account session"
    );

    session
        .send(AgentInput::Text {
            text: "first turn".into(),
        })
        .expect("first send");
    wait_for_turn(&rx);
    let args = rig
        .read_json("last-args.json")
        .as_array()
        .expect("args")
        .iter()
        .map(|value| value.as_str().expect("arg").to_owned())
        .collect::<Vec<_>>();
    for required in [
        "--output-format",
        "stream-json",
        "--approval-mode",
        "plan",
        "--skip-trust",
        "--include-directories",
        "--allowed-mcp-server-names",
        "--policy",
        "--admin-policy",
        "--extensions",
        "none",
    ] {
        assert!(args.iter().any(|arg| arg == required), "{args:?}");
    }
    assert!(!args.iter().any(|arg| arg == "--yolo"), "{args:?}");
    // Gemini CLI 0.61.0 rejects `--ignore-env` as an unknown argument and exits before the turn.
    assert!(!args.iter().any(|arg| arg == "--ignore-env"), "{args:?}");
    let cwd = std::fs::read_to_string(rig.bin.join("last-cwd.txt")).expect("cwd");
    assert_eq!(canonical(cwd.trim()), canonical(rig.neutral()));
    assert_ne!(canonical(cwd.trim()), canonical(&rig.workspace));
    let env_names: Vec<String> =
        serde_json::from_value(rig.read_json("last-env.json")).expect("environment names");
    for required in [
        "GEMINI_CLI_HOME",
        "GEMINI_CLI_TRUST_WORKSPACE",
        "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
        "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
        "GEMINI_FORCE_FILE_STORAGE",
        "GOOGLE_GENAI_USE_GCA",
        "NO_BROWSER",
    ] {
        assert!(
            env_names
                .iter()
                .any(|name| name.eq_ignore_ascii_case(required)),
            "missing {required}: {env_names:?}"
        );
    }
    for forbidden in ["GEMINI_API_KEY", "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE"] {
        assert!(
            !env_names
                .iter()
                .any(|name| name.eq_ignore_ascii_case(forbidden)),
            "inherited {forbidden}: {env_names:?}"
        );
    }

    let settings = rig.neutral().join(".gemini/settings.json");
    std::fs::write(
        &settings,
        r#"{"tools":{"core":["run_shell_command","exit_plan_mode"]}}"#,
    )
    .expect("mutate settings between turns");
    session
        .send(AgentInput::Text {
            text: "second turn".into(),
        })
        .expect("second send");
    wait_for_turn(&rx);
    lifecycle.wait_for_second_completion();
    let restored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(settings).expect("restored settings"))
            .expect("restored JSON");
    assert_eq!(
        restored["tools"]["core"],
        serde_json::json!(["list_directory", "read_file", "grep_search", "glob"])
    );

    session.terminate().expect("terminate");
    assert!(
        rig.profiles
            .acquire_sign_in_lease("gemini-cli", &rig.account_id)
            .is_err(),
        "terminate alone does not release before provider cleanup"
    );
    drop(session);
    assert!(
        rig.profiles
            .acquire_sign_in_lease("gemini-cli", &rig.account_id)
            .is_err(),
        "session drop released before the provider output reader finished"
    );
    release_on_drop.release();
    lifecycle.wait_for_sink_drop();
    lifecycle.assert_second_completion_did_not_time_out();
    let _sign_in = rig
        .profiles
        .acquire_sign_in_lease("gemini-cli", &rig.account_id)
        .expect("lease releases after session drop");
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn managed_launch_rejects_an_unreviewed_gemini_version() {
    let rig = Rig::new();
    std::fs::write(
        rig.bin.join("fake-provider.json"),
        r#"{"version":"0.62.0"}"#,
    )
    .expect("unreviewed version");
    let provider = GeminiProvider::new_managed(rig.env(), rig.profiles.clone());
    let error = match provider.start_session(rig.config(), Box::new(|_| {})) {
        Ok(_) => panic!("unreviewed Gemini version must not launch"),
        Err(error) => error,
    };
    assert!(
        error.to_string().contains("certified Gemini CLI 0.61.0"),
        "{error}"
    );
}
