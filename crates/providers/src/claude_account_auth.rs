//! Official Claude Code CLI account authentication for KalCode-managed profiles.
//!
//! Claude Code owns credentials and opens its own browser login. KalCode invokes only the
//! documented `claude auth` commands inside an exclusively leased managed profile, never reads
//! credential files, and publishes account state only after the whole child process tree exits.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::claude::MANAGED_CLAUDE_VERSION;
use crate::detect::DetectEnv;
use crate::managed::{ManagedProfiles, ProfileLease};
#[cfg(test)]
use crate::process::run_probe;
use crate::process::{ProcessSpec, SupervisedChild, run_probe_guarded};
use crate::version::Version;

const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const TERMINATE_GRACE: Duration = Duration::from_millis(500);
const MAX_STATUS_BYTES: usize = 64 * 1024;

/// Account truth returned by Claude Code's documented `auth status --json` command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeAccountState {
    pub logged_in: bool,
    pub auth_method: Option<String>,
    pub identity: Option<String>,
    pub subscription_type: Option<String>,
}

/// Bounded, credential-free failures from Claude Code account operations.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ClaudeAccountAuthError {
    #[error("the managed Claude profile could not be prepared")]
    ProfileUnavailable,
    #[error("Claude Code could not be started")]
    StartFailed,
    #[error("the installed Claude Code version is not certified for managed profiles")]
    UnsupportedVersion,
    #[error("Claude Code did not return valid account status")]
    InvalidResponse,
    #[error("the Claude Code account operation did not finish in time")]
    TimedOut,
    #[error("the Claude Code account operation ended unexpectedly")]
    ConnectionEnded,
    #[error("this managed Claude profile is already connected")]
    AlreadyConnected,
    #[error("Claude Code sign-in was canceled")]
    Canceled,
    #[error("Claude Code sign-in finished without confirming an account")]
    AccountNotConfirmed,
    #[error("Claude Code sign-out finished without clearing the account")]
    LogoutNotConfirmed,
    #[error("KalCode could not record the provider account result")]
    StateUpdateFailed,
}

#[derive(Clone, Copy)]
struct AuthTimeouts {
    status: Duration,
    login: Duration,
    terminate_grace: Duration,
}

impl Default for AuthTimeouts {
    fn default() -> Self {
        Self {
            status: STATUS_TIMEOUT,
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

/// Runs Claude Code's documented auth lifecycle in one isolated managed account profile.
pub struct ClaudeAccountAuthManager {
    executable: PathBuf,
    source_env: DetectEnv,
    profiles: Arc<ManagedProfiles>,
    launch_mode: LaunchMode,
    timeouts: AuthTimeouts,
}

impl fmt::Debug for ClaudeAccountAuthManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeAccountAuthManager")
            .field("executable", &self.executable)
            .field("source_env", &"[redacted]")
            .field("profiles", &"managed")
            .finish_non_exhaustive()
    }
}

struct PreparedAuth {
    env: BTreeMap<OsString, OsString>,
    cwd: PathBuf,
    _lease: ProfileLease,
}

impl PreparedAuth {
    fn retain_lease_fail_closed(self) {
        let Self {
            env: _,
            cwd: _,
            _lease,
        } = self;
        std::mem::forget(_lease);
    }
}

impl ClaudeAccountAuthManager {
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

    pub fn read_account_with_lease_observed<F>(
        &self,
        account_id: &str,
        lease: ProfileLease,
        observe: F,
    ) -> Result<ClaudeAccountState, ClaudeAccountAuthError>
    where
        F: Fn(
            &Result<ClaudeAccountState, ClaudeAccountAuthError>,
        ) -> Result<(), ClaudeAccountAuthError>,
    {
        let prepared = self.prepare(account_id, lease)?;
        let mut result = self.read_prepared(&prepared);
        if observe(&result).is_err() {
            result = Err(ClaudeAccountAuthError::StateUpdateFailed);
        }
        result
    }

    pub fn start_login_with_lease_observed<F>(
        &self,
        account_id: &str,
        lease: ProfileLease,
        observe: F,
    ) -> Result<PendingClaudeLogin, ClaudeAccountAuthError>
    where
        F: Fn(
                &Result<ClaudeAccountState, ClaudeAccountAuthError>,
            ) -> Result<(), ClaudeAccountAuthError>
            + Send
            + 'static,
    {
        let prepared = self.prepare(account_id, lease)?;
        let before = self.read_prepared(&prepared)?;
        if before.logged_in {
            let result = Ok(before);
            if observe(&result).is_err() {
                return Err(ClaudeAccountAuthError::StateUpdateFailed);
            }
            return Err(ClaudeAccountAuthError::AlreadyConnected);
        }

        let spec = self.spec(&prepared, "login", &["auth", "login", "--claudeai"]);
        let spawned = match &self.launch_mode {
            LaunchMode::Production => {
                let job = prepared
                    ._lease
                    .prepare_guarded_job("claude-auth-login")
                    .map_err(|_| ClaudeAccountAuthError::StartFailed)?;
                SupervisedChild::spawn_guarded(&spec, job)
            }
            #[cfg(test)]
            LaunchMode::Test { .. } => SupervisedChild::spawn(&spec),
        };
        let (child, output) = spawned.map_err(|_| ClaudeAccountAuthError::StartFailed)?;
        #[cfg(test)]
        let force_output_thread_failure = match &self.launch_mode {
            LaunchMode::Test { extra_env, .. } => extra_env
                .get(&OsString::from("CLAUDE_AUTH_FAIL_OUTPUT_THREAD"))
                .is_some_and(|value| value == "1"),
            LaunchMode::Production => false,
        };
        #[cfg(not(test))]
        let force_output_thread_failure = false;
        #[cfg(test)]
        let force_worker_thread_failure = match &self.launch_mode {
            LaunchMode::Test { extra_env, .. } => extra_env
                .get(&OsString::from("CLAUDE_AUTH_FAIL_WORKER_THREAD"))
                .is_some_and(|value| value == "1"),
            LaunchMode::Production => false,
        };
        #[cfg(not(test))]
        let force_worker_thread_failure = false;
        #[cfg(test)]
        let force_cleanup_failure = match &self.launch_mode {
            LaunchMode::Test { extra_env, .. } => extra_env
                .get(&OsString::from("CLAUDE_AUTH_FORCE_CLEANUP_FAILURE"))
                .is_some_and(|value| value == "1"),
            LaunchMode::Production => false,
        };
        #[cfg(not(test))]
        let force_cleanup_failure = false;
        // Login output may include a one-time browser URL. Drain it so the provider never sees a
        // broken pipe, but discard every bounded line without logging or crossing the WebView.
        let output_thread = if force_output_thread_failure {
            Err(std::io::Error::other(
                "injected Claude output-thread start failure",
            ))
        } else {
            thread::Builder::new()
                .name("claude-account-login-output".into())
                .spawn(move || while output.recv().is_ok() {})
        };
        if output_thread.is_err() {
            cleanup_failed_login_start(
                &child,
                prepared,
                self.timeouts.terminate_grace,
                force_cleanup_failure,
            );
            return Err(ClaudeAccountAuthError::StartFailed);
        }
        let child = Arc::new(child);
        let worker_child = Arc::clone(&child);
        let outcome = Arc::new(LoginOutcome::default());
        let worker_outcome = Arc::clone(&outcome);
        let canceled = Arc::new(AtomicBool::new(false));
        let worker_canceled = Arc::clone(&canceled);
        let executable = self.executable.clone();
        let launch_mode = self.launch_mode.clone();
        let timeouts = self.timeouts;
        let prepared = Arc::new(Mutex::new(Some(prepared)));
        let worker_prepared = Arc::clone(&prepared);
        let worker_thread = if force_worker_thread_failure {
            Err(std::io::Error::other(
                "injected Claude login-thread start failure",
            ))
        } else {
            thread::Builder::new()
                .name("claude-account-login".into())
                .spawn(move || {
                    let Some(prepared) = lock(&worker_prepared).take() else {
                        worker_outcome
                            .complete(Err(ClaudeAccountAuthError::ConnectionEnded), false);
                        return;
                    };
                    let deadline = Instant::now() + timeouts.login;
                    let mut cleanup_proven = true;
                    let result = loop {
                        if worker_canceled.load(Ordering::Acquire) {
                            #[cfg(test)]
                            if force_cleanup_failure {
                                cleanup_proven = false;
                                break Err(ClaudeAccountAuthError::ConnectionEnded);
                            }
                            break match worker_child.terminate(timeouts.terminate_grace) {
                                Ok(Some(_)) => Err(ClaudeAccountAuthError::Canceled),
                                Ok(None) | Err(_) => {
                                    cleanup_proven = false;
                                    Err(ClaudeAccountAuthError::ConnectionEnded)
                                }
                            };
                        }
                        match worker_child.try_status() {
                            Ok(Some(status)) if status.success() => break Ok(()),
                            Ok(Some(_)) if worker_canceled.load(Ordering::Acquire) => {
                                break Err(ClaudeAccountAuthError::Canceled);
                            }
                            Ok(Some(_)) => break Err(ClaudeAccountAuthError::ConnectionEnded),
                            Ok(None) if Instant::now() >= deadline => {
                                #[cfg(test)]
                                if force_cleanup_failure {
                                    cleanup_proven = false;
                                    break Err(ClaudeAccountAuthError::ConnectionEnded);
                                }
                                break match worker_child.terminate(timeouts.terminate_grace) {
                                    Ok(Some(_)) => Err(ClaudeAccountAuthError::TimedOut),
                                    Ok(None) | Err(_) => {
                                        cleanup_proven = false;
                                        Err(ClaudeAccountAuthError::ConnectionEnded)
                                    }
                                };
                            }
                            Ok(None) => thread::sleep(Duration::from_millis(25)),
                            Err(_) => {
                                cleanup_proven = false;
                                break Err(ClaudeAccountAuthError::ConnectionEnded);
                            }
                        }
                    };
                    let mut final_result = match result {
                        Ok(()) => {
                            read_status(&executable, &launch_mode, &prepared, timeouts.status)
                                .and_then(|state| {
                                    state
                                        .logged_in
                                        .then_some(state)
                                        .ok_or(ClaudeAccountAuthError::AccountNotConfirmed)
                                })
                        }
                        Err(error) => Err(error),
                    };
                    if observe(&final_result).is_err() {
                        final_result = Err(ClaudeAccountAuthError::StateUpdateFailed);
                    }
                    if cleanup_proven {
                        drop(prepared);
                    } else {
                        // No account-scoped session may start after cleanup ceased to be provable.
                        // Deliberately retain the exclusive lease until process restart.
                        prepared.retain_lease_fail_closed();
                    }
                    worker_outcome.complete(final_result, cleanup_proven);
                })
        };
        if worker_thread.is_err() {
            if let Some(prepared) = lock(&prepared).take() {
                cleanup_failed_login_start(
                    &child,
                    prepared,
                    self.timeouts.terminate_grace,
                    force_cleanup_failure,
                );
            }
            return Err(ClaudeAccountAuthError::StartFailed);
        }

        Ok(PendingClaudeLogin {
            outcome,
            canceled,
            wait_timeout: self.timeouts.login + self.timeouts.status.saturating_mul(2),
            terminate_grace: self.timeouts.terminate_grace,
        })
    }

    pub fn logout_with_lease_observed<F>(
        &self,
        account_id: &str,
        lease: ProfileLease,
        observe: F,
    ) -> Result<ClaudeAccountState, ClaudeAccountAuthError>
    where
        F: Fn(
            &Result<ClaudeAccountState, ClaudeAccountAuthError>,
        ) -> Result<(), ClaudeAccountAuthError>,
    {
        let prepared = self.prepare(account_id, lease)?;
        let _ = self.read_prepared(&prepared)?;
        let spec = self.spec(&prepared, "logout", &["auth", "logout"]);
        let output = match &self.launch_mode {
            LaunchMode::Production => {
                let job = prepared
                    ._lease
                    .prepare_guarded_job("claude-auth-logout")
                    .map_err(|_| ClaudeAccountAuthError::StartFailed)?;
                run_probe_guarded(&spec, job, self.timeouts.status, false, 0)
            }
            #[cfg(test)]
            LaunchMode::Test { .. } => run_probe(&spec, self.timeouts.status, false, 0),
        }
        .map_err(map_process_error)?;
        let mut result = if output.status.success() {
            self.read_prepared(&prepared).and_then(|state| {
                (!state.logged_in)
                    .then_some(state)
                    .ok_or(ClaudeAccountAuthError::LogoutNotConfirmed)
            })
        } else {
            Err(ClaudeAccountAuthError::ConnectionEnded)
        };
        if observe(&result).is_err() {
            result = Err(ClaudeAccountAuthError::StateUpdateFailed);
        }
        result
    }

    fn prepare(
        &self,
        account_id: &str,
        lease: ProfileLease,
    ) -> Result<PreparedAuth, ClaudeAccountAuthError> {
        if !lease.is_exclusive_for(&self.profiles, "claude-code", account_id) {
            return Err(ClaudeAccountAuthError::ProfileUnavailable);
        }
        let env = self
            .profiles
            .launch_env("claude-code", account_id, &self.source_env)
            .map_err(|_| ClaudeAccountAuthError::ProfileUnavailable)?;
        let cwd = self
            .profiles
            .profile_home("claude-code", account_id)
            .map_err(|_| ClaudeAccountAuthError::ProfileUnavailable)?;
        if matches!(self.launch_mode, LaunchMode::Production) {
            let job = lease
                .prepare_guarded_job("claude-auth-version")
                .map_err(|_| ClaudeAccountAuthError::StartFailed)?;
            verify_certified_version(&self.executable, &env, &cwd, self.timeouts.status, job)?;
        }
        Ok(PreparedAuth {
            env,
            cwd,
            _lease: lease,
        })
    }

    fn read_prepared(
        &self,
        prepared: &PreparedAuth,
    ) -> Result<ClaudeAccountState, ClaudeAccountAuthError> {
        read_status(
            &self.executable,
            &self.launch_mode,
            prepared,
            self.timeouts.status,
        )
    }

    fn spec(&self, prepared: &PreparedAuth, operation: &str, args: &[&str]) -> ProcessSpec {
        make_spec(
            &self.executable,
            &self.launch_mode,
            prepared,
            operation,
            args,
        )
    }
}

fn cleanup_failed_login_start(
    child: &SupervisedChild,
    prepared: PreparedAuth,
    terminate_grace: Duration,
    force_unproven: bool,
) {
    let quiesced = !force_unproven && matches!(child.terminate(terminate_grace), Ok(Some(_)));
    if !quiesced {
        prepared.retain_lease_fail_closed();
    }
}

/// One native Claude sign-in process. No auth URL or provider output is exposed to the WebView.
pub struct PendingClaudeLogin {
    outcome: Arc<LoginOutcome>,
    canceled: Arc<AtomicBool>,
    wait_timeout: Duration,
    terminate_grace: Duration,
}

impl fmt::Debug for PendingClaudeLogin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingClaudeLogin")
            .field("provider", &"claude-code")
            .finish_non_exhaustive()
    }
}

impl PendingClaudeLogin {
    pub fn wait(&self) -> Result<ClaudeAccountState, ClaudeAccountAuthError> {
        match self.outcome.wait(self.wait_timeout) {
            Err(ClaudeAccountAuthError::TimedOut) => {
                self.canceled.store(true, Ordering::Release);
                Err(ClaudeAccountAuthError::TimedOut)
            }
            outcome => outcome,
        }
    }

    pub fn cancel(&self) -> Result<(), ClaudeAccountAuthError> {
        self.canceled.store(true, Ordering::Release);
        let terminal = self
            .outcome
            .wait_terminal(self.terminate_grace + Duration::from_secs(5))?;
        if terminal.quiesced {
            Ok(())
        } else {
            Err(ClaudeAccountAuthError::ConnectionEnded)
        }
    }

    pub fn is_finished(&self) -> bool {
        self.outcome.is_quiesced()
    }
}

impl Drop for PendingClaudeLogin {
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
    result: Result<ClaudeAccountState, ClaudeAccountAuthError>,
    quiesced: bool,
}

impl LoginOutcome {
    fn complete(&self, result: Result<ClaudeAccountState, ClaudeAccountAuthError>, quiesced: bool) {
        *lock(&self.value) = Some(LoginTerminal { result, quiesced });
        self.changed.notify_all();
    }

    fn peek(&self) -> Option<LoginTerminal> {
        lock(&self.value).clone()
    }

    fn is_quiesced(&self) -> bool {
        self.peek().is_some_and(|terminal| terminal.quiesced)
    }

    fn wait(&self, timeout: Duration) -> Result<ClaudeAccountState, ClaudeAccountAuthError> {
        self.wait_terminal(timeout)?.result
    }

    fn wait_terminal(&self, timeout: Duration) -> Result<LoginTerminal, ClaudeAccountAuthError> {
        let deadline = Instant::now() + timeout;
        let mut value = lock(&self.value);
        loop {
            if let Some(value) = value.clone() {
                return Ok(value);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ClaudeAccountAuthError::TimedOut);
            }
            let waited = self
                .changed
                .wait_timeout(value, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            value = waited.0;
            if waited.1.timed_out() && value.is_none() {
                return Err(ClaudeAccountAuthError::TimedOut);
            }
        }
    }
}

fn read_status(
    executable: &Path,
    launch_mode: &LaunchMode,
    prepared: &PreparedAuth,
    timeout: Duration,
) -> Result<ClaudeAccountState, ClaudeAccountAuthError> {
    let spec = make_spec(
        executable,
        launch_mode,
        prepared,
        "status",
        &["auth", "status", "--json"],
    );
    let output = match launch_mode {
        LaunchMode::Production => {
            let job = prepared
                ._lease
                .prepare_guarded_job("claude-auth-status")
                .map_err(|_| ClaudeAccountAuthError::StartFailed)?;
            run_probe_guarded(&spec, job, timeout, true, MAX_STATUS_BYTES)
        }
        #[cfg(test)]
        LaunchMode::Test { .. } => run_probe(&spec, timeout, true, MAX_STATUS_BYTES),
    }
    .map_err(map_process_error)?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(ClaudeAccountAuthError::ConnectionEnded);
    }
    let status = match launch_mode {
        LaunchMode::Production => output.stdout.trim(),
        #[cfg(test)]
        LaunchMode::Test { .. } => output
            .stdout
            .lines()
            .rev()
            .find(|line| serde_json::from_str::<Value>(line).is_ok())
            .ok_or(ClaudeAccountAuthError::InvalidResponse)?,
    };
    decode_status(status)
}

fn make_spec(
    executable: &Path,
    launch_mode: &LaunchMode,
    prepared: &PreparedAuth,
    _operation: &str,
    args: &[&str],
) -> ProcessSpec {
    let (env, args) = match launch_mode {
        LaunchMode::Production => (
            prepared.env.clone(),
            args.iter().map(OsString::from).collect(),
        ),
        #[cfg(test)]
        LaunchMode::Test {
            args: test_args,
            extra_env,
        } => {
            let mut env = prepared.env.clone();
            env.extend(extra_env.clone());
            env.insert("CLAUDE_AUTH_TEST_OPERATION".into(), _operation.into());
            (env, test_args.clone())
        }
    };
    ProcessSpec {
        program: executable.to_path_buf(),
        args,
        cwd: Some(prepared.cwd.clone()),
        env,
    }
}

fn verify_certified_version(
    executable: &Path,
    env: &BTreeMap<OsString, OsString>,
    cwd: &Path,
    timeout: Duration,
    guardian_job: crate::guardian::RegisteredJob,
) -> Result<(), ClaudeAccountAuthError> {
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
    .map_err(map_process_error)?;
    let found = Version::find_in(&output.stdout)
        .filter(|version| version.suffix.is_empty())
        .ok_or(ClaudeAccountAuthError::UnsupportedVersion)?;
    if !output.status.success() || found != MANAGED_CLAUDE_VERSION {
        return Err(ClaudeAccountAuthError::UnsupportedVersion);
    }
    Ok(())
}

fn decode_status(output: &str) -> Result<ClaudeAccountState, ClaudeAccountAuthError> {
    let value: Value =
        serde_json::from_str(output.trim()).map_err(|_| ClaudeAccountAuthError::InvalidResponse)?;
    let object = value
        .as_object()
        .ok_or(ClaudeAccountAuthError::InvalidResponse)?;
    let logged_in = object
        .get("loggedIn")
        .and_then(Value::as_bool)
        .ok_or(ClaudeAccountAuthError::InvalidResponse)?;
    let bounded = |key: &str| -> Result<Option<String>, ClaudeAccountAuthError> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) if !value.is_empty() && value.chars().count() <= 1024 => {
                Ok(Some(value.clone()))
            }
            _ => Err(ClaudeAccountAuthError::InvalidResponse),
        }
    };
    let auth_method = bounded("authMethod")?;
    let identity = bounded("email")?;
    let subscription_type = bounded("subscriptionType")?;
    if logged_in && auth_method.as_deref() == Some("none") {
        return Err(ClaudeAccountAuthError::InvalidResponse);
    }
    Ok(ClaudeAccountState {
        logged_in,
        auth_method,
        identity,
        subscription_type,
    })
}

fn map_process_error(error: crate::process::ProcessError) -> ClaudeAccountAuthError {
    match error {
        crate::process::ProcessError::TimedOut(_) => ClaudeAccountAuthError::TimedOut,
        crate::process::ProcessError::Spawn(_) => ClaudeAccountAuthError::StartFailed,
        _ => ClaudeAccountAuthError::ConnectionEnded,
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT_ID: &str = "5c61fc90-b5b6-4970-979c-a5876275e90f";
    struct Fixture {
        _temp: tempfile::TempDir,
        profiles: Arc<ManagedProfiles>,
        manager: ClaudeAccountAuthManager,
        state_marker: PathBuf,
        // Fields drop in declaration order. Keep the shared slot last so it covers the child,
        // bounded process cleanup, profile authority, marker path, and temporary-root teardown.
        _recursive_test_process_slot: std::sync::MutexGuard<'static, ()>,
    }

    fn fixture(scenario: &str) -> Fixture {
        let recursive_test_process_slot = lock(&crate::RECURSIVE_TEST_EXECUTABLE_SLOT);
        let temp = tempfile::tempdir().expect("tempdir");
        let profiles =
            Arc::new(ManagedProfiles::new(temp.path().join("managed-profiles")).expect("profiles"));
        let state_marker = temp.path().join("connected");
        let mut extra_env: BTreeMap<OsString, OsString> = [
            ("CLAUDE_AUTH_TEST_SCENARIO".into(), scenario.into()),
            (
                "CLAUDE_AUTH_TEST_STATE".into(),
                state_marker.clone().into_os_string(),
            ),
        ]
        .into_iter()
        .collect();
        if scenario == "cleanup_unproven" || scenario.ends_with("_unproven") {
            extra_env.insert("CLAUDE_AUTH_FORCE_CLEANUP_FAILURE".into(), "1".into());
        }
        if scenario.starts_with("output_thread_failure") {
            extra_env.insert("CLAUDE_AUTH_FAIL_OUTPUT_THREAD".into(), "1".into());
        }
        if scenario.starts_with("worker_thread_failure") {
            extra_env.insert("CLAUDE_AUTH_FAIL_WORKER_THREAD".into(), "1".into());
        }
        let manager = ClaudeAccountAuthManager::new_for_test(
            std::env::current_exe().expect("test executable"),
            DetectEnv {
                vars: vec![
                    ("HOME".into(), temp.path().join("ordinary").into_os_string()),
                    (
                        "USERPROFILE".into(),
                        temp.path().join("ordinary").into_os_string(),
                    ),
                    ("ANTHROPIC_API_KEY".into(), "must-not-reach-child".into()),
                    (
                        "CLAUDE_SECURESTORAGE_CONFIG_DIR".into(),
                        temp.path().join("hostile").into_os_string(),
                    ),
                ],
                windows: cfg!(windows),
                probe_timeout: Some(Duration::from_secs(2)),
            },
            Arc::clone(&profiles),
            vec![
                "--exact".into(),
                "claude_account_auth::tests::fake_claude_cli".into(),
                "--nocapture".into(),
            ],
            extra_env,
            AuthTimeouts {
                status: Duration::from_secs(2),
                login: Duration::from_secs(2),
                terminate_grace: Duration::from_millis(50),
            },
        );
        Fixture {
            _temp: temp,
            profiles,
            manager,
            state_marker,
            _recursive_test_process_slot: recursive_test_process_slot,
        }
    }

    #[test]
    fn status_uses_both_exact_managed_profile_selectors_under_lease() {
        let fixture = fixture("status_connected");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        let state = fixture
            .manager
            .read_account_with_lease_observed(ACCOUNT_ID, lease, |result| {
                assert!(result.is_ok());
                assert!(
                    fixture
                        .profiles
                        .acquire_session_lease("claude-code", ACCOUNT_ID)
                        .is_err()
                );
                Ok(())
            })
            .expect("state");
        assert!(state.logged_in);
        assert_eq!(state.identity.as_deref(), Some("person@example.test"));
    }

    #[test]
    fn login_confirms_status_before_releasing_profile() {
        let fixture = fixture("login_success");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        let pending = fixture
            .manager
            .start_login_with_lease_observed(ACCOUNT_ID, lease, |_| Ok(()))
            .expect("login");
        let result = pending.wait();
        assert!(
            fixture.state_marker.exists(),
            "login child did not run: {result:?}"
        );
        let state = result.expect("confirmed state");
        assert!(state.logged_in);
        assert!(fixture.state_marker.exists());
        let _lease = fixture
            .profiles
            .acquire_session_lease("claude-code", ACCOUNT_ID)
            .expect("lease released after confirmation");
    }

    #[test]
    fn cancel_waits_for_process_tree_cleanup_before_releasing_profile() {
        let fixture = fixture("login_hang");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        let pending = fixture
            .manager
            .start_login_with_lease_observed(ACCOUNT_ID, lease, |_| Ok(()))
            .expect("login");
        pending.cancel().expect("cancel");
        let _lease = fixture
            .profiles
            .acquire_session_lease("claude-code", ACCOUNT_ID)
            .expect("cancel waits for process cleanup before returning");
        assert!(matches!(
            pending.wait(),
            Err(ClaudeAccountAuthError::Canceled)
        ));
    }

    #[test]
    fn concurrent_cancel_callers_share_one_quiescent_terminal_outcome() {
        let fixture = fixture("login_hang");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        let pending = Arc::new(
            fixture
                .manager
                .start_login_with_lease_observed(ACCOUNT_ID, lease, |_| Ok(()))
                .expect("login"),
        );
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let callers: Vec<_> = (0..2)
            .map(|_| {
                let pending = Arc::clone(&pending);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    pending.cancel()
                })
            })
            .collect();
        barrier.wait();
        for caller in callers {
            caller
                .join()
                .expect("cancel caller")
                .expect("shared cancellation");
        }
        assert!(pending.is_finished());
        let _lease = fixture
            .profiles
            .acquire_session_lease("claude-code", ACCOUNT_ID)
            .expect("both callers observe process-tree quiescence");
    }

    #[test]
    fn wait_timeout_requests_cancel_and_retains_lease_until_cleanup() {
        struct ReleaseOnDrop(Option<std::sync::mpsc::SyncSender<()>>);
        impl ReleaseOnDrop {
            fn release(&mut self) {
                if let Some(sender) = self.0.take() {
                    let _ = sender.send(());
                }
            }
        }
        impl Drop for ReleaseOnDrop {
            fn drop(&mut self) {
                self.release();
            }
        }

        let fixture = fixture("login_hang");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let mut release = ReleaseOnDrop(Some(release_tx));
        let mut pending = fixture
            .manager
            .start_login_with_lease_observed(ACCOUNT_ID, lease, move |_| {
                entered_tx
                    .send(())
                    .map_err(|_| ClaudeAccountAuthError::StateUpdateFailed)?;
                release_rx
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|_| ClaudeAccountAuthError::StateUpdateFailed)?;
                Ok(())
            })
            .expect("login");
        pending.wait_timeout = Duration::from_millis(1);
        let wait_result = pending.wait();
        let observer_entered = entered_rx.recv_timeout(Duration::from_secs(5));
        let lease_remained_exclusive = fixture
            .profiles
            .acquire_session_lease("claude-code", ACCOUNT_ID)
            .is_err();
        release.release();
        let cancel_result = pending.cancel();
        let session_lease_after_cleanup = fixture
            .profiles
            .acquire_session_lease("claude-code", ACCOUNT_ID);

        assert!(matches!(wait_result, Err(ClaudeAccountAuthError::TimedOut)));
        observer_entered.expect("cleanup observer was not reached");
        assert!(
            lease_remained_exclusive,
            "wait timeout must retain the exclusive lease through final observation"
        );
        cancel_result.expect("join requested cancellation");
        let _lease =
            session_lease_after_cleanup.expect("lease releases after process-tree cleanup");
    }

    #[test]
    fn unproven_login_cleanup_never_reports_a_removable_terminal() {
        let fixture = fixture("cleanup_unproven");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        let pending = fixture
            .manager
            .start_login_with_lease_observed(ACCOUNT_ID, lease, |_| Ok(()))
            .expect("login");
        assert!(matches!(
            pending.cancel(),
            Err(ClaudeAccountAuthError::ConnectionEnded)
        ));
        assert!(
            !pending.is_finished(),
            "unproven cleanup must remain tracked by IPC/shutdown"
        );
        assert!(
            fixture
                .profiles
                .acquire_session_lease("claude-code", ACCOUNT_ID)
                .is_err(),
            "unproven login cleanup retains the exclusive profile lease"
        );
    }

    #[test]
    fn login_thread_start_failures_quiesce_before_releasing_profile() {
        for scenario in ["output_thread_failure", "worker_thread_failure"] {
            let fixture = fixture(scenario);
            let lease = fixture
                .profiles
                .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
                .expect("lease");
            assert!(matches!(
                fixture
                    .manager
                    .start_login_with_lease_observed(ACCOUNT_ID, lease, |_| Ok(())),
                Err(ClaudeAccountAuthError::StartFailed)
            ));
            let _lease = fixture
                .profiles
                .acquire_session_lease("claude-code", ACCOUNT_ID)
                .expect("thread-start failure proves cleanup before releasing profile");
        }
    }

    #[test]
    fn unproved_thread_start_cleanup_retains_profile_fail_closed() {
        let fixture = fixture("output_thread_failure_unproven");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        assert!(matches!(
            fixture
                .manager
                .start_login_with_lease_observed(ACCOUNT_ID, lease, |_| Ok(())),
            Err(ClaudeAccountAuthError::StartFailed)
        ));
        assert!(
            fixture
                .profiles
                .acquire_session_lease("claude-code", ACCOUNT_ID)
                .is_err(),
            "unproved thread-start cleanup must retain the exclusive profile lease"
        );
    }

    #[test]
    fn decoder_fails_closed_on_ambiguous_or_unbounded_status() {
        for value in [
            "{}".to_owned(),
            r#"{"loggedIn":"yes"}"#.to_owned(),
            format!(r#"{{"loggedIn":true,"email":"{}"}}"#, "x".repeat(1025)),
            r#"{"loggedIn":true,"authMethod":"none"}"#.to_owned(),
        ] {
            assert!(decode_status(&value).is_err(), "{value}");
        }
    }

    #[test]
    fn fake_claude_cli() {
        let Ok(operation) = std::env::var("CLAUDE_AUTH_TEST_OPERATION") else {
            return;
        };
        assert!(std::env::var_os("ANTHROPIC_API_KEY").is_none());
        let config = std::env::var_os("CLAUDE_CONFIG_DIR").expect("config selector");
        assert_eq!(
            std::env::var_os("CLAUDE_SECURESTORAGE_CONFIG_DIR"),
            Some(config),
            "credential and metadata selectors must match"
        );
        let marker = PathBuf::from(std::env::var_os("CLAUDE_AUTH_TEST_STATE").expect("marker"));
        let scenario = std::env::var("CLAUDE_AUTH_TEST_SCENARIO").expect("scenario");
        match operation.as_str() {
            "login"
                if scenario == "login_hang"
                    || scenario == "cleanup_unproven"
                    || scenario.contains("thread_failure") =>
            {
                std::thread::sleep(Duration::from_secs(60));
            }
            "login" => std::fs::write(&marker, b"connected").expect("login marker"),
            "logout" => {
                if marker.exists() {
                    std::fs::remove_file(&marker).expect("logout marker");
                }
            }
            "status" => {
                let connected = scenario == "status_connected" || marker.exists();
                println!(
                    "{}",
                    serde_json::json!({
                        "loggedIn": connected,
                        "authMethod": if connected { "claude.ai" } else { "none" },
                        "apiProvider": "firstParty",
                        "email": if connected { Some("person@example.test") } else { None },
                        "subscriptionType": if connected { Some("max") } else { None },
                    })
                );
            }
            _ => panic!("unexpected operation"),
        }
    }
}
