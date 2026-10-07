//! Real Codex CLI app-server checks for certifying a Codex release line. `#[ignore]`d; needs
//! `KALCODE_CERTIFY_CODEX` set to the executable or npm shim to certify (for example
//! `<scratch>/codex-0.158.0/node_modules/.bin/codex.cmd` after
//! `npm install --prefix <scratch>/codex-0.158.0 @openai/codex@0.158.0`), and optionally
//! `KALCODE_CERTIFY_CODEX_VERSION` to pin the version it must report.
//!
//! It never completes a sign-in, sends a prompt or uses quota. It drives KalCode's production
//! account-auth path against a fresh, signed-out managed profile: the version gate, app-server
//! `initialize` (its `codexHome` must be the managed home), `account/read`, `account/login/start`
//! (a ChatGPT `authUrl` on the official origin and a `loginId`) and `account/login/cancel`. The
//! authorization URL is never opened, printed or stored; only its length is reported.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::path::PathBuf;
use std::sync::Arc;

use kalcode_providers::DetectEnv;
use kalcode_providers::account_auth::{CodexAccountAuthError, CodexAccountAuthManager};
use kalcode_providers::codex::runtime::{
    ManagedRuntimeSource, prewarm_managed_runtime, select_managed_runtime,
};
use kalcode_providers::env::EnvPolicy;
use kalcode_providers::managed::ManagedProfiles;
use kalcode_providers::managed_runtime::RuntimeStore;

fn certified_codex() -> Option<PathBuf> {
    let Some(path) = std::env::var_os("KALCODE_CERTIFY_CODEX") else {
        eprintln!("skipped: set KALCODE_CERTIFY_CODEX to the Codex CLI to certify");
        return None;
    };
    Some(PathBuf::from(path))
}

/// A source environment with a synthetic person home, so nothing standalone is reachable.
fn source(root: &std::path::Path) -> DetectEnv {
    let person = root.join("person");
    std::fs::create_dir_all(&person).expect("person");
    let mut vars = vec![
        ("HOME".into(), person.clone().into_os_string()),
        ("USERPROFILE".into(), person.into_os_string()),
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
        system_root: None,
    }
}

/// Proves the complete production selection path against real installed package bytes: resolve
/// the distribution, copy it into immutable KalCode storage, apply its rebased launcher
/// environment, run capability/help probes, and complete the isolated app-server handshake. It
/// never signs in, opens an authorization URL, sends a prompt, or reads the user's Codex home.
#[test]
#[cfg(any(windows, target_os = "macos"))]
#[ignore = "needs a real Codex CLI (KALCODE_CERTIFY_CODEX); no sign-in, prompt or quota"]
fn real_codex_selects_and_probes_an_immutable_managed_runtime() {
    let Some(codex) = certified_codex() else {
        return;
    };
    let temp = tempfile::tempdir().expect("temp");
    let root = std::fs::canonicalize(temp.path()).expect("canonical temp");
    let guardian_root = root.join("guardian");
    std::fs::create_dir(&guardian_root).expect("guardian directory");
    let guardian = kalcode_providers::guardian::GuardianRuntime::launch(
        std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
        &guardian_root,
    )
    .expect("native provider guardian");
    let probe_guardian = guardian.probe_guardian().expect("probe guardian");
    let neutral = root.join("neutral");
    std::fs::create_dir(&neutral).expect("neutral probe directory");
    let store_root = root.join("managed-runtimes");
    let store = RuntimeStore::new(&store_root);
    let env = source(&root).provider_env(&EnvPolicy::BASE);

    let foreground_started = std::time::Instant::now();
    let foreground = select_managed_runtime(
        Some(&codex),
        &env,
        &neutral,
        &store,
        |label| {
            probe_guardian
                .prepare_job(label)
                .map_err(|error| kalcode_contracts::agent::ProviderError::Start(error.to_string()))
        },
        None,
    )
    .expect("real Codex direct foreground selection");
    let foreground_elapsed = foreground_started.elapsed();
    assert_eq!(foreground.source(), ManagedRuntimeSource::InstalledDirect);
    assert!(foreground.runtime_lease().is_none());
    assert!(
        !store_root.exists(),
        "a foreground prewarm miss must not create or copy runtime storage"
    );
    drop(foreground);

    let cold_started = std::time::Instant::now();
    let selected = prewarm_managed_runtime(
        Some(&codex),
        &env,
        &neutral,
        &store,
        |label| {
            probe_guardian
                .prepare_job(label)
                .map_err(|error| kalcode_contracts::agent::ProviderError::Start(error.to_string()))
        },
        None,
    )
    .expect("real Codex immutable runtime selection");
    let cold_elapsed = cold_started.elapsed();
    if let Ok(expected) = std::env::var("KALCODE_CERTIFY_CODEX_VERSION") {
        assert_eq!(selected.version().to_string(), expected);
    }
    assert_eq!(selected.source(), ManagedRuntimeSource::ValidatedSnapshot);
    assert!(
        selected.runtime_lease().is_some(),
        "snapshot must remain pinned"
    );
    let selected_path = std::fs::canonicalize(selected.executable()).expect("selected executable");
    let store_root = std::fs::canonicalize(store_root).expect("runtime store");
    assert!(
        selected_path.starts_with(store_root),
        "the selected executable must be the KalCode-owned immutable copy"
    );
    let snapshot_id = selected
        .runtime_lease()
        .expect("snapshot lease")
        .snapshot_id()
        .to_owned();

    let warm_started = std::time::Instant::now();
    let warm = select_managed_runtime(
        Some(&codex),
        &env,
        &neutral,
        &store,
        |label| {
            probe_guardian
                .prepare_job(label)
                .map_err(|error| kalcode_contracts::agent::ProviderError::Start(error.to_string()))
        },
        None,
    )
    .expect("warm real Codex immutable runtime selection");
    let warm_elapsed = warm_started.elapsed();
    assert_eq!(
        warm.runtime_lease().expect("warm lease").snapshot_id(),
        snapshot_id
    );
    assert!(
        warm_elapsed < std::time::Duration::from_secs(1),
        "warm managed runtime selection took {warm_elapsed:?}"
    );
    eprintln!(
        "Codex managed selection: foreground-direct={foreground_elapsed:?}, \
         background-prewarm={cold_elapsed:?}, warm-snapshot={warm_elapsed:?}"
    );
    drop(warm);
    drop(selected);
    guardian
        .seal_and_drain()
        .expect("clean compatibility probe drain");
}

#[test]
#[ignore = "needs a real Codex CLI (KALCODE_CERTIFY_CODEX); no sign-in, prompt or quota"]
fn real_codex_app_server_account_protocol_matches_kalcode() {
    let Some(codex) = certified_codex() else {
        return;
    };
    let version = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
        .args(if cfg!(windows) {
            vec!["/d".into(), "/c".into(), codex.clone().into_os_string()]
        } else {
            vec![codex.clone().into_os_string()]
        })
        .arg("--version")
        .output()
        .expect("codex --version");
    let reported = String::from_utf8_lossy(&version.stdout).trim().to_owned();
    let reported = reported
        .strip_prefix("codex-cli ")
        .unwrap_or_else(|| panic!("unexpected --version format: {reported}"))
        .to_owned();
    if let Ok(expected) = std::env::var("KALCODE_CERTIFY_CODEX_VERSION") {
        assert_eq!(reported, expected, "certifying the wrong binary");
    }
    eprintln!("certifying codex-cli {reported}");

    let temp = tempfile::tempdir().expect("temp");
    let root = std::fs::canonicalize(temp.path()).expect("canonical temp");
    // Production account operations run every provider process under the native guardian.
    #[cfg(any(windows, target_os = "macos"))]
    let guardian = kalcode_providers::guardian::GuardianRuntime::launch(
        std::path::Path::new(env!("CARGO_BIN_EXE_kalcode-provider-guardian")),
        &root,
    )
    .expect("native provider guardian");
    #[cfg(any(windows, target_os = "macos"))]
    let profiles = Arc::new(
        ManagedProfiles::for_data_dir_guarded(
            &root,
            guardian.authority(),
            guardian.profile_generation(),
        )
        .expect("guarded managed profiles"),
    );
    #[cfg(not(any(windows, target_os = "macos")))]
    let profiles = Arc::new(ManagedProfiles::new(root.join("managed")).expect("profiles"));
    let account_id = kalcode_contracts::ids::new_id();
    let manager = CodexAccountAuthManager::new(
        codex,
        source(&root),
        Arc::clone(&profiles),
        "0.0.0-certification",
    );

    // Version gate + initialize(codexHome == managed home) + account/read on a fresh profile.
    let state = manager.read_account(&account_id).expect("account/read");
    assert!(
        state.account.is_none(),
        "a fresh managed profile is signed out"
    );
    assert!(state.requires_openai_auth, "Codex requires OpenAI auth");

    // account/login/start returns a ChatGPT authUrl (validated to the official origin) and a
    // loginId; cancel reaches account/login/cancel and the app-server quiesces.
    let pending = manager
        .start_chatgpt_login(&account_id)
        .expect("account/login/start");
    eprintln!(
        "authUrl accepted (length {}, official origin)",
        pending.auth_url().as_str().len()
    );
    pending.cancel().expect("account/login/cancel");
    assert_eq!(pending.wait(), Err(CodexAccountAuthError::Canceled));

    // Nothing was signed in.
    let after = manager.read_account(&account_id).expect("account/read");
    assert!(
        after.account.is_none(),
        "cancel must leave the profile signed out"
    );
    drop(manager);
    drop(profiles);
    #[cfg(any(windows, target_os = "macos"))]
    drop(guardian);
    // Delete the scratch profiles. Windows may hold a just-exited process's files briefly.
    let scratch = temp.keep();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while let Err(error) = std::fs::remove_dir_all(&scratch) {
        assert!(
            std::time::Instant::now() < deadline,
            "remove scratch profiles: {error}"
        );
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}
