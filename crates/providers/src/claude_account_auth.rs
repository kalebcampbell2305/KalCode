//! Official Claude Code CLI account authentication for KalCode-managed profiles.
//!
//! Claude Code owns credentials and opens its own browser login. KalCode invokes only the
//! documented `claude auth` commands inside an exclusively leased managed profile, never reads
//! credential files, and publishes account state only after the whole child process tree exits.
//! Claude's short-lived `auth status` command is deliberately not used because it can start an
//! OAuth refresh and exit before the refreshed credentials are durably written.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crate::claude::managed_version_supported;
use crate::detect::DetectEnv;
use crate::managed::{ManagedProfiles, ProfileLease};
#[cfg(test)]
use crate::process::run_probe;
use crate::process::{ProcessSpec, SupervisedChild, run_probe_guarded};
use crate::version::Version;

const STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const TERMINATE_GRACE: Duration = Duration::from_millis(500);
/// Longest a failed login waits for its stdout reader to finish before classifying the exit. A
/// descendant that inherited the pipe can keep it open, so this stays short and bounded.
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_millis(500);

/// Bounded account state derived only from a completed official authentication operation.
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
    UnsupportedVersion {
        /// Public release number reported by `claude --version`, when one was found.
        found: Option<String>,
    },
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
    #[error("Claude Code rejected the official sign-in command")]
    UnsupportedAuthCommand,
    #[error("Claude Code sign-in exited (code {exit_code:?}) before opening the browser")]
    BrowserHandoffFailed { exit_code: Option<i32> },
    #[error("Claude Code sign-in exited (code {exit_code:?}) before confirming an account")]
    LoginExited { exit_code: Option<i32> },
    #[error("Claude Code sign-in finished but its account status could not be refreshed")]
    StatusRefreshFailed,
}

impl ClaudeAccountAuthError {
    /// Stable, credential-free reason code for logs and user-visible errors. It never carries
    /// provider output, URLs or account material.
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::ProfileUnavailable => "account_profile_invalid",
            Self::StartFailed => "spawn_failed",
            Self::UnsupportedVersion { .. } => "provider_version_unsupported",
            Self::InvalidResponse => "auth_status_invalid",
            Self::TimedOut => "auth_process_timeout",
            Self::ConnectionEnded => "auth_process_ended",
            Self::AlreadyConnected => "already_connected",
            Self::Canceled => "canceled",
            Self::AccountNotConfirmed => "account_not_confirmed",
            Self::LogoutNotConfirmed => "logout_not_confirmed",
            Self::StateUpdateFailed => "account_state_update_failed",
            Self::UnsupportedAuthCommand => "unsupported_auth_command",
            Self::BrowserHandoffFailed { .. } => "browser_handoff_failed",
            Self::LoginExited { .. } => "auth_process_exited",
            Self::StatusRefreshFailed => "auth_status_refresh_failed",
        }
    }

    /// Exit code of the official sign-in process, when it exited on its own.
    pub fn exit_code(&self) -> Option<i32> {
        match self {
            Self::BrowserHandoffFailed { exit_code } | Self::LoginExited { exit_code } => {
                *exit_code
            }
            _ => None,
        }
    }
}

/// Classifies one stdout line of `claude auth login`. Only this fixed prefix is inspected; the
/// line itself (which can include a one-time sign-in URL) is never stored or logged.
fn is_browser_handoff_line(line: &str) -> bool {
    line.trim_start().starts_with("Opening browser to sign in")
}

/// Whether the redacted stderr tail shows Claude's own command parser rejecting the arguments.
fn is_unsupported_command_output(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("unknown option") || lower.contains("unknown command")
}

fn trace_failure(operation: &'static str, error: &ClaudeAccountAuthError) {
    tracing::warn!(
        event = "provider.claude_auth.failed",
        operation,
        reason = error.reason_code(),
        exit_code = error.exit_code(),
    );
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
        let prepared = self
            .prepare(account_id, lease)
            .inspect_err(|error| trace_failure("login", error))?;
        let spec = self.spec(&prepared, "login", &["auth", "login", "--claudeai"]);
        let spawned = match &self.launch_mode {
            LaunchMode::Production => {
                let job = prepared
                    ._lease
                    .prepare_guarded_job("claude-auth-login")
                    .map_err(|_| ClaudeAccountAuthError::StartFailed)
                    .inspect_err(|error| trace_failure("login", error))?;
                SupervisedChild::spawn_guarded(&spec, job)
            }
            #[cfg(test)]
            LaunchMode::Test { .. } => SupervisedChild::spawn(&spec),
        };
        let (child, output) = spawned
            .map_err(|_| ClaudeAccountAuthError::StartFailed)
            .inspect_err(|error| trace_failure("login", error))?;
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
        #[cfg(test)]
        let output_line_delay = match &self.launch_mode {
            LaunchMode::Test { extra_env, .. } => extra_env
                .get(&OsString::from("CLAUDE_AUTH_DELAY_OUTPUT_MS"))
                .and_then(|value| value.to_str()?.parse().ok())
                .map(Duration::from_millis),
            LaunchMode::Production => None,
        };
        // Login output may include a one-time browser URL. Drain it so the provider never sees a
        // broken pipe, but discard every bounded line without logging or crossing the WebView.
        // Only Claude's fixed browser hand-off prefix is recognised, as a reason code.
        let handoff_started = Arc::new(AtomicBool::new(false));
        let output_handoff = Arc::clone(&handoff_started);
        let output_drained = Arc::new(AtomicBool::new(false));
        let reader_drained = Arc::clone(&output_drained);
        let output_thread = if force_output_thread_failure {
            Err(std::io::Error::other(
                "injected Claude output-thread start failure",
            ))
        } else {
            thread::Builder::new()
                .name("claude-account-login-output".into())
                .spawn(move || {
                    while let Ok(line) = output.recv() {
                        #[cfg(test)]
                        if let Some(delay) = output_line_delay {
                            thread::sleep(delay);
                        }
                        if matches!(line, crate::process::OutputLine::Closed) {
                            break;
                        }
                        if let crate::process::OutputLine::Line(line) = line
                            && !output_handoff.load(Ordering::Acquire)
                            && is_browser_handoff_line(&line)
                        {
                            output_handoff.store(true, Ordering::Release);
                            tracing::info!(event = "provider.claude_auth.browser_handoff_started");
                        }
                    }
                    // Keep draining (discarding) anything after end-of-output so the reader never
                    // blocks, but classification may now rely on every line being seen.
                    reader_drained.store(true, Ordering::Release);
                    while output.recv().is_ok() {}
                })
        };
        if output_thread.is_err() {
            cleanup_failed_login_start(
                &child,
                prepared,
                self.timeouts.terminate_grace,
                force_cleanup_failure,
            );
            trace_failure("login", &ClaudeAccountAuthError::StartFailed);
            return Err(ClaudeAccountAuthError::StartFailed);
        }
        let child = Arc::new(child);
        let worker_handoff = Arc::clone(&handoff_started);
        let worker_drained = Arc::clone(&output_drained);
        let worker_child = Arc::clone(&child);
        let outcome = Arc::new(LoginOutcome::default());
        let worker_outcome = Arc::clone(&outcome);
        let canceled = Arc::new(AtomicBool::new(false));
        let worker_canceled = Arc::clone(&canceled);
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
                            Ok(Some(status)) => {
                                let exit_code = status.code();
                                // The stdout reader may not have seen the child's last lines
                                // yet (including the browser hand-off). Wait, bounded, until it
                                // reports end-of-output so the hand-off is never misclassified.
                                let drain_deadline = Instant::now() + OUTPUT_DRAIN_GRACE;
                                while !worker_drained.load(Ordering::Acquire)
                                    && Instant::now() < drain_deadline
                                {
                                    thread::sleep(Duration::from_millis(5));
                                }
                                // The stderr reader may still be appending the child's final
                                // line; give it one short, bounded chance before classifying.
                                let rejected =
                                    is_unsupported_command_output(&worker_child.stderr_tail()) || {
                                        thread::sleep(Duration::from_millis(50));
                                        is_unsupported_command_output(&worker_child.stderr_tail())
                                    };
                                break Err(if rejected {
                                    ClaudeAccountAuthError::UnsupportedAuthCommand
                                } else if worker_handoff.load(Ordering::Acquire) {
                                    ClaudeAccountAuthError::LoginExited { exit_code }
                                } else {
                                    ClaudeAccountAuthError::BrowserHandoffFailed { exit_code }
                                });
                            }
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
                        // The official command's successful exit is Claude's authentication
                        // verdict. Do not run the short-lived status command afterwards: it can
                        // race its own OAuth refresh. Identity and plan remain unknown until a
                        // long-lived coding session reports them through a safe provider path.
                        Ok(()) => Ok(authenticated_state()),
                        Err(error) => Err(error),
                    };
                    if observe(&final_result).is_err() {
                        final_result = Err(ClaudeAccountAuthError::StateUpdateFailed);
                    }
                    if let Err(error) = &final_result {
                        trace_failure("login", error);
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
            handoff_started,
            wait_timeout: self.timeouts.login + self.timeouts.terminate_grace + OUTPUT_DRAIN_GRACE,
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
        let spec = self.spec(&prepared, "logout", &["auth", "logout"]);
        let output = match match &self.launch_mode {
            LaunchMode::Production => {
                let job = prepared
                    ._lease
                    .prepare_guarded_job("claude-auth-logout")
                    .map_err(|_| ClaudeAccountAuthError::StartFailed)?;
                run_probe_guarded(&spec, job, self.timeouts.status, false, 0)
            }
            #[cfg(test)]
            LaunchMode::Test { .. } => run_probe(&spec, self.timeouts.status, false, 0),
        } {
            Ok(output) => output,
            Err(error) => {
                let mut result = Err(map_process_error(error));
                if observe(&result).is_err() {
                    result = Err(ClaudeAccountAuthError::StateUpdateFailed);
                }
                // A failed supervised operation may still own a descendant or guardian job. The
                // short probe API cannot return a positive quiescence proof on its error channel,
                // so retain the exclusive lease until restart rather than race profile reuse.
                prepared.retain_lease_fail_closed();
                return result;
            }
        };
        let mut result = if output.status.success() {
            // A successful official logout command is the provider verdict. A follow-up status
            // process would re-enter Claude's OAuth startup path and is therefore unsafe.
            Ok(signed_out_state())
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
    handoff_started: Arc<AtomicBool>,
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

    /// Whether Claude Code reported handing sign-in off to the browser.
    pub fn browser_handoff_started(&self) -> bool {
        self.handoff_started.load(Ordering::Acquire)
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
        .ok_or(ClaudeAccountAuthError::UnsupportedVersion { found: None })?;
    if !output.status.success() || !managed_version_supported(&found) {
        // The version string is public release metadata, never account material.
        tracing::warn!(
            event = "provider.claude_auth.version_unsupported",
            found = %found,
            certified = %crate::claude::certified_managed_versions_label(),
        );
        return Err(ClaudeAccountAuthError::UnsupportedVersion {
            found: Some(found.to_string()),
        });
    }
    Ok(())
}

fn authenticated_state() -> ClaudeAccountState {
    ClaudeAccountState {
        logged_in: true,
        auth_method: Some("claude.ai".to_owned()),
        identity: None,
        subscription_type: None,
    }
}

fn signed_out_state() -> ClaudeAccountState {
    ClaudeAccountState {
        logged_in: false,
        auth_method: None,
        identity: None,
        subscription_type: None,
    }
}

fn map_process_error(error: crate::process::ProcessError) -> ClaudeAccountAuthError {
    match error {
        crate::process::ProcessError::TimedOut(_) => ClaudeAccountAuthError::TimedOut,
        crate::process::ProcessError::Canceled => ClaudeAccountAuthError::Canceled,
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
        operation_log: PathBuf,
        // Fields drop in declaration order. Keep the shared slot last so it covers the child,
        // bounded process cleanup, profile authority, marker path, and temporary-root teardown.
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
        let managed_root = temp_root.join("managed-profiles");
        let profiles = Arc::new(ManagedProfiles::new(managed_root.clone()).expect("profiles"));
        let state_marker = temp_root.join("connected");
        let operation_log = temp_root.join("operations.log");
        let mut extra_env: BTreeMap<OsString, OsString> = [
            ("CLAUDE_AUTH_TEST_SCENARIO".into(), scenario.into()),
            (
                "CLAUDE_AUTH_TEST_STATE".into(),
                state_marker.clone().into_os_string(),
            ),
            (
                "CLAUDE_AUTH_TEST_OPERATION_LOG".into(),
                operation_log.clone().into_os_string(),
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
        if scenario.ends_with("_slow_reader") {
            extra_env.insert("CLAUDE_AUTH_DELAY_OUTPUT_MS".into(), "100".into());
        }
        if scenario.starts_with("worker_thread_failure") {
            extra_env.insert("CLAUDE_AUTH_FAIL_WORKER_THREAD".into(), "1".into());
        }
        let manager = ClaudeAccountAuthManager::new_for_test(
            std::env::current_exe().expect("test executable"),
            DetectEnv {
                vars: vec![
                    ("HOME".into(), temp_root.join("ordinary").into_os_string()),
                    (
                        "USERPROFILE".into(),
                        temp_root.join("ordinary").into_os_string(),
                    ),
                    ("ANTHROPIC_API_KEY".into(), "must-not-reach-child".into()),
                    (
                        "CLAUDE_SECURESTORAGE_CONFIG_DIR".into(),
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
            operation_log,
            _recursive_test_process_slot: recursive_test_process_slot,
        }
    }

    fn operations(fixture: &Fixture) -> Vec<String> {
        std::fs::read_to_string(&fixture.operation_log)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn successful_login_exit_is_the_verdict_and_never_invokes_status() {
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
        let state = result.expect("authenticated state");
        assert!(state.logged_in);
        assert_eq!(state.auth_method.as_deref(), Some("claude.ai"));
        assert_eq!(state.identity, None);
        assert_eq!(state.subscription_type, None);
        assert!(fixture.state_marker.exists());
        assert_eq!(operations(&fixture), ["login"]);
        let _lease = fixture
            .profiles
            .acquire_session_lease("claude-code", ACCOUNT_ID)
            .expect("lease released after confirmation");
    }

    #[test]
    fn cancel_waits_for_process_tree_cleanup_before_releasing_profile() {
        let fixture = fixture("login_hang");
        std::fs::write(&fixture.state_marker, b"preexisting-safe-session")
            .expect("prior safe state");
        let observed = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&observed);
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        let pending = fixture
            .manager
            .start_login_with_lease_observed(ACCOUNT_ID, lease, move |result| {
                lock(&recorder).push(result.clone());
                Ok(())
            })
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
        assert!(
            fixture.state_marker.exists(),
            "cancel preserves prior provider state"
        );
        assert_eq!(
            lock(&observed).as_slice(),
            &[Err(ClaudeAccountAuthError::Canceled)]
        );
        assert_eq!(operations(&fixture), ["login"]);
    }

    #[test]
    fn successful_logout_exit_is_the_verdict_and_never_invokes_status() {
        let fixture = fixture("logout_success");
        std::fs::write(&fixture.state_marker, b"connected").expect("connected marker");
        let observed = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&observed);
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        let state = fixture
            .manager
            .logout_with_lease_observed(ACCOUNT_ID, lease, move |result| {
                lock(&recorder).push(result.clone());
                Ok(())
            })
            .expect("signed out");

        assert!(!state.logged_in);
        assert_eq!(state.auth_method, None);
        assert_eq!(state.identity, None);
        assert_eq!(state.subscription_type, None);
        assert!(!fixture.state_marker.exists());
        assert_eq!(lock(&observed).as_slice(), &[Ok(state)]);
        assert_eq!(operations(&fixture), ["logout"]);
        let _lease = fixture
            .profiles
            .acquire_session_lease("claude-code", ACCOUNT_ID)
            .expect("logout releases the exclusive lease after cleanup");
    }

    #[test]
    fn failed_logout_preserves_prior_provider_state_and_reports_once() {
        let fixture = fixture("logout_failure");
        std::fs::write(&fixture.state_marker, b"connected").expect("connected marker");
        let observed = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&observed);
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        let result = fixture
            .manager
            .logout_with_lease_observed(ACCOUNT_ID, lease, move |result| {
                lock(&recorder).push(result.clone());
                Ok(())
            });

        assert_eq!(result, Err(ClaudeAccountAuthError::ConnectionEnded));
        assert!(
            fixture.state_marker.exists(),
            "failed logout preserves provider state"
        );
        assert_eq!(
            lock(&observed).as_slice(),
            &[Err(ClaudeAccountAuthError::ConnectionEnded)]
        );
        assert_eq!(operations(&fixture), ["logout"]);
        let _lease = fixture
            .profiles
            .acquire_session_lease("claude-code", ACCOUNT_ID)
            .expect("cleanly exited logout releases the exclusive lease");
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

    fn login_error(scenario: &str) -> (Fixture, ClaudeAccountAuthError) {
        let fixture = fixture(scenario);
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        let pending = fixture
            .manager
            .start_login_with_lease_observed(ACCOUNT_ID, lease, |_| Ok(()))
            .expect("login starts");
        let error = pending.wait().expect_err("login must fail");
        assert!(
            pending.is_finished(),
            "{scenario}: failure must be quiescent"
        );
        (fixture, error)
    }

    #[test]
    fn login_exit_before_browser_handoff_reports_handoff_failure_with_exit_code() {
        let (fixture, error) = login_error("login_exit_before_handoff");
        assert_eq!(
            error,
            ClaudeAccountAuthError::BrowserHandoffFailed { exit_code: Some(3) }
        );
        assert_eq!(error.reason_code(), "browser_handoff_failed");
        assert_eq!(error.exit_code(), Some(3));
        let _lease = fixture
            .profiles
            .acquire_session_lease("claude-code", ACCOUNT_ID)
            .expect("an exited login releases the profile");
    }

    #[test]
    fn login_exit_after_browser_handoff_reports_process_exit_with_exit_code() {
        let (_fixture, error) = login_error("login_exit_after_handoff");
        assert_eq!(
            error,
            ClaudeAccountAuthError::LoginExited { exit_code: Some(4) }
        );
        assert_eq!(error.reason_code(), "auth_process_exited");
    }

    #[test]
    fn a_lagging_output_reader_never_turns_a_post_handoff_exit_into_a_handoff_failure() {
        // The reader processes each line 100 ms late, so the child has exited long before the
        // hand-off line is classified. Classification must wait for end-of-output.
        let (_fixture, error) = login_error("login_exit_after_handoff_slow_reader");
        assert_eq!(
            error,
            ClaudeAccountAuthError::LoginExited { exit_code: Some(4) }
        );
    }

    #[test]
    fn login_rejected_by_claudes_command_parser_reports_unsupported_auth_command() {
        let (_fixture, error) = login_error("login_unknown_option");
        assert_eq!(error, ClaudeAccountAuthError::UnsupportedAuthCommand);
        assert_eq!(error.reason_code(), "unsupported_auth_command");
    }

    #[test]
    fn successful_official_login_does_not_require_a_follow_up_status_process() {
        let fixture = fixture("login_success_not_signed_in");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        let pending = fixture
            .manager
            .start_login_with_lease_observed(ACCOUNT_ID, lease, |_| Ok(()))
            .expect("login starts");
        let state = pending
            .wait()
            .expect("official login exit is authoritative");
        assert!(state.logged_in);
        assert_eq!(state.identity, None);
        assert_eq!(operations(&fixture), ["login"]);
    }

    #[test]
    fn pending_login_reports_browser_handoff_without_exposing_output() {
        let fixture = fixture("login_handoff_then_hang");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        let pending = fixture
            .manager
            .start_login_with_lease_observed(ACCOUNT_ID, lease, |_| Ok(()))
            .expect("login");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !pending.browser_handoff_started() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(pending.browser_handoff_started());
        assert!(
            !pending.is_finished(),
            "a browser hand-off is an expected waiting state, not a failure"
        );
        pending.cancel().expect("cancel");
        assert_eq!(pending.wait(), Err(ClaudeAccountAuthError::Canceled));
    }

    #[test]
    fn successful_login_is_observed_exactly_once_without_a_status_process() {
        let fixture = fixture("login_success");
        let observed = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&observed);
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("claude-code", ACCOUNT_ID)
            .expect("lease");
        let pending = fixture
            .manager
            .start_login_with_lease_observed(ACCOUNT_ID, lease, move |result| {
                lock(&recorder).push(result.clone());
                Ok(())
            })
            .expect("login");
        let state = pending.wait().expect("signed in");
        assert!(state.logged_in);
        assert_eq!(state.identity, None);
        assert_eq!(
            lock(&observed).as_slice(),
            &[Ok(state.clone())],
            "the provider command's signed-in result is published exactly once"
        );
        assert_eq!(operations(&fixture), ["login"]);
    }

    #[test]
    fn every_failure_has_a_distinct_credential_free_reason_code() {
        let errors = [
            ClaudeAccountAuthError::ProfileUnavailable,
            ClaudeAccountAuthError::StartFailed,
            ClaudeAccountAuthError::UnsupportedVersion { found: None },
            ClaudeAccountAuthError::InvalidResponse,
            ClaudeAccountAuthError::TimedOut,
            ClaudeAccountAuthError::ConnectionEnded,
            ClaudeAccountAuthError::AlreadyConnected,
            ClaudeAccountAuthError::Canceled,
            ClaudeAccountAuthError::AccountNotConfirmed,
            ClaudeAccountAuthError::LogoutNotConfirmed,
            ClaudeAccountAuthError::StateUpdateFailed,
            ClaudeAccountAuthError::UnsupportedAuthCommand,
            ClaudeAccountAuthError::BrowserHandoffFailed { exit_code: Some(1) },
            ClaudeAccountAuthError::LoginExited { exit_code: None },
            ClaudeAccountAuthError::StatusRefreshFailed,
        ];
        let codes: std::collections::BTreeSet<_> = errors
            .iter()
            .map(ClaudeAccountAuthError::reason_code)
            .collect();
        assert_eq!(codes.len(), errors.len());
        for code in codes {
            assert!(
                code.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{code}"
            );
        }
        assert_eq!(
            ClaudeAccountAuthError::ProfileUnavailable.reason_code(),
            "account_profile_invalid"
        );
        assert_eq!(
            ClaudeAccountAuthError::StartFailed.reason_code(),
            "spawn_failed"
        );
        assert_eq!(
            ClaudeAccountAuthError::TimedOut.reason_code(),
            "auth_process_timeout"
        );
    }

    #[test]
    fn handoff_and_command_classifiers_inspect_only_fixed_markers() {
        assert!(is_browser_handoff_line("Opening browser to sign in…"));
        assert!(!is_browser_handoff_line(
            "If the browser didn't open, visit: https://example.test/"
        ));
        assert!(is_unsupported_command_output(
            "error: unknown option '--claudeai'"
        ));
        assert!(is_unsupported_command_output(
            "error: unknown command 'auth'"
        ));
        assert!(!is_unsupported_command_output("network unavailable"));
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
        let operation_log = PathBuf::from(
            std::env::var_os("CLAUDE_AUTH_TEST_OPERATION_LOG").expect("operation log"),
        );
        use std::io::Write as _;
        writeln!(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(operation_log)
                .expect("open operation log"),
            "{operation}"
        )
        .expect("record operation");
        match operation.as_str() {
            "login"
                if scenario == "login_hang"
                    || scenario == "cleanup_unproven"
                    || scenario.contains("thread_failure") =>
            {
                std::thread::sleep(Duration::from_secs(60));
            }
            "login" if scenario == "login_exit_before_handoff" => std::process::exit(3),
            "login" if scenario.starts_with("login_exit_after_handoff") => {
                println!("Opening browser to sign in…");
                println!("If the browser didn't open, visit: https://example.test/never-real");
                std::process::exit(4);
            }
            "login" if scenario == "login_unknown_option" => {
                eprintln!("error: unknown option '--claudeai'");
                std::process::exit(1);
            }
            "login" if scenario == "login_handoff_then_hang" => {
                println!("Opening browser to sign in…");
                std::thread::sleep(Duration::from_secs(60));
            }
            "login" if scenario == "login_success_not_signed_in" => {}
            "login" => std::fs::write(&marker, b"connected").expect("login marker"),
            "logout" if scenario == "logout_failure" => std::process::exit(7),
            "logout" => {
                if marker.exists() {
                    std::fs::remove_file(&marker).expect("logout marker");
                }
            }
            _ => panic!("unexpected operation"),
        }
    }
}
