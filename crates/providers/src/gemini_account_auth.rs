//! Official Gemini CLI account authentication for KalCode-managed profiles.
//!
//! Gemini CLI 0.61.0 has no `auth login` subcommand. Its own sign-in runs at startup whenever the
//! selected auth type is "Sign in with Google" and no cached credential exists: headless Gemini
//! asks `Opening authentication page in your browser. Do you want to continue? [Y/n]` on stdin,
//! opens Google's page in the system browser, receives the OAuth callback on a loopback port,
//! and caches the result in `<GEMINI_CLI_HOME>/.gemini/oauth_creds.json`.
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

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AuthState, ProviderError, ProviderId};

use crate::detect::DetectEnv;
use crate::gemini::managed_policy::ManagedGeminiSignIn;
use crate::managed::{ManagedProfiles, ProfileLease};
use crate::process::{ProcessSpec, SupervisedChild, run_probe_guarded};
use crate::version::Version;

const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const TERMINATE_GRACE: Duration = Duration::from_millis(500);

/// The managed Gemini version whose credential layout and startup sign-in KalCode certified.
const CERTIFIED_VERSION: Version = Version::new(0, 61, 0);

/// Gemini's own configuration directory below `GEMINI_CLI_HOME`.
const GEMINI_DIR: &str = ".gemini";
/// Gemini CLI 0.61.0's cached "Sign in with Google" credential (`Storage.getOAuthCredsPath`).
pub const OAUTH_CREDENTIALS_FILE: &str = "oauth_creds.json";
/// Gemini's cached Google account email list, cleared by Gemini's own credential reset.
const GOOGLE_ACCOUNTS_FILE: &str = "google_accounts.json";
/// Gemini's file-backed keychain (`GEMINI_FORCE_FILE_STORAGE`): stored API keys and encrypted
/// credentials. In a managed profile it holds only this account's provider credentials.
const FILE_KEYCHAIN_FILE: &str = "gemini-credentials.json";
/// Every provider-owned credential file sign-out removes. Nothing else in the profile changes.
const SIGN_OUT_FILES: [&str; 3] = [
    OAUTH_CREDENTIALS_FILE,
    GOOGLE_ACCOUNTS_FILE,
    FILE_KEYCHAIN_FILE,
];

/// Account truth derived from Gemini's own credential files (existence only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GeminiAccountState {
    pub auth: AuthState,
}

impl GeminiAccountState {
    pub fn logged_in(self) -> bool {
        self.auth == AuthState::Authenticated
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

/// Reads one managed account's Gemini sign-in state from file metadata alone.
///
/// - `Authenticated`: Gemini's Google sign-in cache exists as an ordinary file.
/// - `Unknown`: only Gemini's file keychain exists (for example an API key saved through
///   Gemini's own `/auth` dialog), which KalCode cannot inspect without reading it.
/// - `NotAuthenticated`: neither exists.
///
/// A link, reparse point or non-file at any of these paths fails closed as an error.
pub fn credential_state(
    profiles: &ManagedProfiles,
    account_id: &str,
) -> Result<AuthState, ProviderError> {
    let home = profiles.profile_home(ProviderId::GEMINI_CLI, account_id)?;
    let Some(directory) = gemini_directory(&home)? else {
        return Ok(AuthState::NotAuthenticated);
    };
    if ordinary_file_exists(&directory.join(OAUTH_CREDENTIALS_FILE))? {
        return Ok(AuthState::Authenticated);
    }
    if ordinary_file_exists(&directory.join(FILE_KEYCHAIN_FILE))? {
        return Ok(AuthState::Unknown);
    }
    Ok(AuthState::NotAuthenticated)
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
    credential_state(profiles, account_id)
        .map(|auth| GeminiAccountState { auth })
        .map_err(|_| GeminiAccountAuthError::ProfileUnavailable)
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
                    let state = credential_state(&profiles, &account)
                        .map(|auth| GeminiAccountState { auth })
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
    let found = Version::find_in(&output.stdout)
        .filter(|version| version.suffix.is_empty())
        .ok_or(GeminiAccountAuthError::UnsupportedVersion)?;
    if !output.status.success() || found != CERTIFIED_VERSION {
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
        std::fs::write(ordinary.join(".gemini").join(OAUTH_CREDENTIALS_FILE), b"{}")
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
        std::fs::write(directory.join(FILE_KEYCHAIN_FILE), b"opaque").expect("keychain");
        assert_eq!(
            credential_state(&fixture.profiles, ACCOUNT_ID).expect("state"),
            AuthState::Unknown,
            "an opaque keychain file is never guessed to be a valid sign-in"
        );
        std::fs::write(directory.join(OAUTH_CREDENTIALS_FILE), b"opaque").expect("oauth");
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
        std::fs::create_dir_all(directory.join(OAUTH_CREDENTIALS_FILE)).expect("directory");
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
        std::fs::write(directory.join(OAUTH_CREDENTIALS_FILE), b"opaque").expect("oauth");

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
        assert!(directory.join(OAUTH_CREDENTIALS_FILE).exists());
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
        assert!(
            credentials(&fixture.profiles, ACCOUNT_ID)
                .join(OAUTH_CREDENTIALS_FILE)
                .is_file()
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
        std::fs::write(directory.join(OAUTH_CREDENTIALS_FILE), b"opaque").expect("oauth");
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

    #[test]
    fn fake_gemini_cli() {
        let Ok(operation) = std::env::var("GEMINI_AUTH_TEST_OPERATION") else {
            return;
        };
        assert_eq!(operation, "login");
        for forbidden in ["GEMINI_API_KEY", "GOOGLE_API_KEY", "NO_BROWSER"] {
            assert!(std::env::var_os(forbidden).is_none(), "{forbidden} leaked");
        }
        assert_eq!(
            std::env::var("GEMINI_FORCE_FILE_STORAGE").as_deref(),
            Ok("true")
        );
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
                std::fs::write(directory.join(OAUTH_CREDENTIALS_FILE), b"{}").expect("cache");
            }
            Ok("login_declined") => {}
            Ok("login_hang") => std::thread::sleep(Duration::from_secs(60)),
            other => panic!("unexpected scenario {other:?}"),
        }
    }
}
