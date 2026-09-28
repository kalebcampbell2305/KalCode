//! Real Gemini CLI 0.61.0 checks of KalCode's managed launch material. Every test is `#[ignore]`d
//! and needs `KALCODE_REAL_GEMINI` set to an installed `gemini` executable or npm shim.
//!
//! Neither test signs in, sends a prompt or uses quota:
//! - the sign-in probe answers "n" to Gemini's own consent question, so no browser opens and no
//!   credential is written;
//! - the headless probe runs against a signed-out profile with the browser suppressed, so Gemini
//!   stops at its own authentication check.
//!
//! They prove what fixtures can't: that Gemini accepts every flag KalCode passes (0.61.0 rejects
//! `--ignore-env`), starts with KalCode's profile selector (it crashes on a Windows verbatim
//! `GEMINI_CLI_HOME`), and reaches its official sign-in only through the dedicated flow.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use kalcode_contracts::permissions::PermissionMode;
use kalcode_providers::DetectEnv;
use kalcode_providers::gemini::managed_policy::{ManagedGeminiLaunch, ManagedGeminiSignIn};
use kalcode_providers::managed::ManagedProfiles;

fn real_gemini() -> Option<PathBuf> {
    let Some(path) = std::env::var_os("KALCODE_REAL_GEMINI") else {
        eprintln!("skipped: set KALCODE_REAL_GEMINI to an installed Gemini CLI 0.61.0");
        return None;
    };
    Some(PathBuf::from(path))
}

fn source(temp: &std::path::Path) -> DetectEnv {
    let mut vars = vec![
        ("HOME".into(), temp.join("person").into_os_string()),
        ("USERPROFILE".into(), temp.join("person").into_os_string()),
    ];
    for name in [
        "PATH",
        "PATHEXT",
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
        probe_timeout: None,
    }
}

fn run(
    executable: &std::path::Path,
    env: &std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString>,
    cwd: &std::path::Path,
    args: &[std::ffi::OsString],
    stdin: &[u8],
) -> std::process::Output {
    let launch = kalcode_providers::launch::resolve(executable, env);
    let mut command = Command::new(&launch.program);
    command
        .args(&launch.prefix_args)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("start Gemini CLI");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(stdin)
        .expect("write stdin");
    child.wait_with_output().expect("Gemini CLI output")
}

#[test]
#[ignore = "needs a real Gemini CLI 0.61.0 (KALCODE_REAL_GEMINI); no sign-in, prompt or quota"]
fn real_sign_in_probe_reaches_geminis_own_consent_without_signing_in() {
    let Some(gemini) = real_gemini() else { return };
    let temp = tempfile::tempdir().expect("temp");
    let root = std::fs::canonicalize(temp.path()).expect("canonical temp");
    std::fs::create_dir_all(root.join("person")).expect("person");
    let profiles = ManagedProfiles::new(root.join("managed")).expect("profiles");
    let account_id = kalcode_contracts::ids::new_id();
    let lease = profiles
        .acquire_sign_in_lease("gemini-cli", &account_id)
        .expect("exclusive lease");
    let sign_in = ManagedGeminiSignIn::prepare(&profiles, &source(&root), &account_id, &lease)
        .expect("sign-in launch");

    let output = run(
        &gemini,
        sign_in.environment(),
        sign_in.cwd(),
        sign_in.args(),
        b"n\n",
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("exit {:?}\nstdout:\n{stdout}", output.status.code());
    assert!(!stderr.contains("Unknown argument"), "{stderr}");
    assert!(!stderr.contains("critical error"), "{stderr}");
    assert!(
        stdout.contains("Opening authentication page in your browser. Do you want to continue?"),
        "Gemini did not reach its own Google sign-in: {stdout}\n{stderr}"
    );
    assert!(
        stderr.contains("Authentication cancelled by user"),
        "{stderr}"
    );
    assert_eq!(output.status.code(), Some(0), "{stderr}");
    let home = profiles
        .profile_home("gemini-cli", &account_id)
        .expect("home");
    assert!(
        !home.join(".gemini/oauth_creds.json").exists(),
        "declining must not sign in"
    );
    drop(lease);
}

#[test]
#[ignore = "needs a real Gemini CLI 0.61.0 (KALCODE_REAL_GEMINI); no sign-in, prompt or quota"]
fn real_headless_launch_is_accepted_and_stops_at_geminis_auth_check() {
    let Some(gemini) = real_gemini() else { return };
    let temp = tempfile::tempdir().expect("temp");
    let root = std::fs::canonicalize(temp.path()).expect("canonical temp");
    std::fs::create_dir_all(root.join("person")).expect("person");
    let workspace = root.join("repo");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let profiles = ManagedProfiles::new(root.join("managed")).expect("profiles");
    let account_id = kalcode_contracts::ids::new_id();
    let thread_id = kalcode_contracts::ids::new_id();
    let launch = ManagedGeminiLaunch::prepare(
        &profiles,
        &source(&root),
        &account_id,
        &thread_id,
        &workspace,
        PermissionMode::Plan,
    )
    .expect("managed launch");
    let mut args =
        kalcode_providers::gemini::headless_args(PermissionMode::Plan, None, None).expect("args");
    launch
        .append_security_args(&mut args)
        .expect("security args");
    let mut env = launch.environment().clone();
    // As the headless adapter does: a turn must never start the browser sign-in.
    env.insert("NO_BROWSER".into(), "true".into());

    let output = run(&gemini, &env, launch.cwd(), &args, b"unused prompt\n");
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("exit {:?}\nstderr:\n{stderr}", output.status.code());
    assert!(!stderr.contains("Unknown argument"), "{stderr}");
    assert!(!stderr.contains("critical error"), "{stderr}");
    assert_eq!(
        output.status.code(),
        Some(41),
        "a signed-out profile stops at Gemini's FATAL_AUTHENTICATION_ERROR: {stderr}"
    );
}
