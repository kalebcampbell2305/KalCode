//! Regression tests for security review finding 1 (Windows): a Claude Code install that is an
//! npm `.cmd` shim must never let `cmd.exe` run a program planted in the workspace when a thread
//! starts. Ported from the review's proof of concept (`zz_review_cmd_shim_cwd.rs`), which
//! showed a `node.cmd` committed to a repository running in place of Node.js.
//!
//! The workspace here contains stand-ins for every program the shim or `cmd.exe` could look up
//! by bare name: `node.exe`, `node.cmd`, `node.bat`, `claude.cmd` and `cmd.exe`. The batch
//! stand-ins write a marker file; the executables are copies of the fake provider, which logs
//! every start to `runs.log` beside itself. No real provider runs and no AI quota is used.
#![cfg(windows)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{
    AgentEvent, AgentInput, AgentProvider, AgentSession, DetectionState, SessionConfig,
};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_providers::claude::session::SessionTimeouts;
use kalcode_providers::{ClaudeCodeProvider, DetectEnv, catalog, detect};
use serde_json::Value;

const FAKE: &str = env!("CARGO_BIN_EXE_kalcode-fake-provider");
const WAIT: Duration = Duration::from_secs(30);

/// What npm (cmd-shim) writes for a package whose bin is a Node.js script. Copied from the
/// review's proof of concept.
const NPM_NODE_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n";

/// What npm writes for a package whose bin is a native executable (current Claude Code).
const NPM_NATIVE_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n";

/// A shim KalCode deliberately can't resolve (two different targets), which starts a bare
/// `node`: the fallback path, where only the hardened environment protects the workspace.
const UNRESOLVABLE_SHIM: &str =
    "@ECHO off\r\nrem \"%~dp0\\other.js\"\r\nnode \"%~dp0\\cli.js\" %*\r\n";

struct Setup {
    /// Holds the provider install and the real Node.js.
    root: tempfile::TempDir,
    workspace: tempfile::TempDir,
    npm: PathBuf,
    nodejs: PathBuf,
}

fn copy_fake(to: &Path) {
    std::fs::create_dir_all(to.parent().unwrap()).unwrap();
    std::fs::copy(FAKE, to).unwrap();
    std::fs::write(to.with_file_name("fake-provider.json"), "{}").unwrap();
}

impl Setup {
    fn new(shim: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let npm = root.path().join("npm");
        let nodejs = root.path().join("nodejs");
        std::fs::create_dir_all(&npm).unwrap();
        std::fs::write(npm.join("claude.cmd"), shim).unwrap();
        let package = npm.join(r"node_modules\@anthropic-ai\claude-code");
        std::fs::create_dir_all(package.join("bin")).unwrap();
        std::fs::write(package.join("cli.js"), "// not run: node is the fake").unwrap();
        std::fs::write(npm.join("cli.js"), "").unwrap();
        std::fs::write(npm.join("other.js"), "").unwrap();
        copy_fake(&package.join(r"bin\claude.exe"));
        copy_fake(&nodejs.join("node.exe"));

        // A cloned repository with stand-ins for everything looked up by bare name.
        let workspace = tempfile::tempdir().unwrap();
        let w = workspace.path();
        for name in ["node.cmd", "node.bat", "claude.cmd"] {
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
            root,
            workspace,
            npm,
            nodejs,
        }
    }

    /// The process environment KalCode reads: the shim folder and Node.js on PATH (plus a
    /// relative entry that must be ignored), and what Windows needs to run `cmd.exe`.
    fn env(&self) -> DetectEnv {
        let path = format!(".;{};;{}", self.npm.display(), self.nodejs.display());
        let mut vars: Vec<(OsString, OsString)> = vec![
            ("PATH".into(), path.into()),
            ("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into()),
            // The parent can't switch the protection off.
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

    /// Anything planted in the workspace that ran.
    fn planted_runs(&self) -> Vec<String> {
        std::fs::read_dir(self.workspace.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("planted-") || n == "runs.log")
            .collect()
    }

    fn runs(&self, dir: &Path) -> Vec<Value> {
        std::fs::read_to_string(dir.join("runs.log"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

fn start_turn(setup: &Setup) -> (Box<dyn AgentSession>, Receiver<AgentEvent>) {
    let provider = ClaudeCodeProvider::new(setup.env()).with_timeouts(SessionTimeouts {
        interrupt_ack: Duration::from_secs(2),
        terminate_grace: Duration::from_millis(500),
    });
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
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("turn completes");
        if matches!(event, AgentEvent::TurnCompleted { .. }) {
            break;
        }
    }
    (session, rx)
}

fn stop(session: Box<dyn AgentSession>, rx: &Receiver<AgentEvent>) {
    session.terminate().unwrap();
    let deadline = Instant::now() + WAIT;
    while let Ok(event) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        if matches!(event, AgentEvent::Exited { .. }) {
            break;
        }
    }
}

fn arg0(run: &Value) -> String {
    run["args"][0].as_str().unwrap_or_default().to_owned()
}

#[test]
fn an_npm_node_shim_runs_the_real_node_never_the_workspace_one() {
    let setup = Setup::new(NPM_NODE_SHIM);
    let (session, rx) = start_turn(&setup);
    stop(session, &rx);

    assert!(
        setup.planted_runs().is_empty(),
        "planted programs ran: {:?}",
        setup.planted_runs()
    );
    // Detection probes and the session all went to the real node.exe with the shim's script.
    let runs = setup.runs(&setup.nodejs);
    let script = std::fs::canonicalize(
        setup
            .npm
            .join(r"node_modules\@anthropic-ai\claude-code\cli.js"),
    )
    .unwrap();
    let script = script.to_string_lossy();
    let script = script.trim_start_matches(r"\\?\");
    assert!(runs.len() >= 3, "{runs:?}"); // --version, auth status, session
    for run in &runs {
        assert!(arg0(run).eq_ignore_ascii_case(script), "{run}");
    }
    assert!(
        runs.iter()
            .any(|r| r["args"].as_array().unwrap().iter().any(|a| a == "-p"))
    );
    // The session still runs in the workspace.
    let cwd = std::fs::read_to_string(setup.nodejs.join("last-cwd.txt")).unwrap();
    assert_eq!(
        std::fs::canonicalize(cwd.trim()).unwrap(),
        std::fs::canonicalize(setup.workspace.path()).unwrap()
    );
    drop(setup.root);
}

#[test]
fn an_npm_shim_for_the_native_binary_starts_it_directly() {
    let setup = Setup::new(NPM_NATIVE_SHIM);
    let (session, rx) = start_turn(&setup);
    stop(session, &rx);

    assert!(
        setup.planted_runs().is_empty(),
        "{:?}",
        setup.planted_runs()
    );
    assert!(setup.runs(&setup.nodejs).is_empty(), "node is not involved");
    let bin = setup
        .npm
        .join(r"node_modules\@anthropic-ai\claude-code\bin");
    let runs = setup.runs(&bin);
    assert!(runs.len() >= 3, "{runs:?}");
    // Started directly: no script argument in front of the CLI's own arguments.
    assert_eq!(arg0(&runs[0]), "--version");
    assert!(runs.iter().any(|r| arg0(r) == "-p"));
}

#[test]
fn an_unresolvable_shim_still_never_runs_workspace_programs() {
    let setup = Setup::new(UNRESOLVABLE_SHIM);

    // Control: the same shim, started the way KalCode did before the fix (workspace as working
    // directory, no NoDefaultCurrentDirectoryInExePath), runs the planted program. This proves
    // the stand-ins are reachable, so the assertion below means something.
    let control_env = [
        (
            "PATH",
            format!("{};{}", setup.npm.display(), setup.nodejs.display()),
        ),
        ("PATHEXT", ".COM;.EXE;.BAT;.CMD".to_owned()),
        (
            "SystemRoot",
            std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()),
        ),
    ];
    use std::os::windows::process::CommandExt;

    let mut control = std::process::Command::new(setup.npm.join("claude.cmd"));
    control.creation_flags(0x0800_0000);
    let status = control
        .arg("--version")
        .current_dir(setup.workspace.path())
        .env_clear()
        .envs(control_env)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    let _ = status;
    assert!(
        !setup.planted_runs().is_empty(),
        "control: the unhardened launch should reach the workspace stand-in"
    );
    for name in setup.planted_runs() {
        std::fs::remove_file(setup.workspace.path().join(name)).unwrap();
    }

    // KalCode: the shim can't be resolved, so it runs through cmd.exe, hardened.
    let result = detect::detect(&catalog::claude_spec(), &setup.env());
    assert_eq!(
        result.detection.state,
        DetectionState::Installed,
        "{result:?}"
    );
    let (session, rx) = start_turn(&setup);
    stop(session, &rx);
    assert!(
        setup.planted_runs().is_empty(),
        "{:?}",
        setup.planted_runs()
    );
    let runs = setup.runs(&setup.nodejs);
    assert!(
        runs.iter()
            .any(|r| r["args"].as_array().unwrap().iter().any(|a| a == "-p"))
    );
}
