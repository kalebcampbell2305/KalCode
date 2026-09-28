//! Codex and Gemini CLI panes end to end, without a real provider: the fake provider's
//! interactive Codex / Gemini CLI modes run in a real PTY. Codex's `notify` program is the real
//! `kalcode-hook` helper code (the fake stands in for the helper binary) talking to the real
//! bridge; its approval prompt raises a real OSC 9 sequence in the PTY stream. No AI quota is
//! used.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::ffi::OsString;
#[cfg(any(windows, target_os = "macos"))]
use std::sync::Condvar;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{
    AgentEvent, AgentProvider, AgentSession, ProviderError, SessionConfig,
};
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::threads::ThreadStatus;
use kalcode_hook_bridge::Endpoint;
use kalcode_hook_bridge::server::{BridgeServer, ServerConfig};
use kalcode_providers::DetectEnv;
use kalcode_providers::codex::managed_policy::CloudConfigEligibility;
use kalcode_providers::interactive::cli_pane::{InteractiveCliProvider, PaneCli};
use kalcode_providers::interactive::provider::{InteractiveConfig, PaneRegistry, RuntimeRouter};
use kalcode_providers::interactive::session::SessionLimits;
use kalcode_providers::interactive::{DecisionRouting, HookChannelState};
use kalcode_providers::managed::ManagedProfiles;
use serde_json::Value;

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const WAIT: Duration = Duration::from_secs(30);

struct Rig {
    #[cfg(any(windows, target_os = "macos"))]
    _guardian: Option<kalcode_providers::guardian::GuardianRuntime>,
    dir: tempfile::TempDir,
    work: tempfile::TempDir,
    _sessions: tempfile::TempDir,
    panes: Arc<PaneRegistry>,
    provider: Arc<InteractiveCliProvider>,
    profiles: Option<ManagedProfiles>,
    resolved_accounts: Arc<Mutex<Vec<String>>>,
}

impl Rig {
    fn new(cli: PaneCli) -> Self {
        Self::build(cli, false, None)
    }

    fn new_managed(cli: PaneCli, eligibility: Option<CloudConfigEligibility>) -> Self {
        Self::build(cli, true, eligibility)
    }

    fn build(cli: PaneCli, managed: bool, eligibility: Option<CloudConfigEligibility>) -> Self {
        let dir = tempfile::tempdir().expect("dir");
        let dir_root = if cfg!(target_os = "macos") {
            dir.path().canonicalize().expect("canonical dir")
        } else {
            dir.path().to_path_buf()
        };
        let base = match cli {
            PaneCli::Codex => "codex",
            PaneCli::Gemini => "gemini",
        };
        let name = if cfg!(windows) {
            format!("{base}.exe")
        } else {
            base.to_owned()
        };
        std::fs::copy(FAKE, dir_root.join(name)).expect("copy fake");
        let fake_config = if managed && cli == PaneCli::Gemini {
            r#"{"version":"0.61.0"}"#
        } else {
            "{}"
        };
        std::fs::write(dir_root.join("fake-provider.json"), fake_config).expect("config");
        let sessions = tempfile::tempdir().expect("sessions");
        let bridge = (cli == PaneCli::Codex).then(|| {
            let endpoint = Endpoint::generate(Some(sessions.path())).expect("endpoint");
            Arc::new(BridgeServer::start(ServerConfig::new(endpoint)).expect("bridge"))
        });
        let panes = Arc::new(PaneRegistry::new());
        #[cfg(any(windows, target_os = "macos"))]
        let guardian = managed.then(|| {
            kalcode_providers::guardian::GuardianRuntime::launch(
                std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
                &dir_root,
            )
            .expect("native provider guardian")
        });
        let mut vars: Vec<(OsString, OsString)> = vec![
            ("PATH".into(), dir_root.clone().into_os_string()),
            ("ANTHROPIC_API_KEY".into(), "test-anthropic-value".into()),
            ("OPENAI_API_KEY".into(), "test-openai-value".into()),
            ("GEMINI_API_KEY".into(), "test-gemini-value".into()),
            ("KALCODE_DATA_DIR".into(), "/should/not/pass".into()),
        ];
        for name in ["SystemRoot", "TEMP", "TMP", "TMPDIR"] {
            if let Some(value) = std::env::var_os(name) {
                vars.push((name.into(), value));
            }
        }
        #[cfg(any(windows, target_os = "macos"))]
        let profiles = guardian.as_ref().map(|guardian| {
            ManagedProfiles::for_data_dir_guarded(
                &dir_root,
                guardian.authority(),
                guardian.profile_generation(),
            )
            .expect("guarded profiles")
        });
        #[cfg(not(any(windows, target_os = "macos")))]
        let profiles = managed
            .then(|| ManagedProfiles::new(dir_root.join("managed")).expect("managed profiles"));
        let resolved_accounts = Arc::new(Mutex::new(Vec::new()));
        let mut provider = InteractiveCliProvider::new(
            cli,
            DetectEnv {
                vars,
                windows: cfg!(windows),
                probe_timeout: Some(Duration::from_secs(10)),
            },
            bridge,
            InteractiveConfig {
                hook_program: FAKE.into(),
                hook_prefix_args: vec!["hook".into()],
                sessions_dir: sessions.path().to_path_buf(),
                routing: DecisionRouting::Engine,
                limits: SessionLimits::default(),
            },
            panes.clone(),
        );
        if let Some(profiles) = &profiles {
            provider = provider.with_managed_profiles(profiles.clone());
        }
        if let Some(eligibility) = eligibility {
            let calls = resolved_accounts.clone();
            provider = provider.with_codex_cloud_config_resolver(move |account_id| {
                calls.lock().unwrap().push(account_id.to_owned());
                Ok(eligibility)
            });
        }
        let provider = Arc::new(provider);
        Self {
            #[cfg(any(windows, target_os = "macos"))]
            _guardian: guardian,
            dir,
            work: tempfile::tempdir().expect("work"),
            _sessions: sessions,
            panes,
            provider,
            profiles,
            resolved_accounts,
        }
    }

    fn start(&self, mode: PermissionMode) -> Pane {
        self.start_with_account(mode, None).expect("start pane")
    }

    fn config(&self, mode: PermissionMode, account_id: Option<String>) -> SessionConfig {
        SessionConfig {
            thread_id: new_id(),
            workspace_id: new_id(),
            provider_account_id: account_id,
            working_directory: self.work.path().to_string_lossy().into_owned(),
            model: None,
            permission_mode: mode,
            resume_session_id: None,
            secret_ref: None,
        }
    }

    fn start_with_account(
        &self,
        mode: PermissionMode,
        account_id: Option<String>,
    ) -> Result<Pane, ProviderError> {
        let config = self.config(mode, account_id);
        let thread_id = config.thread_id.clone();
        let (tx, rx) = mpsc::channel();
        let session = self.provider.start_session(
            config,
            Box::new(move |e: AgentEvent| {
                let _ = tx.send(e);
            }),
        )?;
        let output = Arc::new(Mutex::new(Vec::new()));
        let sink = output.clone();
        let panes = self.panes.clone();
        let responder = thread_id.clone();
        self.panes
            .attach(&thread_id, move |chunk| {
                sink.lock().unwrap().extend_from_slice(chunk);
                for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
                    let _ = panes.write(&responder, b"\x1b[1;1R");
                }
                true
            })
            .ok_or_else(|| ProviderError::Start("the pane disappeared before attach".into()))?;
        let pane = Pane {
            thread_id,
            _session: session,
            events: rx,
            output,
            panes: self.panes.clone(),
        };
        pane.wait_for_text("KalCode fake provider (interactive");
        Ok(pane)
    }

    fn args(&self) -> Vec<String> {
        let text = std::fs::read_to_string(self.dir.path().join("last-args.json")).expect("args");
        let value: Value = serde_json::from_str(&text).expect("json");
        serde_json::from_value(value).expect("strings")
    }

    fn env_names(&self) -> Vec<String> {
        let text = std::fs::read_to_string(self.dir.path().join("last-env.json")).expect("env");
        serde_json::from_str(&text).expect("json")
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn launch_cwd(&self) -> std::path::PathBuf {
        std::fs::read_to_string(self.dir.path().join("last-cwd.txt"))
            .map(std::path::PathBuf::from)
            .expect("cwd")
    }

    fn assert_no_provider_process_started(&self) {
        assert!(
            !self.dir.path().join("runs.log").exists(),
            "provider detection or launch ran before the managed-account guard"
        );
    }
}

struct Pane {
    thread_id: String,
    _session: Box<dyn AgentSession>,
    events: Receiver<AgentEvent>,
    output: Arc<Mutex<Vec<u8>>>,
    panes: Arc<PaneRegistry>,
}

impl Pane {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().unwrap()).into_owned()
    }

    fn wait_for_text(&self, needle: &str) {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if self.text().contains(needle) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("{needle:?} never appeared; pane: {:?}", self.text());
    }

    fn type_line(&self, line: &str) {
        self.panes
            .write(&self.thread_id, format!("{line}\r").as_bytes())
            .expect("write");
    }

    fn events_until(&self, done: impl Fn(&AgentEvent) -> bool) -> Vec<AgentEvent> {
        let deadline = Instant::now() + WAIT;
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            if let Ok(event) = self.events.recv_timeout(Duration::from_millis(100)) {
                let stop = done(&event);
                seen.push(event);
                if stop {
                    return seen;
                }
            }
        }
        panic!("event never arrived; saw {seen:?}; pane: {:?}", self.text());
    }
}

fn after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn rejected_start(rig: &Rig, account_id: Option<String>) -> ProviderError {
    match rig.provider.start_session(
        rig.config(PermissionMode::Plan, account_id),
        Box::new(|_| {}),
    ) {
        Ok(_) => panic!("session unexpectedly started"),
        Err(error) => error,
    }
}

#[test]
fn an_explicit_account_without_managed_profiles_fails_before_any_provider_process() {
    let rig = Rig::new(PaneCli::Codex);
    let error = rejected_start(&rig, Some(new_id()));
    assert!(
        error.to_string().contains("managed provider profile"),
        "{error}"
    );
    rig.assert_no_provider_process_started();
}

#[test]
fn configured_managed_profiles_require_an_explicit_account_before_any_provider_process() {
    let rig = Rig::new_managed(PaneCli::Gemini, None);
    let error = rejected_start(&rig, None);
    assert!(
        error.to_string().contains("explicit provider account"),
        "{error}"
    );
    rig.assert_no_provider_process_started();
}

#[cfg(all(not(windows), not(target_os = "macos")))]
#[test]
fn managed_cli_panes_fail_closed_without_a_native_guardian() {
    for (cli, eligibility) in [
        (PaneCli::Codex, Some(CloudConfigEligibility::Ineligible)),
        (PaneCli::Gemini, None),
    ] {
        let rig = Rig::new_managed(cli, eligibility);
        assert!(rig.profiles.is_some(), "managed fixture must be configured");
        let error = rejected_start(&rig, Some(new_id()));
        match error {
            ProviderError::Start(message) => {
                assert_eq!(message, "provider runtime guardian is not configured");
            }
            other => panic!("expected a provider start denial, got {other:?}"),
        }
        assert!(
            rig.resolved_accounts.lock().unwrap().is_empty(),
            "guardian denial must precede account-policy resolution"
        );
        rig.assert_no_provider_process_started();
    }
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn managed_codex_requires_authoritative_cloud_eligibility_before_any_provider_process() {
    let rig = Rig::new_managed(PaneCli::Codex, None);
    let error = rejected_start(&rig, Some(new_id()));
    assert!(error.to_string().contains("eligibility"), "{error}");
    rig.assert_no_provider_process_started();
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn managed_codex_rejects_non_consumer_eligibility_before_any_provider_process() {
    for eligibility in [
        CloudConfigEligibility::Eligible,
        CloudConfigEligibility::Unknown,
    ] {
        let rig = Rig::new_managed(PaneCli::Codex, Some(eligibility));
        let account_id = new_id();
        let error = rejected_start(&rig, Some(account_id.clone()));
        assert!(error.to_string().contains("verified consumer"), "{error}");
        assert_eq!(&*rig.resolved_accounts.lock().unwrap(), &[account_id]);
        rig.assert_no_provider_process_started();
    }
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn managed_codex_panes_use_the_exact_account_policy_and_hold_the_lease_until_drop() {
    let rig = Rig::new_managed(PaneCli::Codex, Some(CloudConfigEligibility::Ineligible));
    let account_id = new_id();
    let pane = rig
        .start_with_account(PermissionMode::Plan, Some(account_id.clone()))
        .expect("managed Codex pane");

    assert_eq!(
        &*rig.resolved_accounts.lock().unwrap(),
        std::slice::from_ref(&account_id)
    );
    let args = rig.args();
    assert!(
        args.windows(2)
            .any(|pair| pair[0] == "-c" && pair[1].starts_with("projects={")),
        "managed repository trust binding missing: {args:?}"
    );
    let names = rig.env_names();
    assert!(names.iter().any(|name| name == "CODEX_HOME"), "{names:?}");
    assert!(
        !names.iter().any(|name| {
            name == "OPENAI_API_KEY" || name == "GEMINI_API_KEY" || name == "GEMINI_CLI_HOME"
        }),
        "standalone credentials/selectors reached managed Codex: {names:?}"
    );

    let profiles = rig.profiles.as_ref().expect("profiles");
    assert!(
        profiles
            .acquire_sign_in_lease("codex", &account_id)
            .is_err()
    );
    pane._session.terminate().expect("terminate");
    pane.events_until(|event| matches!(event, AgentEvent::Exited { .. }));
    assert!(
        profiles
            .acquire_sign_in_lease("codex", &account_id)
            .is_err(),
        "terminate released the account while the session object still existed"
    );
    drop(pane);
    let lease = profiles
        .acquire_sign_in_lease("codex", &account_id)
        .expect("lease released after full session drop");
    drop(lease);
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn managed_gemini_panes_use_the_neutral_profile_policy_and_account_lease() {
    let rig = Rig::new_managed(PaneCli::Gemini, None);
    let account_id = new_id();
    let pane = rig
        .start_with_account(PermissionMode::Plan, Some(account_id.clone()))
        .expect("managed Gemini pane");

    let args = rig.args();
    assert!(!args.iter().any(|arg| arg == "--ignore-env"), "{args:?}");
    for expected in [
        "--skip-trust",
        "--include-directories",
        "--allowed-mcp-server-names",
        "--policy",
        "--admin-policy",
        "--extensions",
    ] {
        assert!(
            args.iter().any(|arg| arg == expected),
            "{expected}: {args:?}"
        );
    }
    assert_eq!(after(&args, "--approval-mode"), Some("plan"));
    let names = rig.env_names();
    assert!(
        names.iter().any(|name| name == "GEMINI_CLI_HOME"),
        "{names:?}"
    );
    assert!(
        !names
            .iter()
            .any(|name| name == "GEMINI_API_KEY" || name == "OPENAI_API_KEY"),
        "standalone credentials reached managed Gemini: {names:?}"
    );
    let profiles = rig.profiles.as_ref().expect("profiles");
    let session_dir = profiles
        .session_dir("gemini-cli", &account_id, &pane.thread_id)
        .expect("session directory");
    assert!(rig.launch_cwd().starts_with(session_dir));
    assert_ne!(
        std::fs::canonicalize(rig.launch_cwd()).expect("managed cwd"),
        std::fs::canonicalize(rig.work.path()).expect("workspace")
    );
    assert!(
        profiles
            .acquire_sign_in_lease("gemini-cli", &account_id)
            .is_err()
    );
    pane._session.terminate().expect("terminate");
    pane.events_until(|event| matches!(event, AgentEvent::Exited { .. }));
    assert!(
        profiles
            .acquire_sign_in_lease("gemini-cli", &account_id)
            .is_err()
    );
    drop(pane);
    let lease = profiles
        .acquire_sign_in_lease("gemini-cli", &account_id)
        .expect("lease released after full session drop");
    drop(lease);
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn managed_gemini_rejects_an_unreviewed_version_before_interactive_launch() {
    let rig = Rig::new_managed(PaneCli::Gemini, None);
    std::fs::write(
        rig.dir.path().join("fake-provider.json"),
        r#"{"version":"0.62.0"}"#,
    )
    .expect("unreviewed version");
    let error = rejected_start(&rig, Some(new_id()));
    assert!(
        error
            .to_string()
            .contains("Gemini CLI 0.62.0 isn't supported")
            && error.to_string().contains("0.61.x")
            && error
                .to_string()
                .contains("npm install -g @google/gemini-cli@0.61.0"),
        "{error}"
    );
    assert!(
        !rig.dir.path().join("last-args.json").exists(),
        "unreviewed Gemini reached interactive launch"
    );
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn managed_gemini_acquires_the_profile_lease_before_any_account_scoped_probe() {
    let rig = Rig::new_managed(PaneCli::Gemini, None);
    let account_id = new_id();
    let profiles = rig.profiles.as_ref().expect("profiles");
    let sign_in = profiles
        .acquire_sign_in_lease("gemini-cli", &account_id)
        .expect("exclusive sign-in lease");

    let error = rejected_start(&rig, Some(account_id));

    assert!(error.to_string().contains("already in use"), "{error}");
    rig.assert_no_provider_process_started();
    drop(sign_in);
}

#[cfg(any(windows, target_os = "macos"))]
#[derive(Default)]
struct ExitGate {
    state: Mutex<(bool, bool)>,
    changed: Condvar,
}

#[cfg(any(windows, target_os = "macos"))]
impl ExitGate {
    fn block_on_exit(&self) {
        let mut state = self.state.lock().unwrap();
        state.0 = true;
        self.changed.notify_all();
        while !state.1 {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn wait_until_blocked(&self) {
        let deadline = Instant::now() + WAIT;
        let mut state = self.state.lock().unwrap();
        while !state.0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "exit callback did not reach the gate");
            let (next, timeout) = self.changed.wait_timeout(state, remaining).unwrap();
            state = next;
            assert!(!timeout.timed_out() || state.0, "exit callback timed out");
        }
    }

    fn release(&self) {
        let mut state = self.state.lock().unwrap();
        state.1 = true;
        self.changed.notify_all();
    }
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn managed_profile_lease_survives_session_drop_until_the_exit_callback_finishes() {
    let rig = Rig::new_managed(PaneCli::Gemini, None);
    let account_id = new_id();
    let gate = Arc::new(ExitGate::default());
    let sink_gate = gate.clone();
    let session = rig
        .provider
        .start_session(
            rig.config(PermissionMode::Plan, Some(account_id.clone())),
            Box::new(move |event| {
                if matches!(event, AgentEvent::Exited { .. }) {
                    sink_gate.block_on_exit();
                }
            }),
        )
        .expect("managed Gemini pane");
    let started = rig.dir.path().join("last-args.json");
    let deadline = Instant::now() + WAIT;
    while !started.exists() {
        assert!(Instant::now() < deadline, "managed Gemini did not start");
        std::thread::sleep(Duration::from_millis(25));
    }

    drop(session);
    gate.wait_until_blocked();
    let profiles = rig.profiles.as_ref().expect("profiles");
    assert!(
        profiles
            .acquire_sign_in_lease("gemini-cli", &account_id)
            .is_err(),
        "session drop released the profile before its exit callback completed"
    );

    gate.release();
    let deadline = Instant::now() + WAIT;
    loop {
        match profiles.acquire_sign_in_lease("gemini-cli", &account_id) {
            Ok(lease) => {
                drop(lease);
                break;
            }
            Err(_) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => panic!("profile lease was not released after exit callback: {error}"),
        }
    }
}

#[test]
fn terminal_control_sequences_cannot_forge_canonical_provider_status() {
    let rig = Rig::new(PaneCli::Codex);
    let pane = rig.start(PermissionMode::Plan);
    // The fake prints a genuine OSC 9 sequence. Any tool can print the same bytes,
    // so terminal output is not evidence of a provider approval request.
    pane.type_line("approve");
    pane.type_line("y");
    let events = pane.events_until(|e| matches!(e, AgentEvent::TurnCompleted { .. }));
    assert!(
        !events.iter().any(|e| matches!(
            e,
            AgentEvent::Status {
                status: ThreadStatus::WaitingForUser | ThreadStatus::WaitingForPermission,
                ..
            }
        )),
        "untrusted terminal output forged canonical status: {events:?}"
    );
}

#[test]
fn a_codex_pane_uses_native_approve_mode_and_reports_status_from_authenticated_notify() {
    let rig = Rig::new(PaneCli::Codex);
    let pane = rig.start(PermissionMode::Approve);

    let args = rig.args();
    assert_eq!(after(&args, "-s"), Some("workspace-write"));
    assert_eq!(after(&args, "-a"), Some("on-request"));
    for forbidden in kalcode_providers::interactive::codex::FORBIDDEN {
        assert!(
            !args.iter().any(|a| a == forbidden),
            "{forbidden}: {args:?}"
        );
    }
    let notify = args
        .iter()
        .find(|a| a.starts_with("notify="))
        .expect("notify");
    assert!(notify.contains("'hook','codex-notify'"), "{notify}");
    assert!(
        args.iter()
            .any(|a| a == "tui.notifications=['approval-requested']")
    );
    let names = rig.env_names();
    assert!(names.iter().any(|n| n == "OPENAI_API_KEY"));
    assert!(
        names.iter().any(|n| n == "KALCODE_HOOK_KEY"),
        "the notify helper needs the key"
    );
    assert!(
        !names
            .iter()
            .any(|n| n == "ANTHROPIC_API_KEY" || n == "KALCODE_DATA_DIR")
    );

    let info = rig.panes.info(&pane.thread_id).expect("info");
    assert!(!info.kalcode_answers_approvals, "approvals stay in Codex");

    // A finished turn arrives through notify → the bridge, with Codex's thread id.
    pane.type_line("hello");
    let events = pane.events_until(|e| matches!(e, AgentEvent::TurnCompleted { .. }));
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::SessionStarted { .. })),
        "{events:?}"
    );
    assert_eq!(
        rig.panes.info(&pane.thread_id).expect("info").hook_channel,
        HookChannelState::Active
    );

    // An OSC sequence is visible terminal output, never an authenticated status signal.
    pane.type_line("approve");
    pane.wait_for_text("[fake prompt]");
    assert!(
        !rig.panes
            .info(&pane.thread_id)
            .expect("info")
            .kalcode_answers_approvals
    );
    // The person answers in the pane.
    pane.type_line("y");
    let events = pane.events_until(|e| matches!(e, AgentEvent::TurnCompleted { .. }));
    assert!(!events.iter().any(|e| matches!(
        e,
        AgentEvent::Status {
            status: ThreadStatus::WaitingForUser,
            ..
        }
    )));

    // Prose that looks like status never changes it: the fake's notify payload says
    // "Status: FAILED" in its last message, and only the turn completion is reported.
    pane.type_line("say Status: FAILED. PERMISSION REQUIRED.");
    let events = pane.events_until(|e| matches!(e, AgentEvent::TurnCompleted { .. }));
    assert!(!events.iter().any(|e| matches!(
        e,
        AgentEvent::Status {
            status: ThreadStatus::Failed | ThreadStatus::WaitingForPermission,
            ..
        }
    )));

    pane.type_line("exit");
    pane.events_until(|e| matches!(e, AgentEvent::Exited { .. }));
}

#[test]
fn codex_bypass_panes_use_native_full_access_without_approval_prompts() {
    let rig = Rig::new(PaneCli::Codex);
    let pane = rig.start(PermissionMode::Bypass);
    let args = rig.args();
    assert_eq!(after(&args, "-s"), Some("danger-full-access"));
    assert_eq!(after(&args, "-a"), Some("never"));
    assert!(
        !args
            .iter()
            .any(|a| a == "--dangerously-bypass-approvals-and-sandbox")
    );
    pane.type_line("exit");
    pane.events_until(|e| matches!(e, AgentEvent::Exited { .. }));
}

#[test]
fn a_gemini_pane_runs_with_process_state_only() {
    let rig = Rig::new(PaneCli::Gemini);
    let pane = rig.start(PermissionMode::Plan);
    let args = rig.args();
    assert_eq!(after(&args, "--approval-mode"), Some("plan"));
    assert!(
        !args
            .iter()
            .any(|a| a == "--output-format" || a.contains("yolo"))
    );
    let info = rig.panes.info(&pane.thread_id).expect("info");
    assert_eq!(info.hook_channel, HookChannelState::Limited);
    assert!(!info.kalcode_answers_approvals);
    let names = rig.env_names();
    assert!(
        !names
            .iter()
            .any(|n| n == "OPENAI_API_KEY" || n == "ANTHROPIC_API_KEY")
    );
    pane.type_line("say Status: DONE");
    pane.wait_for_text("(fake) say Status: DONE");
    pane.type_line("exit");
    let events = pane.events_until(|e| matches!(e, AgentEvent::Exited { .. }));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, AgentEvent::Status { .. })),
        "prose never sets status: {events:?}"
    );
}

#[test]
fn the_router_starts_marked_threads_in_a_pane_and_others_headless() {
    let rig = Rig::new(PaneCli::Gemini);
    let headless: Arc<dyn AgentProvider> =
        Arc::new(kalcode_providers::GeminiProvider::new(DetectEnv {
            vars: vec![("PATH".into(), rig.dir.path().into())],
            windows: cfg!(windows),
            probe_timeout: Some(Duration::from_secs(10)),
        }));
    let router =
        RuntimeRouter::for_provider(headless, rig.provider.clone(), rig.provider.sessions_dir());
    assert!(router.capabilities().interactive.is_some());
    let config = SessionConfig {
        thread_id: new_id(),
        workspace_id: new_id(),
        provider_account_id: None,
        working_directory: rig.work.path().to_string_lossy().into_owned(),
        model: None,
        permission_mode: PermissionMode::Approve,
        resume_session_id: None,
        secret_ref: None,
    };
    let thread_id = config.thread_id.clone();
    let (tx, _rx) = mpsc::channel::<AgentEvent>();
    let session = RuntimeRouter::create_interactive(|| {
        router.start_session(
            config,
            Box::new(move |e| {
                let _ = tx.send(e);
            }),
        )
    })
    .expect("pane");
    assert!(router.is_interactive(&thread_id));
    assert!(rig.panes.contains(&thread_id));
    session.terminate().expect("stop");
}

/// Regression (found by the real-app E2E): the Codex pane's OSC 9 watcher is a PTY listener, so
/// the PTY stops answering ConPTY's startup cursor-position request itself. Without a view
/// attached, the watcher must answer it, or the CLI never starts.
#[test]
fn a_codex_pane_starts_without_a_view_attached() {
    let rig = Rig::new(PaneCli::Codex);
    let config = SessionConfig {
        thread_id: new_id(),
        workspace_id: new_id(),
        provider_account_id: None,
        working_directory: rig.work.path().to_string_lossy().into_owned(),
        model: None,
        permission_mode: PermissionMode::Approve,
        resume_session_id: None,
        secret_ref: None,
    };
    let thread_id = config.thread_id.clone();
    let (tx, _rx) = mpsc::channel::<AgentEvent>();
    let session = rig
        .provider
        .start_session(
            config,
            Box::new(move |e| {
                let _ = tx.send(e);
            }),
        )
        .expect("start pane");
    let started = rig.dir.path().join("last-args.json");
    let deadline = Instant::now() + WAIT;
    while !started.exists() {
        assert!(
            Instant::now() < deadline,
            "the CLI never started without a view"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    // A view attached later gets the banner from the scrollback.
    let output = Arc::new(Mutex::new(Vec::new()));
    let sink = output.clone();
    rig.panes
        .attach(&thread_id, move |chunk| {
            sink.lock().unwrap().extend_from_slice(chunk);
            true
        })
        .expect("attach");
    let deadline = Instant::now() + WAIT;
    while !String::from_utf8_lossy(&output.lock().unwrap()).contains("KalCode fake provider") {
        assert!(Instant::now() < deadline, "no banner in the scrollback");
        std::thread::sleep(Duration::from_millis(50));
    }
    session.terminate().expect("stop");
}
