//! Account-isolated Codex launch policy for the certified Codex CLI release lines
//! ([`crate::codex::MANAGED_VERSIONS`]).
//!
//! A launch uses a dedicated `CODEX_HOME` per account, so each account keeps its own sign-in and
//! sessions. That profile's `config.toml` is rewritten before every launch from the user's
//! native Codex configuration, and the user's skills, prompts, rules, agents, plugins and global
//! `AGENTS.md` reach it through [`crate::native_config`] (native provider parity): MCP servers,
//! plugins, features, model providers and project trust behave as in a native terminal.
//! Authentication and account probes use a neutral managed directory with an exclusive or
//! observer lease; sessions use a shared lease. Organization cloud configuration and real OS
//! administrator configuration remain the provider's and administrator's authority.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use kalcode_contracts::agent::ProviderError;

use crate::claude::argv::working_directory;
use crate::detect::DetectEnv;
use crate::managed::{ManagedProfiles, ProfileLease};

const PROVIDER: &str = "codex";
const CONFIG_NAME: &str = "config.toml";
const SAFE_CONFIG: &str = "# KalCode account profile. Launch policy is supplied on argv.\n";
const UNSAFE_CONFIG: &str = "the managed Codex config path is not a regular file";
const UNMANAGED_CONFIG: &str = "the managed Codex config changed outside KalCode";

pub(crate) fn is_unmanaged_config(error: &ProviderError) -> bool {
    matches!(error, ProviderError::Start(message) if message == UNMANAGED_CONFIG)
}

/// Whether the official Codex account result permits a session without an enterprise cloud
/// config layer. Business, Education, and Enterprise accounts are eligible; missing/unknown
/// plan data must remain [`Unknown`](Self::Unknown).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudConfigEligibility {
    /// Official account data identifies a consumer Free, Plus, or Pro plan.
    Ineligible,
    /// Official account data identifies a Business, Education, or Enterprise plan.
    Eligible,
    /// No current official account result proves either state.
    Unknown,
}

/// Inputs retained for one managed Codex session or interactive pane.
pub struct ManagedSessionLaunch {
    /// Detection against the dedicated account profile.
    pub detect_env: DetectEnv,
    /// Complete sanitized child environment with the account-specific `CODEX_HOME`.
    pub env: BTreeMap<OsString, OsString>,
    /// Additional root CLI arguments (`-c value` pairs) that bind repository trust.
    pub cli_overrides: Vec<OsString>,
    /// Must be retained until the provider process/session has been dropped.
    pub lease: ProfileLease,
}

/// Inputs for a bounded account/read or supported sign-in app-server process.
pub struct ManagedAuthLaunch {
    /// Complete sanitized child environment with the account-specific `CODEX_HOME`.
    pub env: BTreeMap<OsString, OsString>,
    /// Stable managed non-repository directory used as the process working directory.
    pub cwd: PathBuf,
    /// Root CLI arguments followed by `app-server`.
    pub args: Vec<OsString>,
    /// Exact dedicated profile selected by `CODEX_HOME`.
    pub profile_home: PathBuf,
    /// Exact observer or exclusive authentication lease retained for the app-server lifetime.
    pub lease: ProfileLease,
}

/// Prepares an account session. Every plan launches (native provider parity): the profile's
/// `config.toml` is the user's native Codex configuration, the user's own project trust applies,
/// and an organization's cloud configuration applies as it does in a native terminal.
/// `_cloud_config` is the current official plan verdict; the caller has already required one.
pub fn prepare_session(
    profiles: &ManagedProfiles,
    source: &DetectEnv,
    account_id: &str,
    workspace: &Path,
    _cloud_config: CloudConfigEligibility,
) -> Result<ManagedSessionLaunch, ProviderError> {
    working_directory(&workspace.to_string_lossy())
        .map_err(|error| ProviderError::Start(error.to_string()))?;
    let lease = profiles.acquire_session_lease(PROVIDER, account_id)?;
    let profile_home = profiles.profile_home(PROVIDER, account_id)?;
    reset_managed_config(&profile_home, &native_config(profiles, source))?;
    let detect_env = profiles.prepare_env(PROVIDER, account_id, source)?;
    let env = profiles.launch_env(PROVIDER, account_id, source)?;
    Ok(ManagedSessionLaunch {
        detect_env,
        env,
        cli_overrides: Vec::new(),
        lease,
    })
}

/// The profile's `config.toml`: KalCode's header followed by the user's native configuration.
fn native_config(profiles: &ManagedProfiles, source: &DetectEnv) -> String {
    crate::native_config::codex_config(&profiles.native_homes(source), SAFE_CONFIG)
}

/// Prepares the isolated Codex app-server used only for account/read and supported sign-in RPCs.
/// It never starts a thread. The caller must terminate it before releasing `lease`, and must
/// reject a newly reported enterprise-eligible plan before starting any provider session.
pub fn prepare_auth(
    profiles: &ManagedProfiles,
    source: &DetectEnv,
    account_id: &str,
) -> Result<ManagedAuthLaunch, ProviderError> {
    let lease = profiles.acquire_sign_in_lease(PROVIDER, account_id)?;
    prepare_auth_with_lease(profiles, source, account_id, lease)
}

/// Prepares authentication using an exclusive lease already acquired by the canonical account
/// authority. This closes the account archive/auth race without attempting to nest the same
/// exclusive profile lock.
pub fn prepare_auth_with_lease(
    profiles: &ManagedProfiles,
    source: &DetectEnv,
    account_id: &str,
    lease: ProfileLease,
) -> Result<ManagedAuthLaunch, ProviderError> {
    if !lease.is_exclusive_for(profiles, PROVIDER, account_id) {
        return Err(ProviderError::Start(
            "the managed Codex authentication lease does not match the selected account".into(),
        ));
    }
    let profile_home = profiles.profile_home(PROVIDER, account_id)?;
    reset_managed_config(&profile_home, &native_config(profiles, source))?;
    // Reuse the account id as a canonical stable directory key. This directory is outside the
    // profile home and every repository; no thread is created by the auth process.
    let cwd = profiles.session_dir(PROVIDER, account_id, account_id)?;
    reject_repository_marker(&cwd)?;
    let env = profiles.launch_env(PROVIDER, account_id, source)?;
    let mut args = config_args(
        crate::codex::argv::PROBE_CONFIG
            .iter()
            .copied()
            .chain(["approval_policy='never'", "sandbox_mode='read-only'"])
            .map(str::to_owned)
            .chain([repository_override(&cwd)?]),
    );
    args.push("app-server".into());
    Ok(ManagedAuthLaunch {
        env,
        cwd,
        args,
        profile_home,
        lease,
    })
}

/// Prepares the official app-server for the read-only `account/read {refreshToken:false}` RPC.
/// Unlike authentication preparation, this accepts only a shared observer lease and deliberately
/// does not rewrite `config.toml`; explicit login/logout continue through the exclusive path.
pub fn prepare_observer_with_lease(
    profiles: &ManagedProfiles,
    source: &DetectEnv,
    account_id: &str,
    lease: ProfileLease,
) -> Result<ManagedAuthLaunch, ProviderError> {
    if !lease.is_observer_for(profiles, PROVIDER, account_id) {
        return Err(ProviderError::Start(
            "the managed Codex observer lease does not match the selected account".into(),
        ));
    }
    let profile_home = profiles.profile_home(PROVIDER, account_id)?;
    // The observer deliberately preserves provider-native configuration, but it must not follow a
    // config symlink/reparse point or multiply-linked file outside this isolated profile.
    verify_regular_or_missing(&profile_home.join(CONFIG_NAME))?;
    // Reuse the account id as a canonical stable directory key. This directory is outside the
    // profile home and every repository; no thread is created by the observer.
    let cwd = profiles.session_dir(PROVIDER, account_id, account_id)?;
    reject_repository_marker(&cwd)?;
    let env = profiles.launch_env(PROVIDER, account_id, source)?;
    let mut args = config_args(
        crate::codex::argv::PROBE_CONFIG
            .iter()
            .copied()
            .chain(["approval_policy='never'", "sandbox_mode='read-only'"])
            .map(str::to_owned)
            .chain([repository_override(&cwd)?]),
    );
    args.push("app-server".into());
    Ok(ManagedAuthLaunch {
        env,
        cwd,
        args,
        profile_home,
        lease,
    })
}

/// Restores only KalCode's inert Codex configuration under the exact account's exclusive lease.
/// Provider-native credentials and every other profile file remain untouched.
pub fn repair_observer_config_with_lease(
    profiles: &ManagedProfiles,
    account_id: &str,
    lease: ProfileLease,
) -> Result<(), ProviderError> {
    if !lease.is_exclusive_for(profiles, PROVIDER, account_id) {
        return Err(ProviderError::Start(
            "the managed Codex configuration lease does not match the selected account".into(),
        ));
    }
    let profile_home = profiles.profile_home(PROVIDER, account_id)?;
    reset_managed_config(
        &profile_home,
        &native_config(profiles, &DetectEnv::from_process()),
    )
}

fn reject_repository_marker(cwd: &Path) -> Result<(), ProviderError> {
    let marker = cwd.join(".git");
    match std::fs::symlink_metadata(&marker) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(ProviderError::Start(
            "the managed Codex authentication directory is not neutral".into(),
        )),
        Err(error) => Err(io_error(
            "couldn't inspect the managed Codex authentication directory",
            error,
        )),
    }
}

fn config_args(values: impl IntoIterator<Item = String>) -> Vec<OsString> {
    values
        .into_iter()
        .flat_map(|value| [OsString::from("-c"), OsString::from(value)])
        .collect()
}

/// Serializes one complete TOML table. The certified Codex loaders split dotted overrides on dots
/// even inside quoted keys, so `projects."C:\\repo.with.dot".trust_level=...` is unsafe.
fn repository_override(workspace: &Path) -> Result<String, ProviderError> {
    let path = workspace
        .to_str()
        .ok_or_else(|| ProviderError::Start("the Codex workspace path is not Unicode".into()))?;
    Ok(format!(
        "projects={{{}={{trust_level=\"untrusted\"}}}}",
        toml_basic_string(path)
    ))
}

fn toml_basic_string(value: &str) -> String {
    let mut out = String::from("\"");
    for character in value.chars() {
        match character {
            '\u{0008}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{000C}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            character if character.is_control() => {
                use std::fmt::Write as _;
                let _ = write!(&mut out, "\\u{:04X}", character as u32);
            }
            character => out.push(character),
        }
    }
    out.push('"');
    out
}

fn reset_managed_config(profile_home: &Path, contents: &str) -> Result<(), ProviderError> {
    let target = profile_home.join(CONFIG_NAME);
    verify_regular_or_missing(&target)?;
    let temp = profile_home.join(format!(
        ".{CONFIG_NAME}.kalcode-{}.tmp",
        uuid::Uuid::new_v4().hyphenated()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| io_error("couldn't create the managed Codex config", error))?;
        set_private_permissions(&file)?;
        file.write_all(contents.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|error| io_error("couldn't write the managed Codex config", error))?;
        drop(file);
        verify_regular_or_missing(&target)?;
        match std::fs::remove_file(&target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(io_error("couldn't replace the managed Codex config", error));
            }
        }
        std::fs::rename(&temp, &target)
            .map_err(|error| io_error("couldn't install the managed Codex config", error))?;
        verify_regular_or_missing(&target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn verify_regular_or_missing(path: &Path) -> Result<(), ProviderError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_reparse_point(&metadata) => {
            if has_multiple_links(path, &metadata)? {
                Err(ProviderError::Start(UNSAFE_CONFIG.into()))
            } else {
                Ok(())
            }
        }
        Ok(_) => Err(ProviderError::Start(UNSAFE_CONFIG.into())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error("couldn't inspect the managed Codex config", error)),
    }
}

fn has_multiple_links(path: &Path, metadata: &std::fs::Metadata) -> Result<bool, ProviderError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        Ok(metadata.nlink() != 1)
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        let file = File::open(path)
            .map_err(|error| io_error("couldn't open the managed Codex config", error))?;
        // Fail closed when Windows cannot report by-handle file information.
        Ok(winapi_util::file::information(file)
            .map_or(true, |information| information.number_of_links() != 1))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, metadata);
        Ok(true)
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(unix)]
fn set_private_permissions(file: &File) -> Result<(), ProviderError> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|error| io_error("couldn't protect the managed Codex config", error))
}

#[cfg(not(unix))]
fn set_private_permissions(_file: &File) -> Result<(), ProviderError> {
    Ok(())
}

fn io_error(context: &str, error: std::io::Error) -> ProviderError {
    ProviderError::Start(format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::NO_CWD_EXE_SEARCH;
    use std::ffi::{OsStr, OsString};
    use tempfile::TempDir;

    fn fixture() -> (TempDir, ManagedProfiles, DetectEnv, String, PathBuf) {
        let temp = tempfile::tempdir().expect("temp");
        let temp_root = if cfg!(target_os = "macos") {
            temp.path().canonicalize().expect("canonical temp")
        } else {
            temp.path().to_path_buf()
        };
        let profiles = ManagedProfiles::new(temp_root.join("profiles")).expect("managed profiles");
        let account_id = uuid::Uuid::new_v4().hyphenated().to_string();
        let workspace = temp_root.join("repo.with.dots");
        std::fs::create_dir(&workspace).expect("workspace");
        let source = DetectEnv {
            vars: vec![
                ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
                (
                    "HOME".into(),
                    temp_root.join("ordinary-home").into_os_string(),
                ),
                (
                    "USERPROFILE".into(),
                    temp_root.join("ordinary-user").into_os_string(),
                ),
                ("OPENAI_API_KEY".into(), "secret".into()),
                ("CODEX_APP_SERVER_LOGIN_ISSUER".into(), "hostile".into()),
                ("CODEX_APP_SERVER_LOGIN_CLIENT_ID".into(), "hostile".into()),
                ("CODEX_APP_SERVER_DEV_OPEN_APP_URL".into(), "hostile".into()),
                ("CODEX_HOME".into(), temp_root.join("old").into_os_string()),
            ],
            windows: cfg!(windows),
            probe_timeout: None,
            system_root: None,
        };
        (temp, profiles, source, account_id, workspace)
    }

    fn env_value<'a>(env: &'a BTreeMap<OsString, OsString>, name: &str) -> Option<&'a OsStr> {
        env.iter()
            .find(|(key, _)| {
                key.to_str()
                    .is_some_and(|key| key.eq_ignore_ascii_case(name))
            })
            .map(|(_, value)| value.as_os_str())
    }

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|arg| arg.to_string_lossy().into())
            .collect()
    }

    #[test]
    fn every_plan_launches_with_the_users_own_configuration_and_trust() {
        let (temp, profiles, mut source, account_id, workspace) = fixture();
        let native = temp.path().join("native-codex");
        std::fs::create_dir(&native).expect("native codex home");
        std::fs::write(
            native.join(CONFIG_NAME),
            "cli_auth_credentials_store = \"keyring\"\n[mcp_servers.docs]\ncommand = \"docs-mcp\"\n[projects.'C:\\repo']\ntrust_level = \"trusted\"\n",
        )
        .expect("native config");
        source
            .vars
            .retain(|(name, _)| !name.eq_ignore_ascii_case("CODEX_HOME"));
        source
            .vars
            .push(("CODEX_HOME".into(), native.into_os_string()));
        for eligibility in [
            CloudConfigEligibility::Ineligible,
            CloudConfigEligibility::Eligible,
            CloudConfigEligibility::Unknown,
        ] {
            let launch = prepare_session(&profiles, &source, &account_id, &workspace, eligibility)
                .expect("every plan launches");
            assert!(launch.cli_overrides.is_empty(), "no forced trust override");
        }
        let home = profiles.profile_home(PROVIDER, &account_id).expect("home");
        assert_eq!(
            std::fs::read_to_string(home.join(CONFIG_NAME)).expect("profile config"),
            format!(
                "{SAFE_CONFIG}[mcp_servers.docs]\ncommand = \"docs-mcp\"\n[projects.'C:\\repo']\ntrust_level = \"trusted\"\n"
            )
        );
    }

    #[test]
    fn auth_is_exclusive_neutral_and_strips_auth_selectors() {
        let (_temp, profiles, source, account_id, _workspace) = fixture();
        let launch = prepare_auth(&profiles, &source, &account_id).expect("auth launch");
        assert_eq!(
            env_value(&launch.env, "CODEX_HOME"),
            Some(crate::managed::plain_path(&launch.profile_home).as_os_str())
        );
        for denied in [
            "OPENAI_API_KEY",
            "CODEX_APP_SERVER_LOGIN_ISSUER",
            "CODEX_APP_SERVER_LOGIN_CLIENT_ID",
            "CODEX_APP_SERVER_DEV_OPEN_APP_URL",
        ] {
            assert!(env_value(&launch.env, denied).is_none(), "{denied}");
        }
        assert_eq!(
            env_value(&launch.env, NO_CWD_EXE_SEARCH),
            Some(OsStr::new("1"))
        );
        assert!(!launch.cwd.join(".git").exists());
        let args = strings(&launch.args);
        assert_eq!(args.last().map(String::as_str), Some("app-server"));
        assert!(args.iter().any(|arg| arg == "mcp_servers={}"));
        assert!(args.iter().any(|arg| arg.starts_with("projects={\"")));
        assert!(
            profiles
                .acquire_session_lease(PROVIDER, &account_id)
                .is_err()
        );
    }

    #[test]
    fn auth_rejects_a_matching_account_lease_from_another_profile_root() {
        let (temp, profiles, source, account_id, _workspace) = fixture();
        let temp_root = if cfg!(target_os = "macos") {
            temp.path().canonicalize().expect("canonical temp")
        } else {
            temp.path().to_path_buf()
        };
        let other_root = temp_root.join("other-profiles");
        let other = ManagedProfiles::new(other_root).expect("other managed profiles");
        let wrong_root_lease = other
            .acquire_sign_in_lease(PROVIDER, &account_id)
            .expect("other-root lease");

        assert!(
            prepare_auth_with_lease(&profiles, &source, &account_id, wrong_root_lease).is_err(),
            "a same-provider, same-account lease from another root must not authorize this root"
        );
    }

    #[test]
    fn observer_is_read_only_and_keeps_the_profiles_configuration() {
        let (_temp, profiles, source, account_id, _workspace) = fixture();
        let home = profiles.profile_home(PROVIDER, &account_id).expect("home");
        let config = home.join(CONFIG_NAME);
        std::fs::write(&config, SAFE_CONFIG).expect("safe config");
        let before = std::fs::read(&config).expect("config before");
        let lease = profiles
            .acquire_observer_lease(PROVIDER, &account_id)
            .expect("observer lease");
        let launch = prepare_observer_with_lease(&profiles, &source, &account_id, lease)
            .expect("observer launch");
        let args = strings(&launch.args);
        assert_eq!(args.last().map(String::as_str), Some("app-server"));
        assert!(args.iter().any(|arg| arg == "approval_policy='never'"));
        assert!(args.iter().any(|arg| arg == "sandbox_mode='read-only'"));
        assert_eq!(std::fs::read(&config).expect("config after"), before);
        drop(launch);

        // The user's own configuration (copied from their native Codex home) is not drift: the
        // observer reads the account without rewriting it.
        let native = b"[mcp_servers.docs]\ncommand='docs-mcp'\n";
        std::fs::write(&config, native).expect("native config");
        let auth = home.join("auth.json");
        std::fs::write(&auth, b"opaque-provider-native-credential").expect("auth fixture");
        let lease = profiles
            .acquire_observer_lease(PROVIDER, &account_id)
            .expect("observer lease");
        let launch = prepare_observer_with_lease(&profiles, &source, &account_id, lease)
            .expect("observer under the user's configuration");
        drop(launch);
        assert_eq!(std::fs::read(&config).expect("config unchanged"), native);

        let lease = profiles
            .acquire_sign_in_lease(PROVIDER, &account_id)
            .expect("exclusive config repair");
        repair_observer_config_with_lease(&profiles, &account_id, lease).expect("config repair");
        assert!(
            std::fs::read_to_string(&config)
                .expect("rewritten config")
                .starts_with(SAFE_CONFIG)
        );
        assert_eq!(
            std::fs::read(&auth).expect("auth unchanged"),
            b"opaque-provider-native-credential"
        );
    }

    #[test]
    fn launch_resets_only_known_config_and_preserves_auth_files() {
        let (_temp, profiles, source, account_id, workspace) = fixture();
        let home = profiles.profile_home(PROVIDER, &account_id).expect("home");
        let auth = home.join("auth.json");
        std::fs::write(&auth, b"untouched-auth-fixture").expect("auth fixture");
        std::fs::write(
            home.join(CONFIG_NAME),
            b"[mcp_servers.hostile]\ncommand='hostile'\n",
        )
        .expect("hostile config");
        let launch = prepare_session(
            &profiles,
            &source,
            &account_id,
            &workspace,
            CloudConfigEligibility::Ineligible,
        )
        .expect("launch");
        assert_eq!(
            std::fs::read_to_string(home.join(CONFIG_NAME)).expect("config"),
            SAFE_CONFIG
        );
        assert_eq!(
            std::fs::read(auth).expect("auth"),
            b"untouched-auth-fixture"
        );
        drop(launch);
    }

    #[test]
    fn config_hard_link_is_refused_without_touching_its_other_name() {
        let (temp, profiles, source, account_id, workspace) = fixture();
        let home = profiles.profile_home(PROVIDER, &account_id).expect("home");
        let outside = temp.path().join("outside-config");
        std::fs::write(&outside, b"outside").expect("outside");
        std::fs::hard_link(&outside, home.join(CONFIG_NAME)).expect("hard link");
        assert!(
            prepare_session(
                &profiles,
                &source,
                &account_id,
                &workspace,
                CloudConfigEligibility::Ineligible,
            )
            .is_err()
        );
        assert_eq!(std::fs::read(outside).expect("outside"), b"outside");
    }

    #[cfg(unix)]
    #[test]
    fn config_symlink_is_refused_without_touching_its_target() {
        use std::os::unix::fs::symlink;
        let (temp, profiles, source, account_id, workspace) = fixture();
        let home = profiles.profile_home(PROVIDER, &account_id).expect("home");
        let outside = temp.path().join("outside");
        std::fs::write(&outside, b"outside").expect("outside");
        symlink(&outside, home.join(CONFIG_NAME)).expect("symlink");
        assert!(
            prepare_session(
                &profiles,
                &source,
                &account_id,
                &workspace,
                CloudConfigEligibility::Ineligible,
            )
            .is_err()
        );
        assert_eq!(std::fs::read(outside).expect("outside"), b"outside");
    }

    #[cfg(windows)]
    #[test]
    fn config_reparse_point_is_refused_when_creation_is_permitted() {
        use std::os::windows::fs::symlink_file;
        let (temp, profiles, source, account_id, workspace) = fixture();
        let home = profiles.profile_home(PROVIDER, &account_id).expect("home");
        let outside = temp.path().join("outside");
        std::fs::write(&outside, b"outside").expect("outside");
        if symlink_file(&outside, home.join(CONFIG_NAME)).is_err() {
            return;
        }
        assert!(
            prepare_session(
                &profiles,
                &source,
                &account_id,
                &workspace,
                CloudConfigEligibility::Ineligible,
            )
            .is_err()
        );
        assert_eq!(std::fs::read(outside).expect("outside"), b"outside");
    }

    /// Non-inference certification of one official Codex CLI release: a managed account session
    /// sees the user's native Codex configuration (native provider parity), never a stale profile
    /// copy, and every argv KalCode builds parses. This exercises the real binary with synthetic
    /// homes and repository config only: no prompt, account read, network request, or provider
    /// credential is involved.
    ///
    /// `KALCODE_CERTIFY_CODEX` names the executable or npm shim to certify (for example
    /// `<scratch>/codex-0.158.0/node_modules/.bin/codex.cmd` after
    /// `npm install --prefix <scratch>/codex-0.158.0 @openai/codex@0.158.0`); without it the
    /// Codex on `PATH` is used. `KALCODE_CERTIFY_CODEX_VERSION`, when set, must equal the version
    /// the binary reports.
    #[test]
    #[ignore = "run explicitly when certifying a Codex CLI release (KALCODE_CERTIFY_CODEX)"]
    fn certifies_codex_native_config_parity() {
        use crate::process::{ProcessSpec, run_probe};
        use std::time::Duration;

        let temp = tempfile::tempdir().expect("temp");
        let temp_root = if cfg!(target_os = "macos") {
            temp.path().canonicalize().expect("canonical temp")
        } else {
            temp.path().to_path_buf()
        };
        let profiles = ManagedProfiles::new(temp_root.join("profiles")).expect("managed profiles");
        let account_id = uuid::Uuid::new_v4().hyphenated().to_string();
        let workspace = temp_root.join("workspace");
        let project_config_dir = workspace.join(".codex");
        std::fs::create_dir_all(&project_config_dir).expect("project config directory");
        std::fs::write(
            project_config_dir.join(CONFIG_NAME),
            "[mcp_servers.workspace_probe]\ncommand='workspace-probe'\n[features]\napps=true\nplugins=true\n",
        )
        .expect("project config");

        let ordinary_home = temp_root.join("ordinary-codex-home");
        std::fs::create_dir(&ordinary_home).expect("ordinary home");
        let ordinary_config = "[mcp_servers.ordinary_probe]\ncommand='ordinary-probe'\n";
        std::fs::write(ordinary_home.join(CONFIG_NAME), ordinary_config).expect("ordinary config");
        let mut source = DetectEnv::from_process();
        source.vars.retain(|(key, _)| {
            !key.to_str()
                .is_some_and(|key| key.eq_ignore_ascii_case("CODEX_HOME"))
        });
        source
            .vars
            .push(("CODEX_HOME".into(), ordinary_home.clone().into_os_string()));
        let executable = match std::env::var_os("KALCODE_CERTIFY_CODEX") {
            Some(path) => std::path::PathBuf::from(path),
            None => source
                .resolve_executable_only(&crate::catalog::codex_spec())
                .expect("installed Codex executable"),
        };

        let managed_home = profiles
            .profile_home(PROVIDER, &account_id)
            .expect("managed home");
        std::fs::write(
            managed_home.join(CONFIG_NAME),
            "[mcp_servers.profile_probe]\ncommand='profile-probe'\n",
        )
        .expect("contaminated managed config");
        let prepared = prepare_session(
            &profiles,
            &source,
            &account_id,
            &workspace,
            CloudConfigEligibility::Ineligible,
        )
        .expect("managed launch");

        let reported = run_probe(
            &ProcessSpec {
                program: executable.clone(),
                args: vec!["--version".into()],
                cwd: Some(managed_home.clone()),
                env: prepared.env.clone(),
            },
            Duration::from_secs(15),
            true,
            16 * 1024,
        )
        .expect("bounded version probe");
        assert!(reported.status.success(), "version probe failed");
        let reported_version = reported
            .stdout
            .trim()
            .strip_prefix("codex-cli ")
            .unwrap_or_else(|| panic!("unexpected --version format: {}", reported.stdout.trim()));
        if let Ok(expected) = std::env::var("KALCODE_CERTIFY_CODEX_VERSION") {
            assert_eq!(reported_version, expected, "certifying the wrong binary");
        }
        eprintln!("certifying codex-cli {reported_version}");
        crate::codex::verify_managed_executable_version(&executable, &prepared.env, &managed_home)
            .expect("installed version is in a certified line");
        let mut args = config_args(
            crate::codex::argv::POLICY_CONFIG
                .iter()
                .copied()
                .map(str::to_owned),
        );
        args.extend(prepared.cli_overrides.iter().cloned());
        args.extend([OsString::from("mcp"), "list".into(), "--json".into()]);
        let mcp = run_probe(
            &ProcessSpec {
                program: executable.clone(),
                args,
                cwd: Some(workspace.clone()),
                env: prepared.env.clone(),
            },
            Duration::from_secs(15),
            true,
            64 * 1024,
        )
        .expect("bounded mcp config probe");
        assert!(mcp.status.success(), "mcp probe failed: {}", mcp.stderr);
        let configured: serde_json::Value =
            serde_json::from_str(&mcp.stdout).expect("mcp list JSON");
        let serialized = configured.to_string();
        assert!(
            serialized.contains("ordinary_probe"),
            "the user's native MCP server must reach the managed session: {serialized}"
        );
        assert!(
            !serialized.contains("profile_probe"),
            "a stale profile config must be replaced by the native one: {serialized}"
        );

        // Every headless turn argv KalCode builds (`exec --json`, the policy config, the managed
        // overrides, each permission mode and `exec resume`) must parse. `--help` replaces the stdin prompt marker so no turn starts.
        use kalcode_contracts::permissions::PermissionMode;
        let resume_id = kalcode_contracts::ids::new_id();
        for mode in [
            PermissionMode::Plan,
            PermissionMode::Approve,
            PermissionMode::Auto,
            PermissionMode::Bypass,
        ] {
            for resume in [None, Some(resume_id.as_str())] {
                let mut exec = crate::codex::argv::exec_args_with_overrides(
                    mode,
                    None,
                    None,
                    resume,
                    &prepared.cli_overrides,
                )
                .expect("exec argv");
                assert_eq!(exec.last().map(OsString::as_os_str), Some("-".as_ref()));
                exec.pop();
                exec.push("--help".into());
                let parsed = run_probe(
                    &ProcessSpec {
                        program: executable.clone(),
                        args: exec,
                        cwd: Some(workspace.clone()),
                        env: prepared.env.clone(),
                    },
                    Duration::from_secs(15),
                    true,
                    64 * 1024,
                )
                .expect("bounded exec argv probe");
                assert!(
                    parsed.status.success(),
                    "{mode:?} resume={} argv rejected: {}",
                    resume.is_some(),
                    parsed.stderr
                );
            }
        }

        assert_eq!(
            std::fs::read_to_string(ordinary_home.join(CONFIG_NAME)).expect("ordinary config"),
            ordinary_config,
            "managed startup must never rewrite the standalone profile"
        );
        assert_eq!(
            std::fs::read_to_string(managed_home.join(CONFIG_NAME)).expect("managed config"),
            format!("{SAFE_CONFIG}{ordinary_config}")
        );
    }
}
