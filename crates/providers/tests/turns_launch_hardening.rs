//! SEC-0.1.1 finding 1 for Codex and Gemini CLI: both install on Windows as npm `.cmd` shims
//! that start a Node.js script. A thread's turn processes run in the workspace, so a planted
//! `node.exe`, `node.cmd`, `codex.cmd`, `gemini.cmd` or `cmd.exe` in a repository must never run.
//! The shim is resolved to `<absolute node.exe> <script>` (`crate::launch`); the stand-ins are
//! copies of the fake provider (which log every start) and batch files that write a marker.
//! No real provider runs and no AI quota is used.
#![cfg(windows)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{
    AgentEvent, AgentInput, AgentProvider, DetectionState, SessionConfig,
};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_providers::{CodexProvider, DetectEnv, GeminiProvider, catalog, detect};
use serde_json::Value;

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const WAIT: Duration = Duration::from_secs(30);

/// What npm (cmd-shim) writes for a package whose bin is a Node.js script.
fn node_shim(script: &str) -> String {
    format!(
        "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\{script}\" %*\r\n"
    )
}

fn copy_fake(to: &Path) {
    std::fs::create_dir_all(to.parent().unwrap()).unwrap();
    std::fs::copy(FAKE, to).unwrap();
    std::fs::write(to.with_file_name("fake-provider.json"), "{}").unwrap();
}

struct Setup {
    _root: tempfile::TempDir,
    workspace: tempfile::TempDir,
    npm: PathBuf,
    nodejs: PathBuf,
}

impl Setup {
    fn new(cli: &str, script: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let npm = root.path().join("npm");
        let nodejs = root.path().join("nodejs");
        std::fs::create_dir_all(&npm).unwrap();
        std::fs::write(npm.join(format!("{cli}.cmd")), node_shim(script)).unwrap();
        let script_path = npm.join(script);
        std::fs::create_dir_all(script_path.parent().unwrap()).unwrap();
        std::fs::write(&script_path, "// not run: node is the fake").unwrap();
        copy_fake(&nodejs.join("node.exe"));
        let workspace = tempfile::tempdir().unwrap();
        let w = workspace.path();
        for name in ["node.cmd", "node.bat", "codex.cmd", "gemini.cmd"] {
            let marker = w.join(format!("planted-{name}.txt"));
            std::fs::write(
                w.join(name),
                format!("@echo planted > \"{}\"\r\n", marker.display()),
            )
            .unwrap();
        }
        for name in ["node.exe", "cmd.exe"] {
            copy_fake(&w.join(name));
        }
        Self {
            _root: root,
            workspace,
            npm,
            nodejs,
        }
    }

    fn env(&self) -> DetectEnv {
        let path = format!(".;{};;{}", self.npm.display(), self.nodejs.display());
        let mut vars: Vec<(OsString, OsString)> = vec![
            ("PATH".into(), path.into()),
            ("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into()),
            ("NoDefaultCurrentDirectoryInExePath".into(), "".into()),
        ];
        for name in [
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
            windows: true,
            probe_timeout: Some(Duration::from_secs(15)),
            system_root: None,
        }
    }

    fn config(&self) -> SessionConfig {
        SessionConfig {
            thread_id: kalcode_contracts::ids::new_id(),
            workspace_id: kalcode_contracts::ids::new_id(),
            provider_account_id: None,
            working_directory: self.workspace.path().display().to_string(),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Approve,
            resume_session_id: None,
            secret_ref: None,
        }
    }

    fn planted_runs(&self) -> Vec<String> {
        std::fs::read_dir(self.workspace.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("planted-") || n == "runs.log")
            .collect()
    }

    fn node_runs(&self) -> Vec<Value> {
        std::fs::read_to_string(self.nodejs.join("runs.log"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

fn one_turn(provider: &dyn AgentProvider, setup: &Setup) -> Vec<AgentEvent> {
    let (tx, rx) = mpsc::channel();
    let session = provider
        .start_session(
            setup.config(),
            Box::new(move |event: AgentEvent| {
                let _ = tx.send(event);
            }),
        )
        .expect("session starts");
    session
        .send(AgentInput::Text {
            text: "hello".into(),
        })
        .expect("send");
    let deadline = Instant::now() + WAIT;
    let mut events = Vec::new();
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("turn completes");
        let done = matches!(event, AgentEvent::TurnCompleted { .. });
        events.push(event);
        if done {
            break;
        }
    }
    session.terminate().unwrap();
    events
}

fn assert_node_ran_script(setup: &Setup, script: &str, turn_flag: &str) {
    assert!(
        setup.planted_runs().is_empty(),
        "planted programs ran: {:?}",
        setup.planted_runs()
    );
    let expected = std::fs::canonicalize(setup.npm.join(script)).unwrap();
    let expected = expected.to_string_lossy();
    let expected = expected.trim_start_matches(r"\\?\");
    let runs = setup.node_runs();
    assert!(runs.len() >= 2, "{runs:?}");
    for run in &runs {
        let arg0 = run["args"][0].as_str().unwrap_or_default();
        assert!(arg0.eq_ignore_ascii_case(expected), "{run}");
    }
    assert!(
        runs.iter()
            .any(|r| r["args"].as_array().unwrap().iter().any(|a| a == turn_flag))
    );
}

#[test]
fn a_codex_npm_shim_runs_the_real_node_never_the_workspace_one() {
    let script = r"node_modules\@openai\codex\bin\codex.js";
    let setup = Setup::new("codex", script);
    let detected = detect::detect(&catalog::codex_spec(), &setup.env());
    assert_eq!(
        detected.detection.state,
        DetectionState::Installed,
        "{detected:?}"
    );
    let events = one_turn(&CodexProvider::new(setup.env()), &setup);
    assert!(
        events.contains(&AgentEvent::TurnCompleted { ok: true }),
        "{events:?}"
    );
    assert_node_ran_script(&setup, script, "exec");
}

#[test]
fn a_gemini_npm_shim_runs_the_real_node_never_the_workspace_one() {
    let script = r"node_modules\@google\gemini-cli\dist\index.js";
    let setup = Setup::new("gemini", script);
    let detected = detect::detect(&catalog::gemini_spec(), &setup.env());
    assert_eq!(
        detected.detection.state,
        DetectionState::Installed,
        "{detected:?}"
    );
    let events = one_turn(&GeminiProvider::new(setup.env()), &setup);
    assert!(
        events.contains(&AgentEvent::TurnCompleted { ok: true }),
        "{events:?}"
    );
    assert_node_ran_script(&setup, script, "--output-format");
}
