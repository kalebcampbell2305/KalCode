//! Managed Gemini CLI 0.61 launch policy.
//!
//! Gemini loads workspace settings before parsing `--skip-trust`, deep-merges profile MCP
//! configuration, and always considers its platform system-policy directory. A managed launch
//! therefore runs from a stable neutral directory outside the repository, sets trust before the
//! process starts, pins policy/MCP inputs on argv, and recreates the neutral floor before every
//! headless turn. The actual repository is an include directory, not the settings authority.
//!
//! Plan mode is an execution-authority boundary, not a secret-file privacy boundary: its four
//! core read tools can read paths in the included repository. Context Firewall/secret handling
//! must provide any stronger content boundary above this adapter.

use std::collections::{BTreeMap, VecDeque};
use std::ffi::{OsStr, OsString};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use kalcode_contracts::agent::{ProviderError, ProviderId};
use kalcode_contracts::permissions::PermissionMode;

use crate::detect::DetectEnv;
use crate::managed::{ManagedProfiles, ProfileLease, plain_path};

const MAX_SYSTEM_POLICY_ENTRIES: usize = 4_096;
const UNSAFE_MANAGED_PATH: &str =
    "Gemini's managed launch files are not ordinary files inside the managed profile";
const UNEXPECTED_NEUTRAL_POLICY: &str = "Gemini's managed policy directory contains an unexpected policy; repair the provider profile before launching";
const SYSTEM_POLICY_BLOCKER: &str = "Gemini system policy files are present or could not be inspected safely; KalCode cannot verify its managed permission boundary";

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

/// Complete profile-scoped launch material shared by headless sessions and interactive panes.
///
/// Callers must retain the returned profile lease for the provider session's lifetime. Headless
/// callers pass it to `managed::hold_session_lease`; PTY callers keep it in their session state.
pub struct ManagedGeminiLaunch {
    environment: BTreeMap<OsString, OsString>,
    cwd: PathBuf,
    security_args: Vec<OsString>,
    settings_path: PathBuf,
    system_settings_path: PathBuf,
    system_defaults_path: PathBuf,
    neutral_policy_dir: PathBuf,
    policy_dir: PathBuf,
    admin_policy_dir: PathBuf,
    system_policies_dir: PathBuf,
    floor: Vec<u8>,
    mcp_sentinel: String,
    lease: Option<ProfileLease>,
}

impl ManagedGeminiLaunch {
    /// Builds a launch against Gemini's actual platform system-policy directory.
    pub fn prepare(
        profiles: &ManagedProfiles,
        source: &DetectEnv,
        account_id: &str,
        thread_id: &str,
        workspace: &Path,
        mode: PermissionMode,
    ) -> Result<Self, ProviderError> {
        Self::prepare_with_system_policies(
            profiles,
            source,
            account_id,
            thread_id,
            workspace,
            mode,
            &platform_system_policies_dir(),
        )
    }

    fn prepare_with_system_policies(
        profiles: &ManagedProfiles,
        source: &DetectEnv,
        account_id: &str,
        thread_id: &str,
        workspace: &Path,
        mode: PermissionMode,
        system_policies_dir: &Path,
    ) -> Result<Self, ProviderError> {
        let workspace = canonical_workspace(workspace)?;
        inspect_system_policies(system_policies_dir)?;
        let lease = profiles.acquire_session_lease(ProviderId::GEMINI_CLI, account_id)?;
        let session = profiles.session_dir(ProviderId::GEMINI_CLI, account_id, thread_id)?;
        let cwd = ensure_child_directory(&session, "neutral")?;
        let gemini_dir = ensure_child_directory(&cwd, ".gemini")?;
        let neutral_policy_dir = ensure_child_directory(&gemini_dir, "policies")?;
        let policy_dir = ensure_child_directory(&session, "managed-policy")?;
        let admin_policy_dir = ensure_child_directory(&session, "managed-admin-policy")?;
        let settings_path = gemini_dir.join("settings.json");
        let system_settings_path = session.join("system-settings.json");
        let system_defaults_path = session.join("system-defaults.json");

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

        let mcp_sentinel = format!("kalcode-no-mcp-{}", uuid::Uuid::new_v4());
        let mut security_args = vec![
            "--include-directories".into(),
            plain_path(&workspace).into_os_string(),
        ];
        security_args.extend(profile_security_args(
            &mcp_sentinel,
            &policy_dir,
            &admin_policy_dir,
        ));
        let floor = floor_settings(mode)?;
        let launch = Self {
            environment,
            cwd,
            security_args,
            settings_path,
            system_settings_path,
            system_defaults_path,
            neutral_policy_dir,
            policy_dir,
            admin_policy_dir,
            system_policies_dir: system_policies_dir.to_path_buf(),
            floor,
            mcp_sentinel,
            lease: Some(lease),
        };
        launch.refresh()?;
        Ok(launch)
    }

    /// Re-establishes the immutable floor immediately before a process starts. An unexpected
    /// policy fails closed instead of being deleted or silently accepted.
    pub fn refresh(&self) -> Result<(), ProviderError> {
        inspect_system_policies(&self.system_policies_dir)?;
        require_empty_directory(&self.neutral_policy_dir)?;
        require_empty_directory(&self.policy_dir)?;
        require_empty_directory(&self.admin_policy_dir)?;
        write_controlled_file(&self.system_settings_path, b"{}\n")?;
        write_controlled_file(&self.system_defaults_path, b"{}\n")?;
        write_controlled_file(&self.settings_path, &self.floor)?;
        Ok(())
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

    pub fn settings_path(&self) -> &Path {
        &self.settings_path
    }

    pub fn neutral_policy_dir(&self) -> &Path {
        &self.neutral_policy_dir
    }

    pub fn mcp_sentinel(&self) -> &str {
        &self.mcp_sentinel
    }

    /// Moves the account lease to the runtime that owns the provider process.
    pub fn take_session_lease(&mut self) -> Result<ProfileLease, ProviderError> {
        self.lease.take().ok_or_else(|| {
            ProviderError::Start("the managed Gemini profile lease was already transferred".into())
        })
    }

    /// Appends only supported Gemini CLI flags, after refreshing the on-disk floor.
    pub fn append_security_args(&self, args: &mut Vec<OsString>) -> Result<(), ProviderError> {
        self.refresh()?;
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

/// Flags shared by every managed Gemini process. Every path Gemini receives is in its plain form
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
        Self::prepare_with_system_policies(
            profiles,
            source,
            account_id,
            lease,
            &platform_system_policies_dir(),
        )
    }

    pub(crate) fn prepare_with_system_policies(
        profiles: &ManagedProfiles,
        source: &DetectEnv,
        account_id: &str,
        lease: &ProfileLease,
        system_policies_dir: &Path,
    ) -> Result<Self, ProviderError> {
        if !lease.is_exclusive_for(profiles, ProviderId::GEMINI_CLI, account_id) {
            return Err(ProviderError::Start(
                "Gemini sign-in requires this account's exclusive profile lease".into(),
            ));
        }
        inspect_system_policies(system_policies_dir)?;
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
            "disableYoloMode": true,
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

fn inspect_system_policies(path: &Path) -> Result<(), ProviderError> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(metadata) => verify_system_directory_metadata(&metadata)?,
        Err(_) => return Err(ProviderError::Start(SYSTEM_POLICY_BLOCKER.into())),
    }
    let mut pending = VecDeque::from([path.to_path_buf()]);
    let mut inspected = 0usize;
    while let Some(directory) = pending.pop_front() {
        let entries = std::fs::read_dir(&directory)
            .map_err(|_| ProviderError::Start(SYSTEM_POLICY_BLOCKER.into()))?;
        for entry in entries {
            let entry = entry.map_err(|_| ProviderError::Start(SYSTEM_POLICY_BLOCKER.into()))?;
            inspected = inspected.saturating_add(1);
            if inspected > MAX_SYSTEM_POLICY_ENTRIES {
                return Err(ProviderError::Start(SYSTEM_POLICY_BLOCKER.into()));
            }
            let metadata = std::fs::symlink_metadata(entry.path())
                .map_err(|_| ProviderError::Start(SYSTEM_POLICY_BLOCKER.into()))?;
            if is_link_or_reparse(&metadata) {
                return Err(ProviderError::Start(SYSTEM_POLICY_BLOCKER.into()));
            }
            if metadata.is_dir() {
                pending.push_back(entry.path());
            } else if metadata.is_file() {
                if entry
                    .path()
                    .extension()
                    .and_then(OsStr::to_str)
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("toml"))
                {
                    return Err(ProviderError::Start(SYSTEM_POLICY_BLOCKER.into()));
                }
            } else {
                return Err(ProviderError::Start(SYSTEM_POLICY_BLOCKER.into()));
            }
        }
    }
    Ok(())
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

#[cfg(windows)]
fn platform_system_policies_dir() -> PathBuf {
    PathBuf::from(r"C:\ProgramData\gemini-cli\policies")
}

#[cfg(target_os = "macos")]
fn platform_system_policies_dir() -> PathBuf {
    PathBuf::from("/Library/Application Support/GeminiCli/policies")
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_system_policies_dir() -> PathBuf {
    PathBuf::from("/etc/gemini-cli/policies")
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

fn verify_system_directory_metadata(metadata: &std::fs::Metadata) -> Result<(), ProviderError> {
    if metadata.is_dir() && !is_link_or_reparse(metadata) {
        Ok(())
    } else {
        Err(ProviderError::Start(SYSTEM_POLICY_BLOCKER.into()))
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
            ],
            windows: cfg!(windows),
            probe_timeout: Some(Duration::from_millis(10)),
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
        system_policies: std::path::PathBuf,
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
            let system_policies = temp_root.join("system-policies");
            std::fs::create_dir_all(&person).expect("person");
            std::fs::create_dir_all(workspace.join(".gemini/policies")).expect("repo config");
            std::fs::create_dir_all(&system_policies).expect("system policies");
            std::fs::write(
                workspace.join(".gemini/settings.json"),
                r#"{"tools":{"core":["run_shell_command","exit_plan_mode"]},"mcpServers":{"repo":{"command":"synthetic-never-run"}}}"#,
            )
            .expect("hostile repo settings");
            std::fs::write(
                workspace.join(".gemini/policies/allow.toml"),
                "[[rule]]\ntoolName=\"run_shell_command\"\ndecision=\"allow\"\n",
            )
            .expect("hostile repo policy");
            let profiles =
                ManagedProfiles::new(temp_root.join("managed")).expect("managed profiles");
            let account_id = kalcode_contracts::ids::new_id();
            let thread_id = kalcode_contracts::ids::new_id();
            let profile = profiles
                .profile_home("gemini-cli", &account_id)
                .expect("profile");
            std::fs::create_dir_all(profile.join(".gemini")).expect("profile config");
            std::fs::write(
                profile.join(".gemini/settings.json"),
                r#"{"tools":{"allowed":["run_shell_command"]},"mcpServers":{"profile":{"command":"synthetic-never-run"}}}"#,
            )
            .expect("hostile profile settings");
            let source = source(&temp_root);
            Self {
                _temp: temp,
                profiles,
                source,
                account_id,
                thread_id,
                workspace,
                system_policies,
            }
        }

        fn prepare(
            &self,
            mode: PermissionMode,
        ) -> Result<ManagedGeminiLaunch, kalcode_contracts::agent::ProviderError> {
            ManagedGeminiLaunch::prepare_with_system_policies(
                &self.profiles,
                &self.source,
                &self.account_id,
                &self.thread_id,
                &self.workspace,
                mode,
                &self.system_policies,
            )
        }
    }

    #[test]
    fn plan_uses_a_neutral_workspace_and_an_exact_read_tool_floor() {
        let fixture = Fixture::new();
        let repo_settings =
            std::fs::read(fixture.workspace.join(".gemini/settings.json")).expect("repo fixture");
        let profile_settings = std::fs::read(
            fixture
                .profiles
                .profile_home("gemini-cli", &fixture.account_id)
                .expect("profile")
                .join(".gemini/settings.json"),
        )
        .expect("profile fixture");

        let launch = fixture
            .prepare(PermissionMode::Plan)
            .expect("managed launch");
        assert_ne!(launch.cwd(), fixture.workspace);
        assert!(
            launch.cwd().starts_with(
                fixture
                    .profiles
                    .session_dir("gemini-cli", &fixture.account_id, &fixture.thread_id)
                    .expect("session dir")
            )
        );

        let settings: serde_json::Value = serde_json::from_slice(
            &std::fs::read(launch.settings_path()).expect("managed settings"),
        )
        .expect("settings json");
        assert_eq!(
            settings["tools"]["core"],
            serde_json::json!(["list_directory", "read_file", "grep_search", "glob"])
        );
        assert_eq!(settings["tools"]["allowed"], serde_json::json!([]));
        assert_eq!(settings["hooksConfig"]["enabled"], false);
        assert_eq!(settings["skills"]["enabled"], false);
        assert_eq!(settings["experimental"]["enableAgents"], false);
        assert_eq!(settings["experimental"]["extensionReloading"], false);
        let core = settings["tools"]["core"].as_array().expect("core registry");
        assert!(!core.iter().any(|tool| tool == "exit_plan_mode"));
        assert!(!core.iter().any(|tool| tool == "run_shell_command"));

        let args = strings(launch.security_args());
        for expected in [
            "--skip-trust",
            "--include-directories",
            "--allowed-mcp-server-names",
            "--policy",
            "--admin-policy",
            "--extensions",
            "none",
        ] {
            assert!(args.iter().any(|arg| arg == expected), "{args:?}");
        }
        // Gemini CLI 0.61.0 rejects `--ignore-env` ("Unknown arguments"); the floor setting
        // `advanced.ignoreLocalEnv` is the supported equivalent.
        assert!(!args.iter().any(|arg| arg == "--ignore-env"), "{args:?}");
        assert_eq!(settings["advanced"]["ignoreLocalEnv"], true);
        assert_eq!(
            env_value(&launch, DEFAULT_AUTH_ENV),
            Some(OsStr::new("true"))
        );
        let include = args
            .iter()
            .position(|arg| arg == "--include-directories")
            .expect("include directory");
        assert_eq!(
            std::fs::canonicalize(Path::new(&args[include + 1])).expect("included workspace"),
            std::fs::canonicalize(&fixture.workspace).expect("fixture workspace")
        );
        let sentinel = args
            .iter()
            .position(|arg| arg == "--allowed-mcp-server-names")
            .expect("MCP sentinel");
        assert!(args[sentinel + 1].starts_with("kalcode-no-mcp-"));
        assert_ne!(args[sentinel + 1], "profile");
        assert_ne!(args[sentinel + 1], "repo");

        assert_eq!(
            env_value(&launch, "GEMINI_CLI_TRUST_WORKSPACE"),
            Some(OsStr::new("true"))
        );
        assert!(env_value(&launch, "GEMINI_CLI_HOME").is_some());
        assert!(env_value(&launch, "GEMINI_CLI_SYSTEM_SETTINGS_PATH").is_some());
        assert!(env_value(&launch, "GEMINI_CLI_SYSTEM_DEFAULTS_PATH").is_some());
        assert_eq!(
            env_value(&launch, "GEMINI_FORCE_FILE_STORAGE"),
            Some(OsStr::new("true"))
        );
        assert_eq!(
            env_value(&launch, "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE"),
            Some(OsStr::new("true")),
            "Google sign-in is never read from or written to a plaintext file"
        );
        assert!(
            env_value(&launch, "GEMINI_API_KEY").is_none(),
            "inherited GEMINI_API_KEY"
        );
        assert_eq!(
            std::fs::read(fixture.workspace.join(".gemini/settings.json"))
                .expect("repo settings unchanged"),
            repo_settings
        );
        assert_eq!(
            std::fs::read(
                fixture
                    .profiles
                    .profile_home("gemini-cli", &fixture.account_id)
                    .expect("profile")
                    .join(".gemini/settings.json")
            )
            .expect("profile settings unchanged"),
            profile_settings
        );
    }

    #[test]
    fn non_plan_modes_keep_native_prompt_and_auto_edit_modes_without_yolo() {
        let fixture = Fixture::new();
        for mode in [
            PermissionMode::Approve,
            PermissionMode::Auto,
            PermissionMode::Custom,
            PermissionMode::Bypass,
        ] {
            let launch = fixture.prepare(mode).expect("managed launch");
            let settings: serde_json::Value = serde_json::from_slice(
                &std::fs::read(launch.settings_path()).expect("managed settings"),
            )
            .expect("settings json");
            assert!(
                settings["tools"].get("core").is_none(),
                "{mode:?}: {settings}"
            );
            assert_eq!(settings["tools"]["allowed"], serde_json::json!([]));
            assert_eq!(settings["security"]["disableYoloMode"], true);
            assert!(
                !strings(launch.security_args())
                    .iter()
                    .any(|arg| arg == "--yolo")
            );
        }
    }

    #[test]
    fn every_turn_restores_settings_and_rejects_new_neutral_policies() {
        let fixture = Fixture::new();
        let launch = fixture
            .prepare(PermissionMode::Plan)
            .expect("managed launch");
        std::fs::write(
            launch.settings_path(),
            r#"{"tools":{"core":["exit_plan_mode"]}}"#,
        )
        .expect("mutate settings");
        launch.refresh().expect("restore floor");
        let restored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(launch.settings_path()).expect("restored"))
                .expect("restored JSON");
        let core = restored["tools"]["core"].as_array().expect("core");
        assert!(core.iter().any(|tool| tool == "list_directory"));
        assert!(!core.iter().any(|tool| tool == "exit_plan_mode"));

        std::fs::write(
            launch.neutral_policy_dir().join("runtime-hostile.toml"),
            "[[rule]]\ntoolName=\"exit_plan_mode\"\ndecision=\"allow\"\n",
        )
        .expect("runtime policy");
        let error = launch
            .refresh()
            .expect_err("unexpected policy must fail closed");
        assert!(error.to_string().contains("policy"), "{error}");
    }

    #[test]
    fn system_policy_toml_or_unreadable_policy_paths_fail_closed() {
        let fixture = Fixture::new();
        let nested = fixture.system_policies.join("nested");
        std::fs::create_dir(&nested).expect("nested");
        std::fs::write(nested.join("allow.TOML"), "synthetic").expect("system policy");
        let error = match fixture.prepare(PermissionMode::Plan) {
            Ok(_) => panic!("system policy must block managed launch"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("system policy"), "{error}");
    }

    #[test]
    fn mcp_sentinels_are_unpredictable_per_session() {
        let first = Fixture::new();
        let second = Fixture::new();
        let one = first.prepare(PermissionMode::Approve).expect("first");
        let two = second.prepare(PermissionMode::Approve).expect("second");
        assert_ne!(one.mcp_sentinel(), two.mcp_sentinel());
        assert!(
            uuid::Uuid::parse_str(
                one.mcp_sentinel()
                    .strip_prefix("kalcode-no-mcp-")
                    .expect("prefix")
            )
            .is_ok()
        );
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
        let sign_in = ManagedGeminiSignIn::prepare_with_system_policies(
            &fixture.profiles,
            &fixture.source,
            &fixture.account_id,
            &lease,
            &fixture.system_policies,
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
        for forbidden in [
            "GEMINI_API_KEY",
            "NO_BROWSER",
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
        ] {
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
        let shared = fixture
            .profiles
            .acquire_session_lease("gemini-cli", &fixture.account_id)
            .expect("shared lease");
        assert!(
            ManagedGeminiSignIn::prepare_with_system_policies(
                &fixture.profiles,
                &fixture.source,
                &fixture.account_id,
                &shared,
                &fixture.system_policies,
            )
            .is_err(),
            "a shared session lease cannot authorize sign-in"
        );
        drop(shared);
        let unrelated = fixture
            .profiles
            .acquire_sign_in_lease("gemini-cli", &other_account)
            .expect("other lease");
        assert!(
            ManagedGeminiSignIn::prepare_with_system_policies(
                &fixture.profiles,
                &fixture.source,
                &fixture.account_id,
                &unrelated,
                &fixture.system_policies,
            )
            .is_err(),
            "another account's lease cannot authorize this account's sign-in"
        );
        let claude = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", &fixture.account_id)
            .expect("claude lease");
        assert!(
            ManagedGeminiSignIn::prepare_with_system_policies(
                &fixture.profiles,
                &fixture.source,
                &fixture.account_id,
                &claude,
                &fixture.system_policies,
            )
            .is_err(),
            "another provider's lease cannot authorize Gemini sign-in"
        );
    }

    #[test]
    fn linked_neutral_policy_directories_fail_closed() {
        let fixture = Fixture::new();
        let launch = fixture
            .prepare(PermissionMode::Plan)
            .expect("managed launch");
        let outside = fixture.workspace.join("outside-policies");
        std::fs::create_dir(&outside).expect("outside");
        std::fs::remove_dir(launch.neutral_policy_dir()).expect("remove empty managed policies");
        if !directory_link(&outside, launch.neutral_policy_dir()) {
            eprintln!("directory links are unavailable; link case skipped");
            return;
        }
        let error = launch
            .refresh()
            .expect_err("linked policies must fail closed");
        assert!(error.to_string().contains("ordinary"), "{error}");
    }

    #[cfg(windows)]
    fn directory_link(target: &Path, link: &Path) -> bool {
        use std::os::windows::process::CommandExt;

        let mut command = std::process::Command::new("cmd");
        command.creation_flags(0x0800_0000);
        command
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|output| output.status.success())
    }

    #[cfg(unix)]
    fn directory_link(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}
