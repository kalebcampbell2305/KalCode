//! End-to-end managed Gemini launch using the deterministic fake provider. No provider account,
//! credential, network call, or inference is involved.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentEvent, AgentInput, AgentProvider, SessionConfig};
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
        let bin = temp.path().join("bin");
        let workspace = temp.path().join("repo");
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
            temp.path(),
        )
        .expect("native provider guardian");
        #[cfg(any(windows, target_os = "macos"))]
        let profiles = ManagedProfiles::for_data_dir_guarded(
            temp.path(),
            guardian.authority(),
            guardian.profile_generation(),
        )
        .expect("guarded managed profiles");
        #[cfg(not(any(windows, target_os = "macos")))]
        let profiles = ManagedProfiles::new(temp.path().join("managed")).expect("managed profiles");
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

    fn neutral(&self) -> PathBuf {
        self.profiles
            .session_dir("gemini-cli", &self.account_id, &self.thread_id)
            .expect("session")
            .join("neutral")
    }

    fn read_json(&self, name: &str) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(self.bin.join(name)).expect(name)).expect(name)
    }
}

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

fn canonical(path: impl AsRef<Path>) -> PathBuf {
    std::fs::canonicalize(path).expect("canonical path")
}

#[test]
fn managed_headless_turn_runs_from_neutral_profile_and_repairs_the_floor() {
    let rig = Rig::new();
    let provider = GeminiProvider::new_managed(rig.env(), rig.profiles.clone());
    let (tx, rx) = mpsc::channel();
    let session = provider
        .start_session(
            rig.config(),
            Box::new(move |event: AgentEvent| {
                let _ = tx.send(event);
            }),
        )
        .expect("managed session");
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
        "--ignore-env",
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
    let _sign_in = rig
        .profiles
        .acquire_sign_in_lease("gemini-cli", &rig.account_id)
        .expect("lease releases after session drop");
}

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
