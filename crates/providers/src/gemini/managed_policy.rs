//! Managed Gemini CLI 0.61 launch policy.
//!
//! A managed session is the user's own Gemini CLI in the real workspace (native provider
//! parity): user and workspace settings, `GEMINI.md`, MCP servers, extensions, skills, agents,
//! policies and administrator system settings apply exactly as in a native terminal, and the
//! permission mode reaches Gemini through its own `--approval-mode`. What KalCode adds is the
//! account boundary: `GEMINI_CLI_HOME` selects the account's profile (which
//! [`crate::native_config`] fills with the user's native configuration) and credentials stay in
//! that profile's own encrypted store.
//!
//! Sign-in is narrower: it only lets Gemini authenticate and exit, so it runs from a neutral
//! directory with a read-only floor and no MCP servers or extensions.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use kalcode_contracts::agent::{ProviderError, ProviderId};
use kalcode_contracts::permissions::PermissionMode;

use crate::detect::DetectEnv;
use crate::managed::{ManagedProfiles, ProfileLease, plain_path};

const UNSAFE_MANAGED_PATH: &str =
    "Gemini's managed launch files are not ordinary files inside the managed profile";
const UNEXPECTED_NEUTRAL_POLICY: &str = "Gemini's managed policy directory contains an unexpected policy; repair the provider profile before launching";

const PLAN_CORE_TOOLS: &[&str] = &["list_directory", "read_file", "grep_search", "glob"];
const PLAN_AUTHORITY_TOOLS: &[&str] = &[
    "run_shell_command",
    "replace",
    "write_file",
    "enter_plan_mode",
    "exit_plan_mode",
    "invoke_agent",
    "activate_skill",
    "web_fetch",
    "google_web_search",
    "read_mcp_resource",
    "list_mcp_resources",
];

//// Profile-scoped launch material shared by headless sessions and interactive panes.
///
/// A managed session runs in the real workspace with the user's native Gemini configuration
/// (native provider parity): user and workspace settings, `GEMINI.md`, MCP servers, extensions,
/// skills, agents, policies and administrator system settings all apply as in a native terminal.
/// Only the account boundary differs: `GEMINI_CLI_HOME` selects this account's profile and its
/// credentials stay in that profile's own encrypted store.
///
/// Callers must retain the returned profile lease for the provider session's lifetime. Headless
/// callers pass it to `managed::hold_session_lease`; PTY callers keep it in their session state.
pub struct ManagedGeminiLaunch {
    environment: BTreeMap<OsString, OsString>,
    cwd: PathBuf,
    security_args: Vec<OsString>,
    lease: Option<ProfileLease>,
}

impl ManagedGeminiLaunch {
    /// Prepares a session for `workspace`. The permission mode reaches Gemini through its own
    /// `--approval-mode` (see [`crate::gemini::argv`]).
    pub fn prepare(
        profiles: &ManagedProfiles,
        source: &DetectEnv,
        account_id: &str,
        _thread_id: &str,
        workspace: &Path,
        _mode: PermissionMode,
    ) -> Result<Self, ProviderError> {
        let workspace = canonical_workspace(workspace)?;
        let lease = profiles.acquire_session_lease(ProviderId::GEMINI_CLI, account_id)?;
        let mut environment = profiles.launch_env(ProviderId::GEMINI_CLI, account_id, source)?;
        // KalCode opened this workspace on the user's behalf, so it is trusted without a prompt
        // (AGENTS.md permission UX rule), as `--skip-trust` also says on argv.
        insert_env(&mut environment, "GEMINI_CLI_TRUST_WORKSPACE", "true");
        select_credential_storage(&mut environment);
        insert_env(&mut environment, DEFAULT_AUTH_ENV, "true");
        Ok(Self {
            environment,
            // Node.js and `cmd.exe` do not accept a verbatim (`\\?\`) working directory.
            cwd: plain_path(&workspace),
            security_args: vec!["--skip-trust".into()],
            lease: Some(lease),
        })
    }

    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    pub fn environment(&self) -> &BTreeMap<OsString, OsString> {
        &self.environment
    }

    pub fn security_args(&self) -> &[OsString] {
        &self.security_args
    }

    /// Moves the account lease to the runtime that owns the provider process.
    pub fn take_session_lease(&mut self) -> Result<ProfileLease, ProviderError> {
        self.lease.take().ok_or_else(|| {
            ProviderError::Start("the managed Gemini profile lease was already transferred".into())
        })
    }

    /// Appends the launch's Gemini CLI flags.
    pub fn append_security_args(&self, args: &mut Vec<OsString>) -> Result<(), ProviderError> {
        args.extend(self.security_args.iter().cloned());
        Ok(())
    }
}

/// Gemini CLI 0.61.0's documented environment selector for its "Sign in with Google" auth type.
/// Gemini consults it only when no auth type is saved in the profile's own settings, so an
/// explicit provider-side choice still wins. KalCode's system settings files cannot carry this
/// default: Gemini skips system settings whose directory is not administrator/root owned, which
/// a per-user managed profile never is.
pub const DEFAULT_AUTH_ENV: &str = "GOOGLE_GENAI_USE_GCA";

/// Selects Gemini CLI 0.61.0's encrypted, per-profile credential storage for every managed process
/// (sign-in, headless turns and panes alike, so all of them read and write the same store):
///
/// - `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true`: Google sign-in is saved through Gemini's keychain
///   service (`OAuthCredentialStorage`) instead of the plaintext
///   `<GEMINI_CLI_HOME>/.gemini/oauth_creds.json` Gemini writes otherwise; Gemini also migrates an
///   existing plaintext file into that store and deletes it on first load.
/// - `GEMINI_FORCE_FILE_STORAGE=true`: that keychain service uses Gemini's own AES-256-GCM
///   `FileKeychain` at `<GEMINI_CLI_HOME>/.gemini/gemini-credentials.json`, never the OS keychain,
///   whose single per-user service/account would be shared by every KalCode profile.
fn select_credential_storage(environment: &mut BTreeMap<OsString, OsString>) {
    insert_env(environment, "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE", "true");
    insert_env(environment, "GEMINI_FORCE_FILE_STORAGE", "true");
}

/// Flags for the managed sign-in process. Every path Gemini receives is in its plain form
/// (see [`plain_path`]): Gemini CLI 0.61.0 is Node.js and does not handle Windows verbatim paths
/// consistently. `--ignore-env` is deliberately absent: Gemini CLI
/// 0.61.0 rejects it as an unknown argument. The neutral floor's `advanced.ignoreLocalEnv` setting
/// is the supported equivalent (Gemini reads it from the trusted, merged neutral settings before
/// loading any `.env` file).
fn profile_security_args(
    mcp_sentinel: &str,
    policy_dir: &Path,
    admin_policy_dir: &Path,
) -> Vec<OsString> {
    vec![
        "--skip-trust".into(),
        "--allowed-mcp-server-names".into(),
        mcp_sentinel.into(),
        "--policy".into(),
        plain_path(policy_dir).into_os_string(),
        "--admin-policy".into(),
        plain_path(admin_policy_dir).into_os_string(),
        "--extensions".into(),
        "none".into(),
    ]
}

/// Launch material for one account's official Gemini sign-in, and nothing else.
///
/// The process runs from a neutral directory inside the account's managed profile (never a
/// repository; no include directories), with the read-only Plan floor, no MCP servers,
/// extensions, hooks or skills, and the same profile selector (`GEMINI_CLI_HOME`) as the
/// account's threads. `--list-extensions` makes Gemini finish its own startup authentication
/// and then exit before any model request or tool registry can run. The caller must hold the
/// account's exclusive sign-in lease for the whole process lifetime.
pub struct ManagedGeminiSignIn {
    environment: BTreeMap<OsString, OsString>,
    cwd: PathBuf,
    args: Vec<OsString>,
}

impl ManagedGeminiSignIn {
    pub fn prepare(
        profiles: &ManagedProfiles,
        source: &DetectEnv,
        account_id: &str,
        lease: &ProfileLease,
    ) -> Result<Self, ProviderError> {
        if !lease.is_exclusive_for(profiles, ProviderId::GEMINI_CLI, account_id) {
            return Err(ProviderError::Start(
                "Gemini sign-in requires this account's exclusive profile lease".into(),
            ));
        }
        let root = profiles.sign_in_dir(ProviderId::GEMINI_CLI, account_id)?;
        let cwd = ensure_child_directory(&root, "neutral")?;
        let gemini_dir = ensure_child_directory(&cwd, ".gemini")?;
        let neutral_policy_dir = ensure_child_directory(&gemini_dir, "policies")?;
        let policy_dir = ensure_child_directory(&root, "managed-policy")?;
        let admin_policy_dir = ensure_child_directory(&root, "managed-admin-policy")?;
        let system_settings_path = root.join("system-settings.json");
        let system_defaults_path = root.join("system-defaults.json");
        require_empty_directory(&neutral_policy_dir)?;
        require_empty_directory(&policy_dir)?;
        require_empty_directory(&admin_policy_dir)?;
        write_controlled_file(&system_settings_path, b"{}\n")?;
        write_controlled_file(&system_defaults_path, b"{}\n")?;
        write_controlled_file(
            &gemini_dir.join("settings.json"),
            &floor_settings(PermissionMode::Plan)?,
        )?;

        let mut environment = profiles.launch_env(ProviderId::GEMINI_CLI, account_id, source)?;
        insert_env(&mut environment, "GEMINI_CLI_TRUST_WORKSPACE", "true");
        insert_env(
            &mut environment,
            "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
            plain_path(&system_settings_path),
        );
        insert_env(
            &mut environment,
            "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
            plain_path(&system_defaults_path),
        );
        select_credential_storage(&mut environment);
        insert_env(&mut environment, DEFAULT_AUTH_ENV, "true");
        // The browser flow is the only sign-in this session may use: a suppressed browser would
        // switch Gemini to its interactive user-code flow, which a non-TTY process cannot answer.
        remove_env(&mut environment, "NO_BROWSER");

        let mcp_sentinel = format!("kalcode-no-mcp-{}", uuid::Uuid::new_v4());
        let mut args = profile_security_args(&mcp_sentinel, &policy_dir, &admin_policy_dir);
        args.push("--list-extensions".into());
        Ok(Self {
            environment,
            cwd,
            args,
        })
    }

    pub fn environment(&self) -> &BTreeMap<OsString, OsString> {
        &self.environment
    }

    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    pub fn args(&self) -> &[OsString] {
        &self.args
    }
}

fn floor_settings(mode: PermissionMode) -> Result<Vec<u8>, ProviderError> {
    let mut tools = serde_json::Map::from_iter([
        ("allowed".into(), serde_json::json!([])),
        ("discoveryCommand".into(), serde_json::json!("")),
        ("callCommand".into(), serde_json::json!("")),
    ]);
    if mode == PermissionMode::Plan {
        tools.insert("core".into(), serde_json::json!(PLAN_CORE_TOOLS));
        tools.insert("exclude".into(), serde_json::json!(PLAN_AUTHORITY_TOOLS));
    }
    let value = serde_json::json!({
        "tools": tools,
        "hooksConfig": { "enabled": false },
        "skills": { "enabled": false },
        "security": {
            // Bypass runs Gemini's yolo mode (owner directive 2026-10-03: no approvals).
            "disableYoloMode": mode != PermissionMode::Bypass,
            "disableAlwaysAllow": true
        },
        "mcpServers": {},
        "mcp": {
            "excluded": ["*"],
            "serverCommand": ""
        },
        "context": {
            "includeDirectories": [],
            "loadMemoryFromIncludeDirectories": false
        },
        "advanced": { "ignoreLocalEnv": true },
        "experimental": {
            "enableAgents": false,
            "extensionReloading": false
        }
    });
    let mut bytes = serde_json::to_vec_pretty(&value).map_err(|error| {
        ProviderError::Start(format!("couldn't encode Gemini settings: {error}"))
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn canonical_workspace(path: &Path) -> Result<PathBuf, ProviderError> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(ProviderError::Start(
            "the Gemini workspace must be an existing absolute directory".into(),
        ));
    }
    std::fs::canonicalize(path).map_err(|error| {
        ProviderError::Io(format!("couldn't resolve the Gemini workspace: {error}"))
    })
}

fn ensure_child_directory(parent: &Path, name: &str) -> Result<PathBuf, ProviderError> {
    if name.is_empty() || name == "." || name == ".." || Path::new(name).components().count() != 1 {
        return Err(ProviderError::Start(UNSAFE_MANAGED_PATH.into()));
    }
    verify_directory(parent)?;
    let parent = std::fs::canonicalize(parent).map_err(|error| {
        ProviderError::Io(format!("couldn't resolve managed Gemini storage: {error}"))
    })?;
    let child = parent.join(name);
    match std::fs::symlink_metadata(&child) {
        Ok(metadata) => verify_directory_metadata(&metadata)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            create_private_directory(&child)?;
        }
        Err(error) => {
            return Err(ProviderError::Io(format!(
                "couldn't inspect managed Gemini storage: {error}"
            )));
        }
    }
    verify_directory(&child)?;
    let canonical = std::fs::canonicalize(&child).map_err(|error| {
        ProviderError::Io(format!("couldn't resolve managed Gemini storage: {error}"))
    })?;
    if canonical.parent() != Some(parent.as_path()) {
        return Err(ProviderError::Start(UNSAFE_MANAGED_PATH.into()));
    }
    Ok(canonical)
}

fn require_empty_directory(path: &Path) -> Result<(), ProviderError> {
    verify_directory(path)?;
    let mut entries = std::fs::read_dir(path)
        .map_err(|_| ProviderError::Start(UNEXPECTED_NEUTRAL_POLICY.into()))?;
    match entries.next() {
        None => Ok(()),
        Some(_) => Err(ProviderError::Start(UNEXPECTED_NEUTRAL_POLICY.into())),
    }
}

fn write_controlled_file(path: &Path, bytes: &[u8]) -> Result<(), ProviderError> {
    let parent = path
        .parent()
        .ok_or_else(|| ProviderError::Start(UNSAFE_MANAGED_PATH.into()))?;
    verify_directory(parent)?;
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => verify_file_metadata(&metadata)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(ProviderError::Io(format!(
                "couldn't inspect a managed Gemini file: {error}"
            )));
        }
    }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| {
        ProviderError::Io(format!("couldn't write a managed Gemini file: {error}"))
    })?;
    verify_file_metadata(&file.metadata().map_err(|error| {
        ProviderError::Io(format!("couldn't inspect a managed Gemini file: {error}"))
    })?)?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| {
            ProviderError::Io(format!("couldn't persist a managed Gemini file: {error}"))
        })
}

fn insert_env(env: &mut BTreeMap<OsString, OsString>, name: &str, value: impl AsRef<OsStr>) {
    remove_env(env, name);
    env.insert(name.into(), value.as_ref().to_os_string());
}

fn remove_env(env: &mut BTreeMap<OsString, OsString>, name: &str) {
    env.retain(|key, _| {
        !key.to_str()
            .is_some_and(|key| key.eq_ignore_ascii_case(name))
    });
}

fn verify_directory(path: &Path) -> Result<(), ProviderError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        ProviderError::Io(format!("couldn't inspect managed Gemini storage: {error}"))
    })?;
    verify_directory_metadata(&metadata)
}

fn verify_directory_metadata(metadata: &std::fs::Metadata) -> Result<(), ProviderError> {
    if metadata.is_dir() && !is_link_or_reparse(metadata) {
        Ok(())
    } else {
        Err(ProviderError::Start(UNSAFE_MANAGED_PATH.into()))
    }
}

fn verify_file_metadata(metadata: &std::fs::Metadata) -> Result<(), ProviderError> {
    if metadata.is_file() && !is_link_or_reparse(metadata) {
        Ok(())
    } else {
        Err(ProviderError::Start(UNSAFE_MANAGED_PATH.into()))
    }
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> Result<(), ProviderError> {
    use std::os::unix::fs::DirBuilderExt;

    let mut builder = std::fs::DirBuilder::new();
    builder.mode(0o700);
    builder.create(path).map_err(|error| {
        ProviderError::Io(format!("couldn't create managed Gemini storage: {error}"))
    })
}

#[cfg(not(unix))]
fn create_private_directory(path: &Path) -> Result<(), ProviderError> {
    std::fs::create_dir(path).map_err(|error| {
        ProviderError::Io(format!("couldn't create managed Gemini storage: {error}"))
    })
}

#[cfg(test)]
mod tests {
    use std::ffi::{OsStr, OsString};
    use std::path::Path;
    use std::time::Duration;

    use kalcode_contracts::permissions::PermissionMode;

    use super::*;
    use crate::detect::DetectEnv;
    use crate::managed::ManagedProfiles;

    const REPO_SETTINGS: &str = r#"{"mcpServers":{"repo":{"command":"repo-mcp"}}}"#;
    const PROFILE_SETTINGS: &str = r#"{"mcpServers":{"profile":{"command":"profile-mcp"}}}"#;

    fn source(temp: &Path) -> DetectEnv {
        DetectEnv {
            vars: vec![
                ("HOME".into(), temp.join("person").into_os_string()),
                ("USERPROFILE".into(), temp.join("person").into_os_string()),
                ("PATH".into(), temp.as_os_str().to_os_string()),
                ("GEMINI_API_KEY".into(), "synthetic-secret".into()),
                ("GEMINI_FORCE_ENCRYPTED_FILE_STORAGE".into(), "true".into()),
                ("GEMINI_FORCE_FILE_STORAGE".into(), "true".into()),
                ("GEMINI_CLI_TRUST_WORKSPACE".into(), "false".into()),
                ("SSH_AUTH_SOCK".into(), "/tmp/agent.sock".into()),
            ],
            windows: cfg!(windows),
            probe_timeout: Some(Duration::from_millis(10)),
            system_root: None,
        }
    }

    fn env_value<'a>(launch: &'a ManagedGeminiLaunch, name: &str) -> Option<&'a OsStr> {
        launch.environment().iter().find_map(|(key, value)| {
            key.to_str()
                .is_some_and(|key| key.eq_ignore_ascii_case(name))
                .then_some(value.as_os_str())
        })
    }

    fn strings(values: &[OsString]) -> Vec<String> {
        values
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect()
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        profiles: ManagedProfiles,
        source: DetectEnv,
        account_id: String,
        thread_id: String,
        workspace: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().expect("temp");
            let temp_root = if cfg!(target_os = "macos") {
                temp.path().canonicalize().expect("canonical temp")
            } else {
                temp.path().to_path_buf()
            };
            let person = temp_root.join("person");
            let workspace = temp_root.join("repo");
            std::fs::create_dir_all(&person).expect("person");
            std::fs::create_dir_all(workspace.join(".gemini")).expect("repo config");
            std::fs::write(workspace.join(".gemini/settings.json"), REPO_SETTINGS)
                .expect("repo settings");
            let profiles =
                ManagedProfiles::new(temp_root.join("managed")).expect("managed profiles");
            let account_id = kalcode_contracts::ids::new_id();
            let thread_id = kalcode_contracts::ids::new_id();
            let profile = profiles
                .profile_home("gemini-cli", &account_id)
                .expect("profile");
            std::fs::create_dir_all(profile.join(".gemini")).expect("profile config");
            std::fs::write(profile.join(".gemini/settings.json"), PROFILE_SETTINGS)
                .expect("profile settings");
            let source = source(&temp_root);
            Self {
                _temp: temp,
                profiles,
                source,
                account_id,
                thread_id,
                workspace,
            }
        }

        fn prepare(
            &self,
            mode: PermissionMode,
        ) -> Result<ManagedGeminiLaunch, kalcode_contracts::agent::ProviderError> {
            ManagedGeminiLaunch::prepare(
                &self.profiles,
                &self.source,
                &self.account_id,
                &self.thread_id,
                &self.workspace,
                mode,
            )
        }
    }

    #[test]
    fn sessions_run_in_the_real_workspace_with_the_users_configuration() {
        let fixture = Fixture::new();
        let launch = fixture
            .prepare(PermissionMode::Plan)
            .expect("managed launch");

        assert_eq!(
            launch.cwd(),
            plain_path(&std::fs::canonicalize(&fixture.workspace).expect("workspace"))
        );
        assert!(!launch.cwd().to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(strings(launch.security_args()), ["--skip-trust"]);

        // The workspace's and the profile's own settings are the provider's, never rewritten.
        assert_eq!(
            std::fs::read_to_string(fixture.workspace.join(".gemini/settings.json"))
                .expect("repo settings"),
            REPO_SETTINGS
        );
        let home = fixture
            .profiles
            .profile_home("gemini-cli", &fixture.account_id)
            .expect("profile home");
        assert_eq!(
            std::fs::read_to_string(home.join(".gemini/settings.json")).expect("profile"),
            PROFILE_SETTINGS
        );

        let selected = env_value(&launch, "GEMINI_CLI_HOME").expect("profile selector");
        assert!(
            !selected.to_string_lossy().starts_with(r"\\?\"),
            "Gemini crashes on a verbatim home"
        );
        assert_eq!(
            std::fs::canonicalize(selected).expect("selected home"),
            home
        );
        for (name, value) in [
            ("GEMINI_FORCE_ENCRYPTED_FILE_STORAGE", "true"),
            ("GEMINI_FORCE_FILE_STORAGE", "true"),
            ("GEMINI_CLI_TRUST_WORKSPACE", "true"),
            (DEFAULT_AUTH_ENV, "true"),
            ("SSH_AUTH_SOCK", "/tmp/agent.sock"),
        ] {
            assert_eq!(env_value(&launch, name), Some(OsStr::new(value)), "{name}");
        }
        // Another identity's key never reaches the account's session, and administrator system
        // settings are not redirected.
        for absent in [
            "GEMINI_API_KEY",
            "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
            "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
        ] {
            assert!(env_value(&launch, absent).is_none(), "{absent}");
        }
    }

    #[test]
    fn every_mode_launches_the_same_way_and_leaves_approvals_to_gemini() {
        let fixture = Fixture::new();
        let plan = strings(
            fixture
                .prepare(PermissionMode::Plan)
                .expect("plan")
                .security_args(),
        );
        for mode in [
            PermissionMode::Approve,
            PermissionMode::Auto,
            PermissionMode::Bypass,
        ] {
            let launch = fixture.prepare(mode).expect("launch");
            assert_eq!(strings(launch.security_args()), plan, "{mode:?}");
            let mut args = Vec::new();
            launch.append_security_args(&mut args).expect("args");
            assert_eq!(strings(&args), plan);
        }
    }

    #[test]
    fn the_session_lease_moves_to_the_runtime_once() {
        let fixture = Fixture::new();
        let mut launch = fixture.prepare(PermissionMode::Auto).expect("launch");
        let lease = launch.take_session_lease().expect("lease");
        assert!(launch.take_session_lease().is_err());
        assert!(
            fixture
                .profiles
                .acquire_sign_in_lease("gemini-cli", &fixture.account_id)
                .is_err(),
            "sign-in waits for the running session"
        );
        drop(lease);
    }

    fn sign_in_env<'a>(sign_in: &'a ManagedGeminiSignIn, name: &str) -> Option<&'a OsStr> {
        sign_in.environment().iter().find_map(|(key, value)| {
            key.to_str()
                .is_some_and(|key| key.eq_ignore_ascii_case(name))
                .then_some(value.as_os_str())
        })
    }

    #[test]
    fn sign_in_uses_only_the_account_profile_and_never_a_workspace() {
        let fixture = Fixture::new();
        let other_account = kalcode_contracts::ids::new_id();
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("gemini-cli", &fixture.account_id)
            .expect("exclusive lease");
        let sign_in = ManagedGeminiSignIn::prepare(
            &fixture.profiles,
            &fixture.source,
            &fixture.account_id,
            &lease,
        )
        .expect("sign-in launch");

        let home = fixture
            .profiles
            .profile_home("gemini-cli", &fixture.account_id)
            .expect("profile home");
        let selected = sign_in_env(&sign_in, "GEMINI_CLI_HOME").expect("profile selector");
        assert!(
            !selected.to_string_lossy().starts_with(r"\\?\"),
            "Gemini crashes on a verbatim home"
        );
        let selected = std::fs::canonicalize(selected).expect("selected home");
        assert_eq!(selected, home);
        assert_ne!(
            selected,
            fixture
                .profiles
                .profile_home("gemini-cli", &other_account)
                .expect("other home")
        );
        for (name, value) in [
            ("GEMINI_FORCE_ENCRYPTED_FILE_STORAGE", "true"),
            ("GEMINI_FORCE_FILE_STORAGE", "true"),
            ("GEMINI_CLI_TRUST_WORKSPACE", "true"),
            (DEFAULT_AUTH_ENV, "true"),
        ] {
            assert_eq!(
                sign_in_env(&sign_in, name),
                Some(OsStr::new(value)),
                "{name}"
            );
        }
        for forbidden in ["GEMINI_API_KEY", "NO_BROWSER"] {
            assert!(
                sign_in_env(&sign_in, forbidden).is_none(),
                "inherited {forbidden}"
            );
        }

        let sign_in_root = fixture
            .profiles
            .sign_in_dir("gemini-cli", &fixture.account_id)
            .expect("sign-in dir");
        assert!(sign_in.cwd().starts_with(&sign_in_root));
        assert!(!sign_in.cwd().starts_with(&fixture.workspace));
        let settings: serde_json::Value = serde_json::from_slice(
            &std::fs::read(sign_in.cwd().join(".gemini/settings.json")).expect("floor"),
        )
        .expect("floor json");
        assert_eq!(
            settings["tools"]["core"],
            serde_json::json!(PLAN_CORE_TOOLS),
            "sign-in runs with the read-only floor"
        );
        assert_eq!(settings["advanced"]["ignoreLocalEnv"], true);

        let args = strings(sign_in.args());
        assert_eq!(args.last().map(String::as_str), Some("--list-extensions"));
        for forbidden in [
            "--include-directories",
            "--ignore-env",
            "--yolo",
            "--prompt",
            "-p",
        ] {
            assert!(!args.iter().any(|arg| arg == forbidden), "{args:?}");
        }
        let workspace = fixture.workspace.to_string_lossy().into_owned();
        assert!(
            !args.iter().any(|arg| arg.contains(&workspace)),
            "no workspace path reaches the sign-in process: {args:?}"
        );
        for expected in ["--skip-trust", "--allowed-mcp-server-names", "--extensions"] {
            assert!(args.iter().any(|arg| arg == expected), "{args:?}");
        }
    }

    #[test]
    fn sign_in_requires_this_accounts_exclusive_lease() {
        let fixture = Fixture::new();
        let other_account = kalcode_contracts::ids::new_id();
        let prepare = |lease: &ProfileLease| {
            ManagedGeminiSignIn::prepare(
                &fixture.profiles,
                &fixture.source,
                &fixture.account_id,
                lease,
            )
        };
        let shared = fixture
            .profiles
            .acquire_session_lease("gemini-cli", &fixture.account_id)
            .expect("shared lease");
        assert!(
            prepare(&shared).is_err(),
            "a shared session lease cannot authorize sign-in"
        );
        drop(shared);
        let unrelated = fixture
            .profiles
            .acquire_sign_in_lease("gemini-cli", &other_account)
            .expect("other lease");
        assert!(
            prepare(&unrelated).is_err(),
            "another account's lease cannot authorize this account's sign-in"
        );
        let claude = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", &fixture.account_id)
            .expect("claude lease");
        assert!(
            prepare(&claude).is_err(),
            "another provider's lease cannot authorize Gemini sign-in"
        );
    }
}
