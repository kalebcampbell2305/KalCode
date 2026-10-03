//! Official Gemini CLI account authentication for KalCode-managed profiles.
//!
//! Gemini CLI 0.61.0 has no `auth login` subcommand. Its own sign-in runs at startup whenever the
//! selected auth type is "Sign in with Google" and no cached credential exists: headless Gemini
//! asks `Opening authentication page in your browser. Do you want to continue? [Y/n]` on stdin,
//! opens Google's page in the system browser, receives the OAuth callback on a loopback port,
//! and caches the result. Managed profiles select Gemini's encrypted file storage (see
//! `managed_policy::select_credential_storage`), so the credential lands AES-256-GCM encrypted in
//! `<GEMINI_CLI_HOME>/.gemini/gemini-credentials.json`, never in plaintext `oauth_creds.json`.
//!
//! KalCode runs exactly that flow, and nothing else, inside one account's exclusively leased
//! managed profile ([`ManagedGeminiSignIn`]): a neutral directory in the profile (never a
//! repository), the read-only Plan floor, and `--list-extensions`, which exits right after
//! startup authentication without a model request or tool. KalCode answers only the consent
//! question the person already answered by choosing Sign in; the provider output (which contains
//! the one-time browser URL) is drained and discarded without logging or crossing the WebView.
//!
//! Account state is the presence of Gemini's own credential files, checked by metadata only:
//! KalCode never opens, reads, copies or stores their contents. Sign-out removes only the
//! files Gemini itself uses for this account's credentials, below this account's profile.
//!
//! One display-only exception (release-lead security sign-off): for a signed-in account, KalCode
//! reads the `active` field of `<GEMINI_CLI_HOME>/.gemini/google_accounts.json` in that account's
//! own managed profile, and only that field, as the provider-reported identity. The file must be
//! an ordinary file (no link or reparse point, checked before and after opening, and the opened
//! handle must be the very file at that path inside the account's canonical home) of at most
//! [`MAX_GOOGLE_ACCOUNTS_BYTES`] bytes that parses as JSON with an `active` string that looks like
//! an email of at most `MAX_PROVIDER_IDENTITY_CHARS` characters; anything else yields no identity.
//! `old` is never kept or exposed, no other file is opened (the credential stores never are), and
//! the identity is never logged.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AuthState, ProviderError, ProviderId};
use kalcode_contracts::provider_accounts::MAX_PROVIDER_IDENTITY_CHARS;

use crate::detect::DetectEnv;
use crate::gemini::managed_policy::ManagedGeminiSignIn;
use crate::managed::{ManagedProfiles, ProfileLease};
use crate::process::{ProcessSpec, SupervisedChild, run_probe_guarded};
use crate::version::Version;

const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const TERMINATE_GRACE: Duration = Duration::from_millis(500);

/// Gemini's own configuration directory below `GEMINI_CLI_HOME`.
const GEMINI_DIR: &str = ".gemini";
/// Gemini CLI 0.61.0's plaintext "Sign in with Google" cache (`Storage.getOAuthCredsPath`), used
/// only without encrypted storage. Managed launches never write it; Gemini migrates a legacy copy
/// into the encrypted store and deletes it, and sign-out removes any that remains.
const LEGACY_PLAINTEXT_CREDENTIALS_FILE: &str = "oauth_creds.json";
/// Gemini's cached Google account email list, cleared by Gemini's own credential reset. Its
/// `active` field is the only content KalCode ever reads from a managed profile (display only).
const GOOGLE_ACCOUNTS_FILE: &str = "google_accounts.json";
/// Largest `google_accounts.json` KalCode will parse; a larger file yields no identity.
pub const MAX_GOOGLE_ACCOUNTS_BYTES: u64 = 16 * 1024;
/// Gemini's AES-256-GCM `FileKeychain` (`GEMINI_FORCE_ENCRYPTED_FILE_STORAGE` with
/// `GEMINI_FORCE_FILE_STORAGE`): the managed Google sign-in. Gemini deletes the file itself when
/// its last entry is removed. In a managed profile it holds only this account's credentials.
pub const ENCRYPTED_CREDENTIALS_FILE: &str = "gemini-credentials.json";
/// Every provider-owned credential file sign-out removes. Nothing else in the profile changes.
const SIGN_OUT_FILES: [&str; 3] = [
    ENCRYPTED_CREDENTIALS_FILE,
    LEGACY_PLAINTEXT_CREDENTIALS_FILE,
    GOOGLE_ACCOUNTS_FILE,
];

/// Account truth derived from Gemini's own credential files (existence only), plus the display-only
/// Google account email Gemini recorded for a signed-in profile.
#[derive(Clone, PartialEq, Eq)]
pub struct GeminiAccountState {
    pub auth: AuthState,
    /// `google_accounts.json` `active` email; `None` unless signed in and the file is valid.
    /// Display metadata only: never logged (the `Debug` form redacts it).
    pub identity: Option<String>,
}

impl GeminiAccountState {
    pub fn logged_in(&self) -> bool {
        self.auth == AuthState::Authenticated
    }
}

impl fmt::Debug for GeminiAccountState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeminiAccountState")
            .field("auth", &self.auth)
            .field("identity", &self.identity.as_ref().map(|_| "[redacted]"))
            .finish()
    }
}

/// Bounded, credential-free failures from Gemini account operations.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GeminiAccountAuthError {
    #[error("the managed Gemini profile could not be prepared")]
    ProfileUnavailable,
    #[error("Gemini CLI could not be started")]
    StartFailed,
    #[error("the installed Gemini CLI version is not certified for managed profiles")]
    UnsupportedVersion,
    #[error("the Gemini CLI account operation did not finish in time")]
    TimedOut,
    #[error("the Gemini CLI account operation ended unexpectedly")]
    ConnectionEnded,
    #[error("this managed Gemini profile is already connected")]
    AlreadyConnected,
    #[error("Gemini CLI sign-in was canceled")]
    Canceled,
    #[error("Gemini CLI sign-in finished without saving a Google sign-in")]
    AccountNotConfirmed,
    #[error("Gemini CLI sign-out could not remove the managed credentials")]
    LogoutNotConfirmed,
    #[error("KalCode could not record the provider account result")]
    StateUpdateFailed,
}

/// Reads one managed account's Gemini sign-in state from file metadata alone: `Authenticated`
/// when Gemini's encrypted credential store exists as an ordinary file, `NotAuthenticated`
/// otherwise. A plaintext `oauth_creds.json` never counts (managed launches don't use it; signing
/// in lets Gemini migrate a legacy copy into the encrypted store and delete it).
///
/// A link, reparse point or non-file where the store should be fails closed as an error.
pub fn credential_state(
    profiles: &ManagedProfiles,
    account_id: &str,
) -> Result<AuthState, ProviderError> {
    let home = profiles.profile_home(ProviderId::GEMINI_CLI, account_id)?;
    let Some(directory) = gemini_directory(&home)? else {
        return Ok(AuthState::NotAuthenticated);
    };
    if ordinary_file_exists(&directory.join(ENCRYPTED_CREDENTIALS_FILE))? {
        return Ok(AuthState::Authenticated);
    }
    Ok(AuthState::NotAuthenticated)
}

/// Reads one account's full Gemini state: [`credential_state`], plus, only when signed in, the
/// display identity from [`reported_identity`]. Identity problems never fail the read.
pub fn account_state(
    profiles: &ManagedProfiles,
    account_id: &str,
) -> Result<GeminiAccountState, ProviderError> {
    let auth = credential_state(profiles, account_id)?;
    let identity = if auth == AuthState::Authenticated {
        reported_identity(profiles, account_id)
    } else {
        None
    };
    Ok(GeminiAccountState { auth, identity })
}

/// The `active` email of this account's own `google_accounts.json`, or `None` when the file is
/// missing, not an ordinary file (link, reparse point, directory), larger than
/// [`MAX_GOOGLE_ACCOUNTS_BYTES`], not JSON, or its `active` is not an email-shaped string. No
/// other field (`old`) is kept and no other file is opened. Never logged.
pub fn reported_identity(profiles: &ManagedProfiles, account_id: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct GoogleAccounts {
        // Only `active` is declared: serde skips every other field (`old`) without keeping it.
        active: Option<serde_json::Value>,
    }

    let home = profiles
        .profile_home(ProviderId::GEMINI_CLI, account_id)
        .ok()?;
    let directory = gemini_directory(&home).ok()??;
    let expected = std::fs::canonicalize(&home)
        .ok()?
        .join(GEMINI_DIR)
        .join(GOOGLE_ACCOUNTS_FILE);
    let bytes = read_bounded_ordinary_file(
        &directory.join(GOOGLE_ACCOUNTS_FILE),
        &expected,
        MAX_GOOGLE_ACCOUNTS_BYTES,
    )?;
    let parsed: GoogleAccounts = serde_json::from_slice(&bytes).ok()?;
    let active = parsed.active?;
    let active = active.as_str()?;
    looks_like_email(active).then(|| active.to_owned())
}

/// A conservative display check, not RFC 5322: printable ASCII without spaces, exactly one `@`,
/// a non-empty local part and a dotted domain, at most `MAX_PROVIDER_IDENTITY_CHARS` long.
fn looks_like_email(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_PROVIDER_IDENTITY_CHARS
        || !value.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return false;
    }
    let mut parts = value.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty()
        && local.len() <= 64
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains("..")
}

/// Reads at most `cap` bytes from the ordinary file at `path` only when the opened handle is the
/// very file at `expected` (a canonical path inside the account's home). The path is inspected
/// before opening and opened without following a final link or reparse point (`O_NOFOLLOW`,
/// `FILE_FLAG_OPEN_REPARSE_POINT`). A parent directory swapped for a link or junction around the
/// open is caught afterwards without `unsafe`, the same way `kalcode-git` verifies its opens:
/// `expected` must still canonicalize to itself (no link anywhere on it now), and the opened
/// handle must be the same file as `expected` (volume serial + file index on Windows, device +
/// inode on Unix), so a handle opened through an outside link, even one swapped back, is refused.
fn read_bounded_ordinary_file(path: &Path, expected: &Path, cap: u64) -> Option<Vec<u8>> {
    use std::io::Read as _;

    let before = std::fs::symlink_metadata(path).ok()?;
    if !before.is_file() || is_link_or_reparse(&before) || before.len() > cap {
        return None;
    }
    let file = open_without_following(path).ok()?;
    let opened = file.metadata().ok()?;
    if !opened.is_file() || is_link_or_reparse(&opened) || opened.len() > cap {
        return None;
    }
    let opened = same_file::Handle::from_file(file).ok()?;
    if std::fs::canonicalize(expected).ok()? != expected
        || same_file::Handle::from_path(expected).ok()? != opened
    {
        return None;
    }
    let mut bytes = Vec::new();
    opened
        .as_file()
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (u64::try_from(bytes.len()).ok()? <= cap).then_some(bytes)
}

#[cfg(windows)]
fn open_without_following(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt as _;

    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(unix)]
fn open_without_following(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt as _;

    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

/// Removes this account's Gemini credential files. Requires the account's exclusive lease so no
/// session or sign-in can use the profile meanwhile. Settings, history and every other account
/// are untouched; a link or non-file where a credential should be fails closed untouched.
pub fn remove_credentials(
    profiles: &ManagedProfiles,
    account_id: &str,
    lease: &ProfileLease,
) -> Result<(), ProviderError> {
    if !lease.is_exclusive_for(profiles, ProviderId::GEMINI_CLI, account_id) {
        return Err(ProviderError::Start(
            "Gemini sign-out requires this account's exclusive profile lease".into(),
        ));
    }
    let home = profiles.profile_home(ProviderId::GEMINI_CLI, account_id)?;
    let Some(directory) = gemini_directory(&home)? else {
        return Ok(());
    };
    for name in SIGN_OUT_FILES {
        let path = directory.join(name);
        if ordinary_file_exists(&path)? {
            std::fs::remove_file(&path).map_err(|error| {
                ProviderError::Io(format!(
                    "couldn't remove a managed Gemini credential: {error}"
                ))
            })?;
        }
    }
    Ok(())
}

/// Records one account's current Gemini credential state while its exclusive lease is held. Needs
/// no provider process, so it works even when Gemini CLI is not installed.
pub fn read_account_with_lease_observed<F>(
    profiles: &ManagedProfiles,
    account_id: &str,
    lease: ProfileLease,
    observe: F,
) -> Result<GeminiAccountState, GeminiAccountAuthError>
where
    F: Fn(
        &Result<GeminiAccountState, GeminiAccountAuthError>,
    ) -> Result<(), GeminiAccountAuthError>,
{
    let mut result = read_leased(profiles, account_id, &lease);
    if observe(&result).is_err() {
        result = Err(GeminiAccountAuthError::StateUpdateFailed);
    }
    drop(lease);
    result
}

/// Observes credential presence under a read-only shared lease. The provider credential file is
/// never opened; only ordinary-file metadata and the bounded display identity are read. A pending
/// explicit sign-in, sign-out, or archive cancels the observer before it can publish stale state.
pub fn observe_account_with_lease_observed<F>(
    profiles: &ManagedProfiles,
    account_id: &str,
    lease: ProfileLease,
    observe: F,
) -> Result<GeminiAccountState, GeminiAccountAuthError>
where
    F: Fn(
        &Result<GeminiAccountState, GeminiAccountAuthError>,
    ) -> Result<(), GeminiAccountAuthError>,
{
    if !lease.is_observer_for(profiles, ProviderId::GEMINI_CLI, account_id) {
        return Err(GeminiAccountAuthError::ProfileUnavailable);
    }
    let cancellation = lease
        .observer_cancellation()
        .ok_or(GeminiAccountAuthError::ProfileUnavailable)?;
    if cancellation.load(Ordering::Acquire) {
        return Err(GeminiAccountAuthError::Canceled);
    }
    let mut result =
        account_state(profiles, account_id).map_err(|_| GeminiAccountAuthError::ProfileUnavailable);
    if cancellation.load(Ordering::Acquire) {
        return Err(GeminiAccountAuthError::Canceled);
    }
    if observe(&result).is_err() {
        result = Err(GeminiAccountAuthError::StateUpdateFailed);
    }
    result
}

/// Signs one account out by removing Gemini's own credential files for it (see
/// [`remove_credentials`]), then confirms the profile reads as signed out. Needs no provider
/// process, so a person can always sign out, even after uninstalling Gemini CLI.
pub fn logout_with_lease_observed<F>(
    profiles: &ManagedProfiles,
    account_id: &str,
    lease: ProfileLease,
    observe: F,
) -> Result<GeminiAccountState, GeminiAccountAuthError>
where
    F: Fn(
        &Result<GeminiAccountState, GeminiAccountAuthError>,
    ) -> Result<(), GeminiAccountAuthError>,
{
    let mut result = remove_credentials(profiles, account_id, &lease)
        .map_err(|_| GeminiAccountAuthError::LogoutNotConfirmed)
        .and_then(|()| read_leased(profiles, account_id, &lease))
        .and_then(|state| {
            (state.auth == AuthState::NotAuthenticated)
                .then_some(state)
                .ok_or(GeminiAccountAuthError::LogoutNotConfirmed)
        });
    if observe(&result).is_err() {
        result = Err(GeminiAccountAuthError::StateUpdateFailed);
    }
    drop(lease);
    result
}

fn read_leased(
    profiles: &ManagedProfiles,
    account_id: &str,
    lease: &ProfileLease,
) -> Result<GeminiAccountState, GeminiAccountAuthError> {
    if !lease.is_exclusive_for(profiles, ProviderId::GEMINI_CLI, account_id) {
        return Err(GeminiAccountAuthError::ProfileUnavailable);
    }
    account_state(profiles, account_id).map_err(|_| GeminiAccountAuthError::ProfileUnavailable)
}

fn gemini_directory(home: &Path) -> Result<Option<PathBuf>, ProviderError> {
    let directory = home.join(GEMINI_DIR);
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !is_link_or_reparse(&metadata) => Ok(Some(directory)),
        Ok(_) => Err(ProviderError::Start(
            "the managed Gemini profile directory is not an ordinary directory".into(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(ProviderError::Io(format!(
            "couldn't inspect the managed Gemini profile: {error}"
        ))),
    }
}

fn ordinary_file_exists(path: &Path) -> Result<bool, ProviderError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !is_link_or_reparse(&metadata) => Ok(true),
        Ok(_) => Err(ProviderError::Start(
            "a managed Gemini credential path is not an ordinary file".into(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(ProviderError::Io(format!(
            "couldn't inspect a managed Gemini credential: {error}"
        ))),
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

#[derive(Clone, Copy)]
struct AuthTimeouts {
    version: Duration,
    login: Duration,
    terminate_grace: Duration,
}

impl Default for AuthTimeouts {
    fn default() -> Self {
        Self {
            version: VERSION_TIMEOUT,
            login: LOGIN_TIMEOUT,
            terminate_grace: TERMINATE_GRACE,
        }
    }
}

#[derive(Clone)]
enum LaunchMode {
    Production,
    #[cfg(test)]
    Test {
        args: Vec<OsString>,
        extra_env: BTreeMap<OsString, OsString>,
    },
}

/// Runs Gemini CLI's own sign-in, status and sign-out for one isolated managed account profile.
pub struct GeminiAccountAuthManager {
    executable: PathBuf,
    source_env: DetectEnv,
    profiles: Arc<ManagedProfiles>,
    launch_mode: LaunchMode,
    timeouts: AuthTimeouts,
}

impl fmt::Debug for GeminiAccountAuthManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GeminiAccountAuthManager")
            .field("executable", &self.executable)
            .field("source_env", &"[redacted]")
            .field("profiles", &"managed")
            .finish_non_exhaustive()
    }
}

impl GeminiAccountAuthManager {
    pub fn new(executable: PathBuf, source_env: DetectEnv, profiles: Arc<ManagedProfiles>) -> Self {
        Self {
            executable,
            source_env,
            profiles,
            launch_mode: LaunchMode::Production,
            timeouts: AuthTimeouts::default(),
        }
    }

    #[cfg(test)]
    fn new_for_test(
        executable: PathBuf,
        source_env: DetectEnv,
        profiles: Arc<ManagedProfiles>,
        args: Vec<OsString>,
        extra_env: BTreeMap<OsString, OsString>,
        timeouts: AuthTimeouts,
    ) -> Self {
        Self {
            executable,
            source_env,
            profiles,
            launch_mode: LaunchMode::Test { args, extra_env },
            timeouts,
        }
    }

    /// Starts Gemini's own browser sign-in. The returned handle owns the exclusive lease until the
    /// provider process tree has exited (or, if that cannot be proven, until process restart).
    pub fn start_login_with_lease_observed<F>(
        &self,
        account_id: &str,
        lease: ProfileLease,
        observe: F,
    ) -> Result<PendingGeminiLogin, GeminiAccountAuthError>
    where
        F: Fn(
                &Result<GeminiAccountState, GeminiAccountAuthError>,
            ) -> Result<(), GeminiAccountAuthError>
            + Send
            + 'static,
    {
        let before = self.read_leased(account_id, &lease)?;
        if before.logged_in() {
            if observe(&Ok(before)).is_err() {
                return Err(GeminiAccountAuthError::StateUpdateFailed);
            }
            return Err(GeminiAccountAuthError::AlreadyConnected);
        }
        let prepared = self.prepare(account_id, lease)?;
        let spec = self.spec(&prepared);
        let spawned = match &self.launch_mode {
            LaunchMode::Production => {
                let job = prepared
                    .lease
                    .prepare_guarded_job("gemini-auth-login")
                    .map_err(|_| GeminiAccountAuthError::StartFailed)?;
                SupervisedChild::spawn_guarded(&spec, job)
            }
            #[cfg(test)]
            LaunchMode::Test { .. } => SupervisedChild::spawn(&spec),
        };
        let (child, output) = spawned.map_err(|_| GeminiAccountAuthError::StartFailed)?;
        // The person chose Sign in: answer Gemini's own "open the browser?" consent, then end
        // input so nothing else can ever be read from KalCode.
        let consented = child.write_line("y");
        child.close_stdin();
        if consented.is_err() {
            cleanup_failed_start(&child, prepared, self.timeouts.terminate_grace);
            return Err(GeminiAccountAuthError::StartFailed);
        }
        // Output may include the one-time browser URL. Drain it so the provider never sees a
        // broken pipe, but discard every bounded line without logging or crossing the WebView.
        let drained = thread::Builder::new()
            .name("gemini-account-login-output".into())
            .spawn(move || while output.recv().is_ok() {});
        if drained.is_err() {
            cleanup_failed_start(&child, prepared, self.timeouts.terminate_grace);
            return Err(GeminiAccountAuthError::StartFailed);
        }

        let child = Arc::new(child);
        let worker_child = Arc::clone(&child);
        let outcome = Arc::new(LoginOutcome::default());
        let worker_outcome = Arc::clone(&outcome);
        let canceled = Arc::new(AtomicBool::new(false));
        let worker_canceled = Arc::clone(&canceled);
        let timeouts = self.timeouts;
        let profiles = Arc::clone(&self.profiles);
        let account = account_id.to_owned();
        let prepared = Arc::new(Mutex::new(Some(prepared)));
        let worker_prepared = Arc::clone(&prepared);
        let worker = thread::Builder::new()
            .name("gemini-account-login".into())
            .spawn(move || {
                let Some(prepared) = lock(&worker_prepared).take() else {
                    worker_outcome.complete(Err(GeminiAccountAuthError::ConnectionEnded), false);
                    return;
                };
                let deadline = Instant::now() + timeouts.login;
                let mut cleanup_proven = true;
                let exited = loop {
                    if worker_canceled.load(Ordering::Acquire) {
                        break match worker_child.terminate(timeouts.terminate_grace) {
                            Ok(Some(_)) => Err(GeminiAccountAuthError::Canceled),
                            Ok(None) | Err(_) => {
                                cleanup_proven = false;
                                Err(GeminiAccountAuthError::ConnectionEnded)
                            }
                        };
                    }
                    match worker_child.try_status() {
                        Ok(Some(status)) => break Ok(status.success()),
                        Ok(None) if Instant::now() >= deadline => {
                            break match worker_child.terminate(timeouts.terminate_grace) {
                                Ok(Some(_)) => Err(GeminiAccountAuthError::TimedOut),
                                Ok(None) | Err(_) => {
                                    cleanup_proven = false;
                                    Err(GeminiAccountAuthError::ConnectionEnded)
                                }
                            };
                        }
                        Ok(None) => thread::sleep(Duration::from_millis(25)),
                        Err(_) => {
                            cleanup_proven = false;
                            break Err(GeminiAccountAuthError::ConnectionEnded);
                        }
                    }
                };
                // Gemini exits 0 after `--list-extensions` even when the person declined or the
                // browser flow failed, so its own credential cache is the only success signal.
                let mut result = exited.and_then(|succeeded| {
                    let state = account_state(&profiles, &account)
                        .map_err(|_| GeminiAccountAuthError::ProfileUnavailable)?;
                    match (state.logged_in(), succeeded) {
                        (true, _) => Ok(state),
                        (false, true) => Err(GeminiAccountAuthError::AccountNotConfirmed),
                        (false, false) => Err(GeminiAccountAuthError::ConnectionEnded),
                    }
                });
                if observe(&result).is_err() {
                    result = Err(GeminiAccountAuthError::StateUpdateFailed);
                }
                if cleanup_proven {
                    drop(prepared);
                } else {
                    // No account-scoped session may start after cleanup ceased to be provable.
                    // Deliberately retain the exclusive lease until process restart.
                    prepared.retain_lease_fail_closed();
                }
                worker_outcome.complete(result, cleanup_proven);
            });
        if worker.is_err() {
            if let Some(prepared) = lock(&prepared).take() {
                cleanup_failed_start(&child, prepared, self.timeouts.terminate_grace);
            }
            return Err(GeminiAccountAuthError::StartFailed);
        }
        Ok(PendingGeminiLogin {
            outcome,
            canceled,
            wait_timeout: self.timeouts.login + self.timeouts.version,
            terminate_grace: self.timeouts.terminate_grace,
        })
    }

    fn read_leased(
        &self,
        account_id: &str,
        lease: &ProfileLease,
    ) -> Result<GeminiAccountState, GeminiAccountAuthError> {
        read_leased(&self.profiles, account_id, lease)
    }

    fn prepare(
        &self,
        account_id: &str,
        lease: ProfileLease,
    ) -> Result<PreparedSignIn, GeminiAccountAuthError> {
        let launch =
            ManagedGeminiSignIn::prepare(&self.profiles, &self.source_env, account_id, &lease)
                .map_err(|_| GeminiAccountAuthError::ProfileUnavailable)?;
        if matches!(self.launch_mode, LaunchMode::Production) {
            let job = lease
                .prepare_guarded_job("gemini-auth-version")
                .map_err(|_| GeminiAccountAuthError::StartFailed)?;
            verify_certified_version(
                &self.executable,
                launch.environment(),
                launch.cwd(),
                self.timeouts.version,
                job,
            )?;
        }
        Ok(PreparedSignIn { launch, lease })
    }

    fn spec(&self, prepared: &PreparedSignIn) -> ProcessSpec {
        let (env, args) = match &self.launch_mode {
            LaunchMode::Production => (
                prepared.launch.environment().clone(),
                prepared.launch.args().to_vec(),
            ),
            #[cfg(test)]
            LaunchMode::Test {
                args: test_args,
                extra_env,
            } => {
                let mut env = prepared.launch.environment().clone();
                env.extend(extra_env.clone());
                env.insert(
                    "GEMINI_AUTH_TEST_REAL_ARGS".into(),
                    prepared
                        .launch
                        .args()
                        .iter()
                        .map(|arg| arg.to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("\u{1f}")
                        .into(),
                );
                (env, test_args.clone())
            }
        };
        ProcessSpec {
            program: self.executable.clone(),
            args,
            cwd: Some(prepared.launch.cwd().to_path_buf()),
            env,
        }
    }
}

struct PreparedSignIn {
    launch: ManagedGeminiSignIn,
    lease: ProfileLease,
}

impl PreparedSignIn {
    fn retain_lease_fail_closed(self) {
        std::mem::forget(self.lease);
    }
}

fn cleanup_failed_start(child: &SupervisedChild, prepared: PreparedSignIn, grace: Duration) {
    if !matches!(child.terminate(grace), Ok(Some(_))) {
        prepared.retain_lease_fail_closed();
    }
}

fn verify_certified_version(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    cwd: &Path,
    timeout: Duration,
    guardian_job: crate::guardian::RegisteredJob,
) -> Result<(), GeminiAccountAuthError> {
    let output = run_probe_guarded(
        &ProcessSpec {
            program: executable.to_path_buf(),
            args: vec!["--version".into()],
            cwd: Some(cwd.to_path_buf()),
            env: env.clone(),
        },
        guardian_job,
        timeout,
        true,
        4096,
    )
    .map_err(|error| match error {
        crate::process::ProcessError::TimedOut(_) => GeminiAccountAuthError::TimedOut,
        crate::process::ProcessError::Spawn(_) => GeminiAccountAuthError::StartFailed,
        _ => GeminiAccountAuthError::ConnectionEnded,
    })?;
    check_reported_version(output.status.success(), &output.stdout)
}

/// Accepts a `--version` report only when the probe succeeded and the reported release passes the
/// same managed-version predicate thread start uses.
fn check_reported_version(succeeded: bool, stdout: &str) -> Result<(), GeminiAccountAuthError> {
    let found = Version::find_in(stdout).ok_or(GeminiAccountAuthError::UnsupportedVersion)?;
    if !succeeded || !crate::gemini::managed_version_supported(&found) {
        return Err(GeminiAccountAuthError::UnsupportedVersion);
    }
    Ok(())
}

/// One native Gemini sign-in process. No auth URL or provider output is exposed to the WebView.
pub struct PendingGeminiLogin {
    outcome: Arc<LoginOutcome>,
    canceled: Arc<AtomicBool>,
    wait_timeout: Duration,
    terminate_grace: Duration,
}

impl fmt::Debug for PendingGeminiLogin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingGeminiLogin")
            .field("provider", &ProviderId::GEMINI_CLI)
            .finish_non_exhaustive()
    }
}

impl PendingGeminiLogin {
    pub fn wait(&self) -> Result<GeminiAccountState, GeminiAccountAuthError> {
        match self.outcome.wait(self.wait_timeout) {
            Err(GeminiAccountAuthError::TimedOut) => {
                self.canceled.store(true, Ordering::Release);
                Err(GeminiAccountAuthError::TimedOut)
            }
            outcome => outcome,
        }
    }

    pub fn cancel(&self) -> Result<(), GeminiAccountAuthError> {
        self.canceled.store(true, Ordering::Release);
        let terminal = self
            .outcome
            .wait_terminal(self.terminate_grace + Duration::from_secs(5))?;
        if terminal.quiesced {
            Ok(())
        } else {
            Err(GeminiAccountAuthError::ConnectionEnded)
        }
    }

    pub fn is_finished(&self) -> bool {
        self.outcome.is_quiesced()
    }
}

impl Drop for PendingGeminiLogin {
    fn drop(&mut self) {
        if self.outcome.peek().is_none() {
            self.canceled.store(true, Ordering::Release);
        }
    }
}

#[derive(Default)]
struct LoginOutcome {
    value: Mutex<Option<LoginTerminal>>,
    changed: Condvar,
}

#[derive(Clone)]
struct LoginTerminal {
    result: Result<GeminiAccountState, GeminiAccountAuthError>,
    quiesced: bool,
}

impl LoginOutcome {
    fn complete(&self, result: Result<GeminiAccountState, GeminiAccountAuthError>, quiesced: bool) {
        *lock(&self.value) = Some(LoginTerminal { result, quiesced });
        self.changed.notify_all();
    }

    fn peek(&self) -> Option<LoginTerminal> {
        lock(&self.value).clone()
    }

    fn is_quiesced(&self) -> bool {
        self.peek().is_some_and(|terminal| terminal.quiesced)
    }

    fn wait(&self, timeout: Duration) -> Result<GeminiAccountState, GeminiAccountAuthError> {
        self.wait_terminal(timeout)?.result
    }

    fn wait_terminal(&self, timeout: Duration) -> Result<LoginTerminal, GeminiAccountAuthError> {
        let deadline = Instant::now() + timeout;
        let mut value = lock(&self.value);
        loop {
            if let Some(value) = value.clone() {
                return Ok(value);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(GeminiAccountAuthError::TimedOut);
            }
            let waited = self
                .changed
                .wait_timeout(value, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            value = waited.0;
            if waited.1.timed_out() && value.is_none() {
                return Err(GeminiAccountAuthError::TimedOut);
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT_ID: &str = "7a1c6a3e-5a0b-4d7e-9f3a-2b6f0c1d8e94";
    const OTHER_ACCOUNT_ID: &str = "0b9e2f4c-1d3a-4c5b-8e7f-6a2d9c0b1e33";

    struct Fixture {
        _temp: tempfile::TempDir,
        profiles: Arc<ManagedProfiles>,
        manager: GeminiAccountAuthManager,
        // Fields drop in declaration order. Keep the shared slot last so it covers the child,
        // bounded process cleanup, profile authority and temporary-root teardown.
        _recursive_test_process_slot: std::sync::MutexGuard<'static, ()>,
    }

    fn fixture(scenario: &str) -> Fixture {
        let recursive_test_process_slot = lock(&crate::RECURSIVE_TEST_EXECUTABLE_SLOT);
        let temp = tempfile::tempdir().expect("tempdir");
        let temp_root = if cfg!(target_os = "macos") {
            temp.path().canonicalize().expect("canonical tempdir")
        } else {
            temp.path().to_path_buf()
        };
        let ordinary = temp_root.join("ordinary");
        std::fs::create_dir_all(ordinary.join(".gemini")).expect("ordinary home");
        std::fs::write(
            ordinary.join(".gemini").join(ENCRYPTED_CREDENTIALS_FILE),
            b"opaque",
        )
        .expect("standalone credential that must never be used");
        let profiles =
            Arc::new(ManagedProfiles::new(temp_root.join("managed-profiles")).expect("profiles"));
        let extra_env: BTreeMap<OsString, OsString> = [
            ("GEMINI_AUTH_TEST_OPERATION".into(), "login".into()),
            ("GEMINI_AUTH_TEST_SCENARIO".into(), scenario.into()),
        ]
        .into_iter()
        .collect();
        let manager = GeminiAccountAuthManager::new_for_test(
            std::env::current_exe().expect("test executable"),
            DetectEnv {
                vars: vec![
                    ("HOME".into(), ordinary.clone().into_os_string()),
                    ("USERPROFILE".into(), ordinary.into_os_string()),
                    ("GEMINI_API_KEY".into(), "must-not-reach-child".into()),
                    ("GOOGLE_API_KEY".into(), "must-not-reach-child".into()),
                    ("NO_BROWSER".into(), "true".into()),
                    (
                        "GEMINI_CLI_HOME".into(),
                        temp_root.join("hostile").into_os_string(),
                    ),
                ],
                windows: cfg!(windows),
                probe_timeout: Some(Duration::from_secs(2)),
                system_root: None,
            },
            Arc::clone(&profiles),
            vec![
                "--exact".into(),
                "gemini_account_auth::tests::fake_gemini_cli".into(),
                "--nocapture".into(),
            ],
            extra_env,
            AuthTimeouts {
                version: Duration::from_secs(2),
                login: Duration::from_secs(5),
                terminate_grace: Duration::from_millis(50),
            },
        );
        Fixture {
            _temp: temp,
            profiles,
            manager,
            _recursive_test_process_slot: recursive_test_process_slot,
        }
    }

    fn credentials(profiles: &ManagedProfiles, account_id: &str) -> PathBuf {
        profiles
            .profile_home("gemini-cli", account_id)
            .expect("home")
            .join(GEMINI_DIR)
    }

    #[test]
    fn sign_in_version_check_accepts_patch_releases_in_the_certified_line() {
        for reported in [
            "0.61.0
", "0.61.3
",
        ] {
            assert_eq!(check_reported_version(true, reported), Ok(()), "{reported}");
        }
    }

    #[test]
    fn sign_in_version_check_refuses_versions_outside_the_certified_line() {
        for reported in [
            "0.60.9
",
            "0.62.0
",
            "0.61.0-preview.1
",
            "1.0.0
",
            "not a version
",
        ] {
            assert_eq!(
                check_reported_version(true, reported),
                Err(GeminiAccountAuthError::UnsupportedVersion),
                "{reported}"
            );
        }
        assert_eq!(
            check_reported_version(
                false, "0.61.0
"
            ),
            Err(GeminiAccountAuthError::UnsupportedVersion),
            "a failed probe is never trusted"
        );
    }

    #[test]
    fn credential_state_reads_only_this_accounts_profile_metadata() {
        let fixture = fixture("unused");
        assert_eq!(
            credential_state(&fixture.profiles, ACCOUNT_ID).expect("state"),
            AuthState::NotAuthenticated,
            "the standalone ~/.gemini sign-in never counts for a managed account"
        );
        let directory = credentials(&fixture.profiles, ACCOUNT_ID);
        std::fs::create_dir_all(&directory).expect("gemini dir");
        assert_eq!(
            credential_state(&fixture.profiles, ACCOUNT_ID).expect("state"),
            AuthState::NotAuthenticated
        );
        std::fs::write(directory.join(LEGACY_PLAINTEXT_CREDENTIALS_FILE), b"opaque")
            .expect("legacy plaintext");
        assert_eq!(
            credential_state(&fixture.profiles, ACCOUNT_ID).expect("state"),
            AuthState::NotAuthenticated,
            "a plaintext credential is never what a managed account signs in with"
        );
        std::fs::write(directory.join(ENCRYPTED_CREDENTIALS_FILE), b"opaque").expect("store");
        assert_eq!(
            credential_state(&fixture.profiles, ACCOUNT_ID).expect("state"),
            AuthState::Authenticated
        );
        assert_eq!(
            credential_state(&fixture.profiles, OTHER_ACCOUNT_ID).expect("state"),
            AuthState::NotAuthenticated,
            "accounts never share credentials"
        );
    }

    #[test]
    fn credential_state_fails_closed_on_a_non_file_credential() {
        let fixture = fixture("unused");
        let directory = credentials(&fixture.profiles, ACCOUNT_ID);
        std::fs::create_dir_all(directory.join(ENCRYPTED_CREDENTIALS_FILE)).expect("directory");
        assert!(credential_state(&fixture.profiles, ACCOUNT_ID).is_err());
    }

    #[test]
    fn sign_out_removes_only_this_accounts_gemini_credentials() {
        let fixture = fixture("unused");
        for account in [ACCOUNT_ID, OTHER_ACCOUNT_ID] {
            let directory = credentials(&fixture.profiles, account);
            std::fs::create_dir_all(&directory).expect("gemini dir");
            for name in SIGN_OUT_FILES {
                std::fs::write(directory.join(name), b"opaque").expect("credential");
            }
            std::fs::write(directory.join("settings.json"), b"{}").expect("settings");
        }
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("gemini-cli", ACCOUNT_ID)
            .expect("lease");
        let state = logout_with_lease_observed(&fixture.profiles, ACCOUNT_ID, lease, |result| {
            assert!(result.is_ok());
            Ok(())
        })
        .expect("signed out");
        assert_eq!(state.auth, AuthState::NotAuthenticated);

        let mine = credentials(&fixture.profiles, ACCOUNT_ID);
        for name in SIGN_OUT_FILES {
            assert!(!mine.join(name).exists(), "{name} survived sign-out");
        }
        assert!(
            mine.join("settings.json").exists(),
            "sign-out leaves provider settings alone"
        );
        let other = credentials(&fixture.profiles, OTHER_ACCOUNT_ID);
        for name in SIGN_OUT_FILES {
            assert!(
                other.join(name).exists(),
                "another account's {name} was touched"
            );
        }
        assert_eq!(
            credential_state(&fixture.profiles, OTHER_ACCOUNT_ID).expect("state"),
            AuthState::Authenticated
        );
    }

    #[test]
    fn sign_out_requires_this_accounts_exclusive_lease() {
        let fixture = fixture("unused");
        let directory = credentials(&fixture.profiles, ACCOUNT_ID);
        std::fs::create_dir_all(&directory).expect("gemini dir");
        std::fs::write(directory.join(ENCRYPTED_CREDENTIALS_FILE), b"opaque").expect("store");

        let shared = fixture
            .profiles
            .acquire_session_lease("gemini-cli", ACCOUNT_ID)
            .expect("session lease");
        assert!(remove_credentials(&fixture.profiles, ACCOUNT_ID, &shared).is_err());
        drop(shared);
        let other = fixture
            .profiles
            .acquire_sign_in_lease("gemini-cli", OTHER_ACCOUNT_ID)
            .expect("other lease");
        assert!(remove_credentials(&fixture.profiles, ACCOUNT_ID, &other).is_err());
        assert!(directory.join(ENCRYPTED_CREDENTIALS_FILE).exists());
    }

    #[test]
    fn login_runs_gemini_in_the_account_profile_and_confirms_its_credential() {
        let fixture = fixture("login_success");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("gemini-cli", ACCOUNT_ID)
            .expect("lease");
        let pending = fixture
            .manager
            .start_login_with_lease_observed(ACCOUNT_ID, lease, |_| Ok(()))
            .expect("login");
        assert!(
            fixture
                .profiles
                .acquire_session_lease("gemini-cli", ACCOUNT_ID)
                .is_err(),
            "no thread can use the profile while sign-in runs"
        );
        let state = pending.wait().expect("confirmed sign-in");
        assert_eq!(state.auth, AuthState::Authenticated);
        assert_eq!(
            state.identity.as_deref(),
            Some("signed.in@example.com"),
            "a confirmed sign-in reports Gemini's active Google account"
        );
        let directory = credentials(&fixture.profiles, ACCOUNT_ID);
        assert!(directory.join(ENCRYPTED_CREDENTIALS_FILE).is_file());
        assert!(
            !directory.join(LEGACY_PLAINTEXT_CREDENTIALS_FILE).exists(),
            "Google sign-in is never stored in plaintext"
        );
        assert_eq!(
            credential_state(&fixture.profiles, OTHER_ACCOUNT_ID).expect("state"),
            AuthState::NotAuthenticated
        );
        let _lease = fixture
            .profiles
            .acquire_session_lease("gemini-cli", ACCOUNT_ID)
            .expect("lease released after confirmation");
    }

    #[test]
    fn login_that_saves_no_credential_is_not_reported_as_signed_in() {
        let fixture = fixture("login_declined");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("gemini-cli", ACCOUNT_ID)
            .expect("lease");
        let observed = Arc::new(Mutex::new(None));
        let record = Arc::clone(&observed);
        let pending = fixture
            .manager
            .start_login_with_lease_observed(ACCOUNT_ID, lease, move |result| {
                *lock(&record) = Some(result.clone());
                Ok(())
            })
            .expect("login");
        assert_eq!(
            pending.wait(),
            Err(GeminiAccountAuthError::AccountNotConfirmed)
        );
        assert_eq!(
            lock(&observed).clone(),
            Some(Err(GeminiAccountAuthError::AccountNotConfirmed))
        );
    }

    #[test]
    fn login_refuses_an_already_connected_profile_without_starting_gemini() {
        let fixture = fixture("login_must_not_run");
        let directory = credentials(&fixture.profiles, ACCOUNT_ID);
        std::fs::create_dir_all(&directory).expect("gemini dir");
        std::fs::write(directory.join(ENCRYPTED_CREDENTIALS_FILE), b"opaque").expect("store");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("gemini-cli", ACCOUNT_ID)
            .expect("lease");
        assert!(matches!(
            fixture
                .manager
                .start_login_with_lease_observed(ACCOUNT_ID, lease, |_| Ok(())),
            Err(GeminiAccountAuthError::AlreadyConnected)
        ));
    }

    #[test]
    fn login_rejects_a_lease_for_another_account() {
        let fixture = fixture("login_must_not_run");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("gemini-cli", OTHER_ACCOUNT_ID)
            .expect("lease");
        assert!(matches!(
            fixture
                .manager
                .start_login_with_lease_observed(ACCOUNT_ID, lease, |_| Ok(())),
            Err(GeminiAccountAuthError::ProfileUnavailable)
        ));
    }

    #[test]
    fn cancel_waits_for_process_cleanup_before_releasing_profile() {
        let fixture = fixture("login_hang");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("gemini-cli", ACCOUNT_ID)
            .expect("lease");
        let pending = fixture
            .manager
            .start_login_with_lease_observed(ACCOUNT_ID, lease, |_| Ok(()))
            .expect("login");
        pending.cancel().expect("cancel");
        assert!(pending.is_finished());
        let _lease = fixture
            .profiles
            .acquire_session_lease("gemini-cli", ACCOUNT_ID)
            .expect("cancel returns only after process cleanup");
        assert_eq!(pending.wait(), Err(GeminiAccountAuthError::Canceled));
    }

    /// Writes a signed-in managed profile for `account_id`, with `google_accounts` when given.
    fn signed_in(profiles: &ManagedProfiles, account_id: &str, google_accounts: Option<&[u8]>) {
        let directory = credentials(profiles, account_id);
        std::fs::create_dir_all(&directory).expect("gemini dir");
        std::fs::write(directory.join(ENCRYPTED_CREDENTIALS_FILE), b"opaque").expect("store");
        if let Some(contents) = google_accounts {
            std::fs::write(directory.join(GOOGLE_ACCOUNTS_FILE), contents).expect("accounts");
        }
    }

    fn refreshed(profiles: &ManagedProfiles, account_id: &str) -> GeminiAccountState {
        let lease = profiles
            .acquire_sign_in_lease("gemini-cli", account_id)
            .expect("lease");
        read_account_with_lease_observed(profiles, account_id, lease, |_| Ok(())).expect("refresh")
    }

    #[test]
    fn identity_is_the_active_google_account_of_a_signed_in_profile() {
        let fixture = fixture("unused");
        signed_in(
            &fixture.profiles,
            ACCOUNT_ID,
            Some(br#"{"active":"person@example.com","old":[]}"#),
        );
        let state = refreshed(&fixture.profiles, ACCOUNT_ID);
        assert_eq!(state.auth, AuthState::Authenticated);
        assert_eq!(state.identity.as_deref(), Some("person@example.com"));
    }

    #[test]
    fn identity_never_comes_from_old_accounts() {
        let fixture = fixture("unused");
        signed_in(
            &fixture.profiles,
            ACCOUNT_ID,
            Some(br#"{"old":["former@example.com"],"active":"current@example.com"}"#),
        );
        assert_eq!(
            refreshed(&fixture.profiles, ACCOUNT_ID).identity.as_deref(),
            Some("current@example.com")
        );
        for contents in [
            &br#"{"active":null,"old":["former@example.com"]}"#[..],
            br#"{"old":["former@example.com"]}"#,
            br#"{"active":["former@example.com"]}"#,
        ] {
            signed_in(&fixture.profiles, ACCOUNT_ID, Some(contents));
            let state = refreshed(&fixture.profiles, ACCOUNT_ID);
            assert_eq!(state.auth, AuthState::Authenticated);
            assert_eq!(
                state.identity,
                None,
                "{}",
                String::from_utf8_lossy(contents)
            );
        }
    }

    #[test]
    fn identity_ignores_an_oversized_accounts_file() {
        let fixture = fixture("unused");
        let mut contents = br#"{"active":"person@example.com","pad":""#.to_vec();
        let cap = usize::try_from(MAX_GOOGLE_ACCOUNTS_BYTES).expect("cap");
        contents.resize(cap + 16, b'x');
        contents.extend_from_slice(br#""}"#);
        signed_in(&fixture.profiles, ACCOUNT_ID, Some(&contents));
        let state = refreshed(&fixture.profiles, ACCOUNT_ID);
        assert_eq!(
            state.auth,
            AuthState::Authenticated,
            "label-only, still signed in"
        );
        assert_eq!(state.identity, None);

        let mut at_cap = br#"{"active":"person@example.com","pad":""#.to_vec();
        at_cap.resize(cap - 2, b'x');
        at_cap.extend_from_slice(br#""}"#);
        assert_eq!(at_cap.len(), cap);
        signed_in(&fixture.profiles, ACCOUNT_ID, Some(&at_cap));
        assert_eq!(
            refreshed(&fixture.profiles, ACCOUNT_ID).identity.as_deref(),
            Some("person@example.com"),
            "a file exactly at the cap is still read"
        );
    }

    #[test]
    fn identity_rejects_garbage_and_non_email_values() {
        let fixture = fixture("unused");
        let too_long = format!(
            r#"{{"active":"{}@example.com"}}"#,
            "a".repeat(MAX_PROVIDER_IDENTITY_CHARS)
        );
        let long_domain = format!(
            r#"{{"active":"a@{}.com"}}"#,
            "d".repeat(MAX_PROVIDER_IDENTITY_CHARS)
        );
        for contents in [
            "",
            "not json",
            "[]",
            r#"{"active":42}"#,
            r#"{"active":""}"#,
            r#"{"active":"not-an-email"}"#,
            r#"{"active":"two@@example.com"}"#,
            r#"{"active":"a@b@example.com"}"#,
            r#"{"active":"@example.com"}"#,
            r#"{"active":"person@localhost"}"#,
            r#"{"active":"person@.example.com"}"#,
            r#"{"active":"person@example..com"}"#,
            r#"{"active":"person name@example.com"}"#,
            r#"{"active":"person@example.com\n"}"#,
            r#"{"active":"person\u0000@example.com"}"#,
            r#"{"active":"person\u202e@example.com"}"#,
            r#"{"active":"pérson@example.com"}"#,
            too_long.as_str(),
            long_domain.as_str(),
        ] {
            signed_in(&fixture.profiles, ACCOUNT_ID, Some(contents.as_bytes()));
            let state = refreshed(&fixture.profiles, ACCOUNT_ID);
            assert_eq!(state.auth, AuthState::Authenticated);
            assert_eq!(state.identity, None, "{contents}");
        }
    }

    #[test]
    fn identity_is_absent_when_the_accounts_file_is_missing_or_not_a_file() {
        let fixture = fixture("unused");
        signed_in(&fixture.profiles, ACCOUNT_ID, None);
        let state = refreshed(&fixture.profiles, ACCOUNT_ID);
        assert_eq!(state.auth, AuthState::Authenticated);
        assert_eq!(state.identity, None);

        std::fs::create_dir_all(
            credentials(&fixture.profiles, ACCOUNT_ID).join(GOOGLE_ACCOUNTS_FILE),
        )
        .expect("directory in place of the file");
        let state = refreshed(&fixture.profiles, ACCOUNT_ID);
        assert_eq!(state.auth, AuthState::Authenticated);
        assert_eq!(state.identity, None);
    }

    #[test]
    fn identity_is_never_read_for_a_signed_out_profile() {
        let fixture = fixture("unused");
        let directory = credentials(&fixture.profiles, ACCOUNT_ID);
        std::fs::create_dir_all(&directory).expect("gemini dir");
        std::fs::write(
            directory.join(GOOGLE_ACCOUNTS_FILE),
            br#"{"active":"stale@example.com"}"#,
        )
        .expect("accounts");
        let state = refreshed(&fixture.profiles, ACCOUNT_ID);
        assert_eq!(state.auth, AuthState::NotAuthenticated);
        assert_eq!(state.identity, None);
    }

    #[test]
    fn identity_never_follows_a_linked_accounts_file() {
        let fixture = fixture("unused");
        signed_in(&fixture.profiles, ACCOUNT_ID, None);
        let outside = fixture._temp.path().join("outside-accounts.json");
        std::fs::write(&outside, br#"{"active":"outside@example.com"}"#).expect("outside");
        let link = credentials(&fixture.profiles, ACCOUNT_ID).join(GOOGLE_ACCOUNTS_FILE);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, &link);
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&outside, &link);
        if linked.is_err() {
            // Windows without symlink privilege (no Developer Mode) cannot create a file symlink;
            // the directory-in-place and junction cases still exercise the same checks here.
            eprintln!("skipping: this host cannot create file symlinks");
            return;
        }
        let state = refreshed(&fixture.profiles, ACCOUNT_ID);
        assert_eq!(state.auth, AuthState::Authenticated);
        assert_eq!(
            state.identity, None,
            "a linked accounts file is never followed"
        );
    }

    /// Links `link` to the directory `target`: a junction on Windows (no privilege needed), a
    /// symlink on Unix.
    fn link_directory(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            let created = std::process::Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(link)
                .arg(target)
                .output()
                .expect("mklink");
            assert!(created.status.success(), "junction");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).expect("directory symlink");
    }

    fn unlink_directory(link: &Path) {
        #[cfg(windows)]
        std::fs::remove_dir(link).expect("remove junction");
        #[cfg(unix)]
        std::fs::remove_file(link).expect("remove symlink");
    }

    /// An outside `.gemini` look-alike holding a signed-in store and a spoofed email.
    fn outside_gemini(fixture: &Fixture) -> PathBuf {
        let outside = fixture._temp.path().join("outside-gemini");
        std::fs::create_dir_all(&outside).expect("outside");
        std::fs::write(outside.join(ENCRYPTED_CREDENTIALS_FILE), b"opaque").expect("store");
        std::fs::write(
            outside.join(GOOGLE_ACCOUNTS_FILE),
            br#"{"active":"outside@example.com"}"#,
        )
        .expect("accounts");
        outside
    }

    #[test]
    fn identity_never_follows_a_linked_gemini_directory() {
        let fixture = fixture("unused");
        let outside = outside_gemini(&fixture);
        let home = fixture
            .profiles
            .profile_home("gemini-cli", ACCOUNT_ID)
            .expect("home");
        let link = home.join(GEMINI_DIR);
        link_directory(&outside, &link);
        assert_eq!(reported_identity(&fixture.profiles, ACCOUNT_ID), None);
        assert!(
            account_state(&fixture.profiles, ACCOUNT_ID).is_err(),
            "a linked profile directory fails closed"
        );
        unlink_directory(&link);
    }

    /// The race the directory pre-check cannot close: `.gemini` swapped for a link to an outside
    /// directory between the check and the open (then possibly swapped back). The open goes
    /// through the link; the post-open verification must refuse the handle either way.
    #[test]
    fn identity_refuses_a_handle_opened_through_a_swapped_gemini_directory() {
        let fixture = fixture("unused");
        let outside = outside_gemini(&fixture);
        signed_in(
            &fixture.profiles,
            ACCOUNT_ID,
            Some(br#"{"active":"inside@example.com"}"#),
        );
        let home = fixture
            .profiles
            .profile_home("gemini-cli", ACCOUNT_ID)
            .expect("home");
        let expected = std::fs::canonicalize(&home)
            .expect("canonical home")
            .join(GEMINI_DIR)
            .join(GOOGLE_ACCOUNTS_FILE);
        let cap = MAX_GOOGLE_ACCOUNTS_BYTES;

        // Control: the account's own file, opened directly, is read.
        assert!(
            read_bounded_ordinary_file(
                &home.join(GEMINI_DIR).join(GOOGLE_ACCOUNTS_FILE),
                &expected,
                cap
            )
            .is_some()
        );

        // Swapped back: the open went through an outside link while the real `.gemini` is intact
        // again. The handle is a different file than the one at `expected`.
        let alias = home.join("swapped-gemini");
        link_directory(&outside, &alias);
        assert_eq!(
            read_bounded_ordinary_file(&alias.join(GOOGLE_ACCOUNTS_FILE), &expected, cap),
            None,
            "a handle opened through an outside link is refused"
        );
        unlink_directory(&alias);

        // Still swapped: `.gemini` itself is now the link, so `expected` no longer
        // canonicalizes to itself and the outside handle is refused.
        let real = home.join("real-gemini");
        std::fs::rename(home.join(GEMINI_DIR), &real).expect("move real .gemini aside");
        link_directory(&outside, &home.join(GEMINI_DIR));
        assert_eq!(
            read_bounded_ordinary_file(
                &home.join(GEMINI_DIR).join(GOOGLE_ACCOUNTS_FILE),
                &expected,
                cap
            ),
            None,
            "a handle opened through a swapped .gemini is refused"
        );
        unlink_directory(&home.join(GEMINI_DIR));
        std::fs::rename(&real, home.join(GEMINI_DIR)).expect("restore .gemini");
        assert_eq!(
            reported_identity(&fixture.profiles, ACCOUNT_ID).as_deref(),
            Some("inside@example.com")
        );
    }

    #[test]
    fn sign_out_clears_the_identity() {
        let fixture = fixture("unused");
        signed_in(
            &fixture.profiles,
            ACCOUNT_ID,
            Some(br#"{"active":"person@example.com"}"#),
        );
        assert!(refreshed(&fixture.profiles, ACCOUNT_ID).identity.is_some());
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("gemini-cli", ACCOUNT_ID)
            .expect("lease");
        let observed = Arc::new(Mutex::new(None));
        let record = Arc::clone(&observed);
        let state =
            logout_with_lease_observed(&fixture.profiles, ACCOUNT_ID, lease, move |result| {
                *lock(&record) = Some(result.clone());
                Ok(())
            })
            .expect("signed out");
        assert_eq!(state.auth, AuthState::NotAuthenticated);
        assert_eq!(state.identity, None);
        assert_eq!(
            lock(&observed).clone(),
            Some(Ok(GeminiAccountState {
                auth: AuthState::NotAuthenticated,
                identity: None,
            })),
            "the recorded sign-out carries no identity"
        );
        assert_eq!(refreshed(&fixture.profiles, ACCOUNT_ID).identity, None);
    }

    #[test]
    fn each_account_reports_only_its_own_identity() {
        let fixture = fixture("unused");
        signed_in(
            &fixture.profiles,
            ACCOUNT_ID,
            Some(br#"{"active":"first@example.com"}"#),
        );
        signed_in(
            &fixture.profiles,
            OTHER_ACCOUNT_ID,
            Some(br#"{"active":"second@example.com"}"#),
        );
        assert_eq!(
            refreshed(&fixture.profiles, ACCOUNT_ID).identity.as_deref(),
            Some("first@example.com")
        );
        assert_eq!(
            refreshed(&fixture.profiles, OTHER_ACCOUNT_ID)
                .identity
                .as_deref(),
            Some("second@example.com")
        );
        std::fs::remove_file(
            credentials(&fixture.profiles, OTHER_ACCOUNT_ID).join(GOOGLE_ACCOUNTS_FILE),
        )
        .expect("remove");
        assert_eq!(
            refreshed(&fixture.profiles, OTHER_ACCOUNT_ID).identity,
            None,
            "one account's identity never fills in for another"
        );
        assert_eq!(
            refreshed(&fixture.profiles, ACCOUNT_ID).identity.as_deref(),
            Some("first@example.com")
        );
    }

    #[test]
    fn identity_is_redacted_from_debug_output() {
        let state = GeminiAccountState {
            auth: AuthState::Authenticated,
            identity: Some("person@example.com".into()),
        };
        let debug = format!(
            "{state:?} {:?}",
            Ok::<_, GeminiAccountAuthError>(state.clone())
        );
        assert!(!debug.contains("person"), "{debug}");
        assert!(!debug.contains("example.com"), "{debug}");
    }

    #[test]
    fn fake_gemini_cli() {
        let Ok(operation) = std::env::var("GEMINI_AUTH_TEST_OPERATION") else {
            return;
        };
        assert_eq!(operation, "login");
        for forbidden in ["GEMINI_API_KEY", "GOOGLE_API_KEY", "NO_BROWSER"] {
            assert!(std::env::var_os(forbidden).is_none(), "{forbidden} leaked");
        }
        for storage in [
            "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE",
            "GEMINI_FORCE_FILE_STORAGE",
        ] {
            assert_eq!(std::env::var(storage).as_deref(), Ok("true"), "{storage}");
        }
        assert_eq!(std::env::var("GOOGLE_GENAI_USE_GCA").as_deref(), Ok("true"));
        let home = PathBuf::from(std::env::var_os("GEMINI_CLI_HOME").expect("profile selector"));
        assert!(
            home.ends_with(Path::new("accounts").join(ACCOUNT_ID).join("home")),
            "{}",
            home.display()
        );
        let cwd = std::env::current_dir().expect("cwd");
        assert!(
            cwd.ends_with(Path::new(ACCOUNT_ID).join("sign-in").join("neutral")),
            "{}",
            cwd.display()
        );
        let args = std::env::var("GEMINI_AUTH_TEST_REAL_ARGS").expect("real args");
        let args: Vec<&str> = args.split('\u{1f}').collect();
        assert_eq!(args.last(), Some(&"--list-extensions"));
        assert!(!args.contains(&"--include-directories"));

        let mut consent = String::new();
        std::io::stdin().read_line(&mut consent).expect("consent");
        assert_eq!(consent.trim(), "y");

        match std::env::var("GEMINI_AUTH_TEST_SCENARIO").as_deref() {
            Ok("login_success") => {
                let directory = home.join(GEMINI_DIR);
                std::fs::create_dir_all(&directory).expect("gemini dir");
                // Gemini's encrypted FileKeychain; the fake never writes a plaintext cache.
                std::fs::write(directory.join(ENCRYPTED_CREDENTIALS_FILE), b"opaque")
                    .expect("encrypted store");
                std::fs::write(
                    directory.join(GOOGLE_ACCOUNTS_FILE),
                    br#"{"active":"signed.in@example.com","old":["previous@example.com"]}"#,
                )
                .expect("google accounts");
            }
            Ok("login_declined") => {}
            Ok("login_hang") => std::thread::sleep(Duration::from_secs(60)),
            other => panic!("unexpected scenario {other:?}"),
        }
    }
}
