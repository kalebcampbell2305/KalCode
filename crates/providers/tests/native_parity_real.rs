//! NATIVE PROVIDER TERMINAL vs KALCODE PROVIDER TERMINAL with the real installed CLIs (AGENTS.md
//! native provider parity rule). `#[ignore]`d and opt-in (`KALCODE_NATIVE_PARITY=1`): it reads
//! the person's real provider configuration and starts their real MCP servers' health checks.
//! It never signs in, never uses AI quota and never writes the native configuration.
//!
//! For each installed provider it runs `<cli> mcp list` twice: once with the person's own
//! environment (native), and once with exactly the environment and account profile KalCode
//! gives a managed account session ([`ManagedProfiles::launch_env`]) in a scratch profile root.
//! The configured servers must match. Account-bound servers are excluded because they come
//! from the signed-in account, which the scratch profile deliberately doesn't have: Claude's
//! claude.ai connectors, and servers from Codex plugins (Codex lists plugin servers only for a
//! signed-in ChatGPT account: a mirror of the whole native Codex home without `auth.json`
//! doesn't list them either).
//!
//! ```text
//! KALCODE_NATIVE_PARITY=1 cargo test -p kalcode-providers --test native_parity_real -- --ignored --nocapture
//! ```

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use kalcode_providers::DetectEnv;
use kalcode_providers::codex::managed_policy::CloudConfigEligibility;
use kalcode_providers::managed::ManagedProfiles;

/// Profile selectors a terminal inside KalCode may carry. KalCode itself starts without them.
const SELECTORS: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CODEX_HOME",
    "GEMINI_CLI_HOME",
];

#[test]
#[ignore = "reads the real provider configuration; run with KALCODE_NATIVE_PARITY=1"]
fn managed_sessions_see_the_same_configuration_as_native_terminals() {
    if std::env::var_os("KALCODE_NATIVE_PARITY").is_none() {
        eprintln!("skipped: set KALCODE_NATIVE_PARITY=1");
        return;
    }
    let mut source = DetectEnv::from_process();
    source.vars.retain(|(name, _)| {
        !SELECTORS
            .iter()
            .any(|selector| name.to_string_lossy().eq_ignore_ascii_case(selector))
    });
    let native_env: BTreeMap<OsString, OsString> = source.vars.iter().cloned().collect();
    // Not under %TEMP%: Codex refuses to create its PATH helpers in a temporary directory, and
    // real profiles live in the application data directory.
    let scratch = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).expect("scratch");
    let profiles = ManagedProfiles::new(scratch.path().join("profiles")).expect("profiles");
    let workspace = std::env::current_dir().expect("workspace");

    let mut compared = 0;
    for (provider, cli) in [
        ("claude-code", "claude"),
        ("codex", "codex"),
        ("gemini-cli", "gemini"),
    ] {
        let Some(program) = find_program(cli, &native_env) else {
            eprintln!("{cli}: not installed, skipped");
            continue;
        };
        let account = uuid::Uuid::new_v4().hyphenated().to_string();
        if provider == "claude-code" {
            // A connected account's profile always has Claude's own `.claude.json`.
            let home = profiles.profile_home(provider, &account).expect("home");
            std::fs::write(
                home.join(".claude.json"),
                r#"{"hasCompletedOnboarding":true}"#,
            )
            .expect("connected profile");
        }
        // Exactly what each provider's managed session start prepares.
        let managed_env = match provider {
            "codex" => {
                kalcode_providers::codex::managed_policy::prepare_session(
                    &profiles,
                    &source,
                    &account,
                    &workspace,
                    CloudConfigEligibility::Ineligible,
                )
                .expect("codex session")
                .env
            }
            "gemini-cli" => {
                kalcode_providers::gemini::managed_policy::ManagedGeminiLaunch::prepare(
                    &profiles,
                    &source,
                    &account,
                    &uuid::Uuid::new_v4().hyphenated().to_string(),
                    &workspace,
                    kalcode_contracts::permissions::PermissionMode::Plan,
                )
                .expect("gemini session")
                .environment()
                .clone()
            }
            _ => profiles
                .launch_env(provider, &account, &source)
                .expect("managed environment"),
        };
        let native = servers(cli, &mcp_list(&program, &native_env, &workspace));
        let managed_output = mcp_list(&program, &managed_env, &workspace);
        let managed = servers(cli, &managed_output);
        if std::env::var_os("KALCODE_NATIVE_PARITY_VERBOSE").is_some() {
            eprintln!(
                "{cli}: KalCode output:
{managed_output}"
            );
        }
        eprintln!("{cli}: native {native:?}");
        eprintln!("{cli}: KalCode {managed:?}");
        let home = profiles.profile_home(provider, &account).expect("home");
        unlink_shared_dirs(&home);
        unlink_shared_dirs(&home.join(".gemini"));
        assert_eq!(managed, native, "{cli}: MCP servers differ inside KalCode");
        compared += 1;
    }
    assert!(compared > 0, "no provider CLI is installed");
}

fn mcp_list(program: &Path, env: &BTreeMap<OsString, OsString>, cwd: &Path) -> String {
    let output = Command::new(program)
        .args(["mcp", "list"])
        .env_clear()
        .envs(env)
        .current_dir(cwd)
        .output()
        .expect("run mcp list");
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// Configured server names from `<cli> mcp list`.
fn servers(cli: &str, output: &str) -> BTreeSet<String> {
    let lines = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    match cli {
        // `name: command-or-url - status`
        "claude" => lines
            .filter_map(|line| line.split_once(": ").map(|(name, _)| name.to_owned()))
            .filter(|name| !name.starts_with("claude.ai ") && !name.contains(' '))
            .collect(),
        // A table whose first column is the server name, after a `Name ...` header.
        "codex" => lines
            .skip_while(|line| !line.starts_with("Name"))
            .skip(1)
            .filter(|line| {
                !line.starts_with("WARNING")
                    && !line.contains("plugins/cache")
                    && !line.contains(r"plugins\cache")
            })
            .filter_map(|line| line.split_whitespace().next().map(str::to_owned))
            .collect(),
        // `✓ name: command (stdio) - Connected`, or a "No MCP servers configured" notice.
        _ => lines
            .filter_map(|line| {
                let (head, _) = line.split_once(": ")?;
                head.split_whitespace().last().map(str::to_owned)
            })
            .collect(),
    }
}

/// Removes the profile's links to native directories before the scratch root is deleted, so
/// cleanup can never reach the person's real configuration.
fn unlink_shared_dirs(home: &Path) {
    let Ok(entries) = std::fs::read_dir(home) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if is_link(&metadata) {
            let removed = if cfg!(windows) {
                std::fs::remove_dir(&path)
            } else {
                std::fs::remove_file(&path)
            };
            removed.expect("unlink");
        }
    }
}

#[cfg(windows)]
fn is_link(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_link(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn find_program(name: &str, env: &BTreeMap<OsString, OsString>) -> Option<PathBuf> {
    let path = env
        .iter()
        .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value.clone())?;
    let extensions: &[&str] = if cfg!(windows) {
        &[".exe", ".cmd"]
    } else {
        &[""]
    };
    std::env::split_paths(&path)
        .flat_map(|dir| {
            extensions
                .iter()
                .map(move |ext| dir.join(format!("{name}{ext}")))
        })
        .find(|candidate| candidate.is_file())
}
