//! Real Claude Code checks of KalCode's managed account path. Every test is `#[ignore]`d and needs
//! `KALCODE_REAL_CLAUDE` set to an installed `claude` executable.
//!
//! The status probe never signs in, sends a prompt or uses quota. It runs the production
//! `ClaudeAccountAuthManager` path (exclusive sign-in lease, native guardian job, certified-version
//! gate, `claude auth status --json`) against a throwaway managed profile, so it proves what the
//! fixtures can't: that the installed release passes KalCode's certified-version gate and that
//! Claude reports the isolated profile as signed out.
//!
//! The login probe additionally needs `KALCODE_REAL_CLAUDE_LOGIN_PROBE=1`. It starts the official
//! `claude auth login --claudeai`, which OPENS THE DEFAULT BROWSER ONCE on Claude's sign-in page,
//! then cancels before any sign-in can complete and proves the process tree was cleaned up.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use kalcode_providers::DetectEnv;
use kalcode_providers::claude_account_auth::ClaudeAccountAuthManager;
use kalcode_providers::managed::ManagedProfiles;

fn real_claude() -> Option<PathBuf> {
    let Some(path) = std::env::var_os("KALCODE_REAL_CLAUDE") else {
        eprintln!("skipped: set KALCODE_REAL_CLAUDE to an installed Claude Code executable");
        return None;
    };
    Some(PathBuf::from(path))
}

fn source(root: &Path) -> DetectEnv {
    let person = root.join("person");
    let mut vars = vec![
        ("HOME".into(), person.clone().into_os_string()),
        ("USERPROFILE".into(), person.clone().into_os_string()),
        (
            "APPDATA".into(),
            person.join("AppData").join("Roaming").into_os_string(),
        ),
        (
            "LOCALAPPDATA".into(),
            person.join("AppData").join("Local").into_os_string(),
        ),
    ];
    for name in [
        "PATH",
        "PATHEXT",
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

struct Rig {
    #[cfg(any(windows, target_os = "macos"))]
    _guardian: kalcode_providers::guardian::GuardianRuntime,
    profiles: Arc<ManagedProfiles>,
    manager: ClaudeAccountAuthManager,
    _temp: tempfile::TempDir,
}

fn rig(claude: PathBuf) -> Rig {
    let temp = tempfile::tempdir().expect("temp");
    let root = std::fs::canonicalize(temp.path()).expect("canonical temp");
    std::fs::create_dir_all(root.join("person")).expect("person");
    #[cfg(any(windows, target_os = "macos"))]
    let guardian = kalcode_providers::guardian::GuardianRuntime::launch(
        Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
        &root,
    )
    .expect("native provider guardian");
    #[cfg(any(windows, target_os = "macos"))]
    let profiles = ManagedProfiles::for_data_dir_guarded(
        &root,
        guardian.authority(),
        guardian.profile_generation(),
    )
    .expect("guarded managed profiles");
    #[cfg(not(any(windows, target_os = "macos")))]
    let profiles = ManagedProfiles::new(root.join("managed")).expect("managed profiles");
    let profiles = Arc::new(profiles);
    let manager = ClaudeAccountAuthManager::new(claude, source(&root), Arc::clone(&profiles));
    Rig {
        #[cfg(any(windows, target_os = "macos"))]
        _guardian: guardian,
        profiles,
        manager,
        _temp: temp,
    }
}

#[test]
#[ignore = "needs a real Claude Code (KALCODE_REAL_CLAUDE); no sign-in, prompt or quota"]
fn real_managed_status_passes_the_certified_version_gate_and_reports_signed_out() {
    let Some(claude) = real_claude() else { return };
    let rig = rig(claude);
    let account_id = kalcode_contracts::ids::new_id();
    let lease = rig
        .profiles
        .acquire_sign_in_lease("claude-code", &account_id)
        .expect("exclusive lease");
    let state = rig
        .manager
        .read_account_with_lease_observed(&account_id, lease, |_| Ok(()))
        .unwrap_or_else(|error| {
            panic!(
                "production Claude account path failed with reason {}: {error}",
                error.reason_code()
            )
        });
    assert!(
        !state.logged_in,
        "a fresh managed profile must be signed out"
    );
    assert_eq!(state.auth_method.as_deref(), Some("none"));
    let _session = rig
        .profiles
        .acquire_session_lease("claude-code", &account_id)
        .expect("status releases the exclusive lease");
}

#[test]
#[ignore = "needs KALCODE_REAL_CLAUDE and KALCODE_REAL_CLAUDE_LOGIN_PROBE=1; opens the browser once"]
fn real_managed_login_reaches_browser_handoff_and_cancels_cleanly() {
    let Some(claude) = real_claude() else { return };
    if std::env::var_os("KALCODE_REAL_CLAUDE_LOGIN_PROBE").is_none() {
        eprintln!("skipped: set KALCODE_REAL_CLAUDE_LOGIN_PROBE=1 to allow one browser hand-off");
        return;
    }
    let rig = rig(claude);
    let account_id = kalcode_contracts::ids::new_id();
    let lease = rig
        .profiles
        .acquire_sign_in_lease("claude-code", &account_id)
        .expect("exclusive lease");
    let pending = rig
        .manager
        .start_login_with_lease_observed(&account_id, lease, |_| Ok(()))
        .unwrap_or_else(|error| {
            panic!(
                "production Claude login failed to start with reason {}: {error}",
                error.reason_code()
            )
        });
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !pending.browser_handoff_started() && std::time::Instant::now() < deadline {
        assert!(
            !pending.is_finished(),
            "Claude login ended before its browser hand-off: {:?}",
            pending.wait().map_err(|error| error.reason_code())
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(
        pending.browser_handoff_started(),
        "Claude did not reach its browser hand-off within 30 seconds"
    );
    pending
        .cancel()
        .expect("cancel proves process-tree cleanup");
    let _session = rig
        .profiles
        .acquire_session_lease("claude-code", &account_id)
        .expect("cancel releases the exclusive lease");
}
