//! Official Codex app-server account authentication for KalCode-managed profiles.
//!
//! The implementation intentionally treats the provider app-server as the only source of
//! account truth. It never reads or copies provider credential files.

use std::collections::{BTreeMap, VecDeque};
use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::codex::managed_policy;
use crate::detect::DetectEnv;
use crate::managed::{ManagedProfiles, ProfileLease};
use crate::process::{OutputLine, ProcessSpec, SupervisedChild, recv_until};

const MAX_IGNORED_MESSAGES: usize = 64;
const MAX_AUTH_LINE_BYTES: usize = 128 * 1024;
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const DEFAULT_TERMINATE_GRACE: Duration = Duration::from_millis(500);

/// Account identity that the official Codex app-server reported for a ChatGPT login.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexChatGptAccount {
    pub email: Option<String>,
    pub plan_type: String,
}

impl CodexChatGptAccount {
    /// Whether this plan can currently use KalCode's managed Codex runtime isolation.
    ///
    /// Organization-managed and unknown plans can receive cloud-managed configuration. Until
    /// that configuration path is proven contained, the runtime adapter must refuse to start.
    pub fn managed_runtime_is_supported(&self) -> bool {
        self.cloud_config_eligibility() == managed_policy::CloudConfigEligibility::Ineligible
    }

    /// Maps official plan truth to the managed runtime's cloud-configuration safety contract.
    /// Known organization plans are identified as eligible and remain blocked by current
    /// session policy; unfamiliar values stay unknown and fail closed.
    pub fn cloud_config_eligibility(&self) -> managed_policy::CloudConfigEligibility {
        use managed_policy::CloudConfigEligibility::{Eligible, Ineligible, Unknown};
        match self.plan_type.as_str() {
            "free" | "go" | "plus" | "pro" | "prolite" => Ineligible,
            "team"
            | "self_serve_business_prolite"
            | "business"
            | "ent26"
            | "enterprise"
            | "edu"
            | "education" => Eligible,
            _ => Unknown,
        }
    }
}

/// Current account truth returned by `account/read`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexAccountState {
    pub account: Option<CodexChatGptAccount>,
    pub requires_openai_auth: bool,
}

impl CodexAccountState {
    pub fn cloud_config_eligibility(&self) -> managed_policy::CloudConfigEligibility {
        self.account.as_ref().map_or(
            managed_policy::CloudConfigEligibility::Unknown,
            CodexChatGptAccount::cloud_config_eligibility,
        )
    }
}

/// A validated authorization URL. Its `Debug` output never contains the URL.
#[derive(Clone, PartialEq, Eq)]
pub struct CodexAuthUrl(String);

impl CodexAuthUrl {
    fn parse(value: String) -> Result<Self, CodexAccountAuthError> {
        if value.is_empty()
            || value.len() > 16 * 1024
            || value.chars().any(|c| c.is_control() || c.is_whitespace())
            || value.contains('\\')
        {
            return Err(CodexAccountAuthError::UntrustedAuthOrigin);
        }
        let Some((scheme, rest)) = value.split_once("://") else {
            return Err(CodexAccountAuthError::UntrustedAuthOrigin);
        };
        if !scheme.eq_ignore_ascii_case("https") {
            return Err(CodexAccountAuthError::UntrustedAuthOrigin);
        }
        let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        if authority.contains('@') || authority.contains('%') {
            return Err(CodexAccountAuthError::UntrustedAuthOrigin);
        }
        let origin_ok = authority.eq_ignore_ascii_case("auth.openai.com")
            || authority.eq_ignore_ascii_case("auth.openai.com:443");
        if !origin_ok {
            return Err(CodexAccountAuthError::UntrustedAuthOrigin);
        }
        let resource = &rest[authority_end..];
        let Some(after_path) = resource.strip_prefix("/oauth/authorize") else {
            return Err(CodexAccountAuthError::UntrustedAuthOrigin);
        };
        if !after_path.is_empty() && !after_path.starts_with('?') && !after_path.starts_with('#') {
            return Err(CodexAccountAuthError::UntrustedAuthOrigin);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for CodexAuthUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CodexAuthUrl([redacted])")
    }
}

/// Bounded, redacted failures from the account-authentication protocol.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodexAccountAuthError {
    #[error("the managed Codex profile could not be prepared")]
    ProfileUnavailable,
    #[error("the Codex app-server could not be started")]
    StartFailed,
    #[error("the installed Codex version is not certified for managed profiles")]
    UnsupportedVersion,
    #[error("the Codex app-server connection ended unexpectedly")]
    ConnectionEnded,
    #[error("the Codex app-server did not respond in time")]
    TimedOut,
    #[error("the Codex app-server returned an invalid account-auth response")]
    InvalidResponse,
    #[error("Codex returned an authorization URL outside the official authentication origin")]
    UntrustedAuthOrigin,
    #[error(
        "this managed Codex profile is already connected; disconnect it before signing in again"
    )]
    AlreadyConnected,
    #[error("Codex reported that sign-in failed")]
    LoginFailed,
    #[error("Codex reported successful sign-in but did not confirm an account")]
    AccountNotConfirmed,
    #[error("Codex sign-in was canceled")]
    Canceled,
    #[error("KalCode could not record the provider account result")]
    StateUpdateFailed,
}

#[derive(Clone, Copy)]
struct AuthTimeouts {
    request: Duration,
    login: Duration,
    terminate_grace: Duration,
}

impl Default for AuthTimeouts {
    fn default() -> Self {
        Self {
            request: DEFAULT_REQUEST_TIMEOUT,
            login: DEFAULT_LOGIN_TIMEOUT,
            terminate_grace: DEFAULT_TERMINATE_GRACE,
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

/// Runs supported Codex account operations in one isolated KalCode-managed profile.
pub struct CodexAccountAuthManager {
    executable: PathBuf,
    source_env: DetectEnv,
    profiles: Arc<ManagedProfiles>,
    launch_mode: LaunchMode,
    timeouts: AuthTimeouts,
}

impl fmt::Debug for CodexAccountAuthManager {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CodexAccountAuthManager")
            .field("executable", &self.executable)
            .field("source_env", &"[redacted]")
            .field("profiles", &"managed")
            .finish_non_exhaustive()
    }
}

impl CodexAccountAuthManager {
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

    pub fn read_account(
        &self,
        account_id: &str,
    ) -> Result<CodexAccountState, CodexAccountAuthError> {
        let mut session = self.connect(account_id)?;
        let state = session.read_account()?;
        session.finish()?;
        Ok(state)
    }

    /// Reads official account truth under a caller-owned canonical exclusive lease. `observe`
    /// runs before process cleanup releases that lease, so database/cache truth cannot lag a
    /// concurrently starting session.
    pub fn read_account_with_lease_observed<F>(
        &self,
        account_id: &str,
        lease: ProfileLease,
        observe: F,
    ) -> Result<CodexAccountState, CodexAccountAuthError>
    where
        F: Fn(
            &Result<CodexAccountState, CodexAccountAuthError>,
        ) -> Result<(), CodexAccountAuthError>,
    {
        let mut session = self.connect_with_lease(account_id, lease)?;
        let mut result = session.read_account();
        if let Err(cleanup) = session.finish() {
            result = Err(cleanup);
        }
        if observe(&result).is_err() {
            result = Err(CodexAccountAuthError::StateUpdateFailed);
        }
        result
    }

    pub fn start_chatgpt_login(
        &self,
        account_id: &str,
    ) -> Result<PendingCodexLogin, CodexAccountAuthError> {
        let mut session = self.connect(account_id)?;
        let before = session.read_account()?;
        if before.account.is_some() {
            session.finish()?;
            return Err(CodexAccountAuthError::AlreadyConnected);
        }

        let response = session.request("account/login/start", Some(json!({"type":"chatgpt"})))?;
        if response.get("type").and_then(Value::as_str) != Some("chatgpt") {
            session.finish()?;
            return Err(CodexAccountAuthError::InvalidResponse);
        }
        let login_id = required_bounded_string(&response, "loginId", 1024)?;
        let auth_url =
            CodexAuthUrl::parse(required_bounded_string(&response, "authUrl", 16 * 1024)?)?;

        let (control_tx, control_rx) = mpsc::channel();
        let outcome = Arc::new(LoginOutcome::default());
        let worker_outcome = Arc::clone(&outcome);
        let timeouts = self.timeouts;
        thread::Builder::new()
            .name("codex-account-login".into())
            .spawn(move || {
                let mut result = login_worker(&mut session, &login_id, control_rx, timeouts);
                let cleanup = session.finish();
                let quiesced = cleanup.is_ok();
                if let Err(cleanup) = cleanup {
                    result = Err(cleanup);
                }
                drop(session);
                worker_outcome.complete(result, quiesced);
            })
            .map_err(|_| CodexAccountAuthError::StartFailed)?;

        Ok(PendingCodexLogin {
            auth_url,
            control: control_tx,
            outcome,
            cancel_requested: Mutex::new(false),
            cancel_timeout: self.timeouts.request + self.timeouts.terminate_grace,
            wait_timeout: self.timeouts.login
                + self.timeouts.request.saturating_mul(2)
                + self.timeouts.terminate_grace,
        })
    }

    /// Starts the official ChatGPT login using a caller-owned exclusive account lease. The
    /// observer is invoked with final provider truth before the app-server is terminated and the
    /// lease is released. A cleanup failure replaces any positive result and is observed too.
    pub fn start_chatgpt_login_with_lease_observed<F>(
        &self,
        account_id: &str,
        lease: ProfileLease,
        observe: F,
    ) -> Result<PendingCodexLogin, CodexAccountAuthError>
    where
        F: Fn(
                &Result<CodexAccountState, CodexAccountAuthError>,
            ) -> Result<(), CodexAccountAuthError>
            + Send
            + 'static,
    {
        let mut session = self.connect_with_lease(account_id, lease)?;
        let before = session.read_account()?;
        if before.account.is_some() {
            let mut result = session.finish().map(|()| before);
            if observe(&result).is_err() {
                result = Err(CodexAccountAuthError::StateUpdateFailed);
            }
            return match result {
                Ok(_) => Err(CodexAccountAuthError::AlreadyConnected),
                Err(error) => Err(error),
            };
        }

        let response = session.request("account/login/start", Some(json!({"type":"chatgpt"})))?;
        if response.get("type").and_then(Value::as_str) != Some("chatgpt") {
            session.finish()?;
            return Err(CodexAccountAuthError::InvalidResponse);
        }
        let login_id = required_bounded_string(&response, "loginId", 1024)?;
        let auth_url =
            CodexAuthUrl::parse(required_bounded_string(&response, "authUrl", 16 * 1024)?)?;
        let (control_tx, control_rx) = mpsc::channel();
        let outcome = Arc::new(LoginOutcome::default());
        let worker_outcome = Arc::clone(&outcome);
        let timeouts = self.timeouts;
        thread::Builder::new()
            .name("codex-account-login".into())
            .spawn(move || {
                let mut result = login_worker(&mut session, &login_id, control_rx, timeouts);
                let cleanup = session.finish();
                let quiesced = cleanup.is_ok();
                if let Err(cleanup) = cleanup {
                    result = Err(cleanup);
                }
                if observe(&result).is_err() {
                    result = Err(CodexAccountAuthError::StateUpdateFailed);
                }
                drop(session);
                worker_outcome.complete(result, quiesced);
            })
            .map_err(|_| CodexAccountAuthError::StartFailed)?;

        Ok(PendingCodexLogin {
            auth_url,
            control: control_tx,
            outcome,
            cancel_requested: Mutex::new(false),
            cancel_timeout: self.timeouts.request + self.timeouts.terminate_grace,
            wait_timeout: self.timeouts.login
                + self.timeouts.request.saturating_mul(2)
                + self.timeouts.terminate_grace,
        })
    }

    pub fn logout(&self, account_id: &str) -> Result<CodexAccountState, CodexAccountAuthError> {
        let mut session = self.connect(account_id)?;
        // Read first so logout is never issued against an unverified/mismatched app-server home.
        let _ = session.read_account()?;
        let result = session.request("account/logout", None)?;
        if result.as_object().is_none_or(|object| !object.is_empty()) {
            session.finish()?;
            return Err(CodexAccountAuthError::InvalidResponse);
        }
        let state = session.read_account()?;
        session.finish()?;
        Ok(state)
    }

    pub fn logout_with_lease_observed<F>(
        &self,
        account_id: &str,
        lease: ProfileLease,
        observe: F,
    ) -> Result<CodexAccountState, CodexAccountAuthError>
    where
        F: Fn(
            &Result<CodexAccountState, CodexAccountAuthError>,
        ) -> Result<(), CodexAccountAuthError>,
    {
        let mut session = self.connect_with_lease(account_id, lease)?;
        let result = (|| {
            let _ = session.read_account()?;
            let response = session.request("account/logout", None)?;
            if response.as_object().is_none_or(|object| !object.is_empty()) {
                return Err(CodexAccountAuthError::InvalidResponse);
            }
            session.read_account()
        })();
        let mut result = result;
        if let Err(cleanup) = session.finish() {
            result = Err(cleanup);
        }
        if observe(&result).is_err() {
            result = Err(CodexAccountAuthError::StateUpdateFailed);
        }
        result
    }

    fn connect(&self, account_id: &str) -> Result<RpcSession, CodexAccountAuthError> {
        let launch = managed_policy::prepare_auth(&self.profiles, &self.source_env, account_id)
            .map_err(|_| CodexAccountAuthError::ProfileUnavailable)?;
        self.connect_prepared(launch)
    }

    fn connect_with_lease(
        &self,
        account_id: &str,
        lease: ProfileLease,
    ) -> Result<RpcSession, CodexAccountAuthError> {
        let launch = managed_policy::prepare_auth_with_lease(
            &self.profiles,
            &self.source_env,
            account_id,
            lease,
        )
        .map_err(|_| CodexAccountAuthError::ProfileUnavailable)?;
        self.connect_prepared(launch)
    }

    fn connect_prepared(
        &self,
        launch: managed_policy::ManagedAuthLaunch,
    ) -> Result<RpcSession, CodexAccountAuthError> {
        let mut env = launch.env;
        remove_env(&mut env, "OPENAI_API_KEY");
        remove_env(&mut env, "CODEX_APP_SERVER_LOGIN_ISSUER");
        remove_env(&mut env, "CODEX_APP_SERVER_LOGIN_CLIENT_ID");
        remove_env(&mut env, "CODEX_APP_SERVER_DEV_OPEN_APP_URL");

        let (args, allow_test_harness_output) = match &self.launch_mode {
            LaunchMode::Production => {
                let version_job = launch
                    .lease
                    .prepare_guarded_job("codex-auth-version")
                    .map_err(|_| CodexAccountAuthError::StartFailed)?;
                crate::codex::verify_managed_executable_version_guarded(
                    &self.executable,
                    &env,
                    &launch.cwd,
                    version_job,
                )
                .map_err(|_| CodexAccountAuthError::UnsupportedVersion)?;
                (launch.args, false)
            }
            #[cfg(test)]
            LaunchMode::Test { args, extra_env } => {
                env.extend(extra_env.clone());
                (args.clone(), true)
            }
        };
        #[cfg(test)]
        let force_cleanup_failure = env
            .get(&OsString::from("ACCOUNT_AUTH_FORCE_CLEANUP_FAILURE"))
            .is_some_and(|value| value == "1");
        let spec = ProcessSpec {
            program: self.executable.clone(),
            args,
            cwd: Some(launch.cwd),
            env,
        };
        let spawned = match &self.launch_mode {
            LaunchMode::Production => {
                let job = launch
                    .lease
                    .prepare_guarded_job("codex-auth-server")
                    .map_err(|_| CodexAccountAuthError::StartFailed)?;
                SupervisedChild::spawn_guarded(&spec, job)
            }
            #[cfg(test)]
            LaunchMode::Test { .. } => SupervisedChild::spawn(&spec),
        };
        let (child, lines) = spawned.map_err(|_| CodexAccountAuthError::StartFailed)?;
        let mut session = RpcSession {
            child,
            lines,
            pending_notifications: VecDeque::new(),
            next_id: 1,
            request_timeout: self.timeouts.request,
            terminate_grace: self.timeouts.terminate_grace,
            expected_home: launch.profile_home,
            allow_test_harness_output,
            lease: Some(launch.lease),
            cleanup_attempted: false,
            #[cfg(test)]
            force_cleanup_failure,
        };
        session.initialize()?;
        Ok(session)
    }
}

/// A browser sign-in that remains bound to its isolated app-server and login identifier.
pub struct PendingCodexLogin {
    auth_url: CodexAuthUrl,
    control: Sender<LoginControl>,
    outcome: Arc<LoginOutcome>,
    cancel_requested: Mutex<bool>,
    cancel_timeout: Duration,
    wait_timeout: Duration,
}

impl PendingCodexLogin {
    pub fn auth_url(&self) -> &CodexAuthUrl {
        &self.auth_url
    }

    pub fn is_finished(&self) -> bool {
        self.outcome.is_quiesced()
    }

    pub fn wait(&self) -> Result<CodexAccountState, CodexAccountAuthError> {
        match self.outcome.wait(self.wait_timeout) {
            Err(CodexAccountAuthError::TimedOut) => {
                self.request_cancel();
                Err(CodexAccountAuthError::TimedOut)
            }
            outcome => outcome,
        }
    }

    pub fn cancel(&self) -> Result<(), CodexAccountAuthError> {
        self.request_cancel();
        let terminal = self.outcome.wait_terminal(self.cancel_timeout)?;
        if terminal.quiesced {
            Ok(())
        } else {
            Err(CodexAccountAuthError::ConnectionEnded)
        }
    }

    /// Requests cancellation exactly once. The login worker owns provider cancellation and
    /// process-tree cleanup; every caller waits on the same terminal outcome above.
    fn request_cancel(&self) {
        let mut requested = lock(&self.cancel_requested);
        if !*requested && self.outcome.peek().is_none() {
            *requested = true;
            let _ = self.control.send(LoginControl::Cancel);
        }
    }
}

impl fmt::Debug for PendingCodexLogin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingCodexLogin")
            .field("auth_url", &self.auth_url)
            .field("login_id", &"[redacted]")
            .finish_non_exhaustive()
    }
}

impl Drop for PendingCodexLogin {
    fn drop(&mut self) {
        if self.outcome.peek().is_none() {
            let _ = self.control.send(LoginControl::Abandon);
        }
    }
}

enum LoginControl {
    Cancel,
    Abandon,
}

#[derive(Default)]
struct LoginOutcome {
    value: Mutex<Option<LoginTerminal>>,
    changed: Condvar,
}

#[derive(Clone)]
struct LoginTerminal {
    result: Result<CodexAccountState, CodexAccountAuthError>,
    quiesced: bool,
}

impl LoginOutcome {
    fn complete(&self, result: Result<CodexAccountState, CodexAccountAuthError>, quiesced: bool) {
        *lock(&self.value) = Some(LoginTerminal { result, quiesced });
        self.changed.notify_all();
    }

    fn peek(&self) -> Option<LoginTerminal> {
        lock(&self.value).clone()
    }

    fn is_quiesced(&self) -> bool {
        self.peek().is_some_and(|terminal| terminal.quiesced)
    }

    fn wait(&self, timeout: Duration) -> Result<CodexAccountState, CodexAccountAuthError> {
        self.wait_terminal(timeout)?.result
    }

    fn wait_terminal(&self, timeout: Duration) -> Result<LoginTerminal, CodexAccountAuthError> {
        let deadline = Instant::now() + timeout;
        let mut value = lock(&self.value);
        while value.is_none() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(CodexAccountAuthError::TimedOut);
            }
            let (next, wait) = self
                .changed
                .wait_timeout(value, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            value = next;
            if wait.timed_out() && value.is_none() {
                return Err(CodexAccountAuthError::TimedOut);
            }
        }
        value.clone().ok_or(CodexAccountAuthError::ConnectionEnded)
    }
}

fn login_worker(
    session: &mut RpcSession,
    login_id: &str,
    control: Receiver<LoginControl>,
    timeouts: AuthTimeouts,
) -> Result<CodexAccountState, CodexAccountAuthError> {
    let deadline = Instant::now() + timeouts.login;
    let mut ignored = 0usize;
    loop {
        match control.try_recv() {
            Ok(LoginControl::Cancel) => {
                let result = cancel_login(session, login_id);
                result?;
                return Err(CodexAccountAuthError::Canceled);
            }
            Ok(LoginControl::Abandon) | Err(TryRecvError::Disconnected) => {
                let _ = cancel_login(session, login_id);
                return Err(CodexAccountAuthError::Canceled);
            }
            Err(TryRecvError::Empty) => {}
        }

        if Instant::now() >= deadline {
            let _ = cancel_login(session, login_id);
            return Err(CodexAccountAuthError::TimedOut);
        }
        let poll_deadline = deadline.min(Instant::now() + Duration::from_millis(50));
        let message = match session.next_notification(poll_deadline) {
            Ok(Some(message)) => message,
            Ok(None) => continue,
            Err(error) => return Err(error),
        };
        if message.get("method").and_then(Value::as_str) != Some("account/login/completed") {
            ignored += 1;
            if ignored > MAX_IGNORED_MESSAGES {
                return Err(CodexAccountAuthError::InvalidResponse);
            }
            continue;
        }
        let Some(params) = message.get("params") else {
            return Err(CodexAccountAuthError::InvalidResponse);
        };
        let completion_id = params.get("loginId").and_then(Value::as_str);
        if completion_id != Some(login_id) {
            ignored += 1;
            if ignored > MAX_IGNORED_MESSAGES {
                return Err(CodexAccountAuthError::InvalidResponse);
            }
            continue;
        }
        match params.get("success").and_then(Value::as_bool) {
            Some(true) => {
                let state = session.read_account()?;
                if state.account.is_none() {
                    return Err(CodexAccountAuthError::AccountNotConfirmed);
                }
                return Ok(state);
            }
            Some(false) => return Err(CodexAccountAuthError::LoginFailed),
            None => return Err(CodexAccountAuthError::InvalidResponse),
        }
    }
}

fn cancel_login(session: &mut RpcSession, login_id: &str) -> Result<(), CodexAccountAuthError> {
    let response = session.request("account/login/cancel", Some(json!({"loginId":login_id})))?;
    match response.get("status").and_then(Value::as_str) {
        Some("canceled" | "notFound") => Ok(()),
        _ => Err(CodexAccountAuthError::InvalidResponse),
    }
}

struct RpcSession {
    // Field order is deliberate: the process is terminated before the exclusive lease unlocks.
    child: SupervisedChild,
    lines: Receiver<OutputLine>,
    pending_notifications: VecDeque<Value>,
    next_id: i64,
    request_timeout: Duration,
    terminate_grace: Duration,
    expected_home: PathBuf,
    allow_test_harness_output: bool,
    lease: Option<ProfileLease>,
    cleanup_attempted: bool,
    #[cfg(test)]
    force_cleanup_failure: bool,
}

impl RpcSession {
    fn initialize(&mut self) -> Result<(), CodexAccountAuthError> {
        let response = self.request(
            "initialize",
            Some(json!({
                "clientInfo": {
                    "name": "kalcode",
                    "title": null,
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {"experimentalApi":false},
            })),
        )?;
        let reported_home = response
            .get("codexHome")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .ok_or(CodexAccountAuthError::InvalidResponse)?;
        if !same_existing_directory(&reported_home, &self.expected_home) {
            return Err(CodexAccountAuthError::InvalidResponse);
        }
        self.send(json!({"method":"initialized"}))
    }

    fn read_account(&mut self) -> Result<CodexAccountState, CodexAccountAuthError> {
        let response = self.request("account/read", Some(json!({"refreshToken":false})))?;
        decode_account_state(&response)
    }

    fn request(
        &mut self,
        method: &'static str,
        params: Option<Value>,
    ) -> Result<Value, CodexAccountAuthError> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let mut request = json!({"id":id,"method":method});
        if let Some(params) = params {
            request["params"] = params;
        }
        self.send(request)?;
        let deadline = Instant::now() + self.request_timeout;
        let mut ignored = 0usize;
        loop {
            let message = self.recv_value(deadline)?;
            if message.get("method").is_some() && message.get("id").is_none() {
                if self.pending_notifications.len() >= MAX_IGNORED_MESSAGES {
                    return Err(CodexAccountAuthError::InvalidResponse);
                }
                self.pending_notifications.push_back(message);
            } else if message.get("id").and_then(Value::as_i64) == Some(id) {
                if let Some(result) = message.get("result") {
                    return Ok(result.clone());
                }
                return Err(CodexAccountAuthError::InvalidResponse);
            } else {
                ignored += 1;
                if ignored > MAX_IGNORED_MESSAGES {
                    return Err(CodexAccountAuthError::InvalidResponse);
                }
            }
        }
    }

    fn send(&self, value: Value) -> Result<(), CodexAccountAuthError> {
        let line =
            serde_json::to_string(&value).map_err(|_| CodexAccountAuthError::InvalidResponse)?;
        self.child
            .write_line(&line)
            .map_err(|_| CodexAccountAuthError::ConnectionEnded)
    }

    fn next_notification(
        &mut self,
        deadline: Instant,
    ) -> Result<Option<Value>, CodexAccountAuthError> {
        if let Some(notification) = self.pending_notifications.pop_front() {
            return Ok(Some(notification));
        }
        match recv_until(&self.lines, deadline) {
            Ok(OutputLine::Line(line)) if line.len() > MAX_AUTH_LINE_BYTES => {
                Err(CodexAccountAuthError::InvalidResponse)
            }
            Ok(OutputLine::Line(line)) => match serde_json::from_str::<Value>(&line) {
                Ok(value) if value.get("method").is_some() && value.get("id").is_none() => {
                    Ok(Some(value))
                }
                Ok(_) | Err(_) => Err(CodexAccountAuthError::InvalidResponse),
            },
            Ok(OutputLine::TooLong { .. }) => Err(CodexAccountAuthError::InvalidResponse),
            Ok(OutputLine::Closed) | Err(RecvTimeoutError::Disconnected) => {
                Err(CodexAccountAuthError::ConnectionEnded)
            }
            Err(RecvTimeoutError::Timeout) => Ok(None),
        }
    }

    fn recv_value(&self, deadline: Instant) -> Result<Value, CodexAccountAuthError> {
        let mut non_protocol_lines = 0usize;
        loop {
            match recv_until(&self.lines, deadline) {
                Ok(OutputLine::Line(line)) if line.len() > MAX_AUTH_LINE_BYTES => {
                    return Err(CodexAccountAuthError::InvalidResponse);
                }
                Ok(OutputLine::Line(line)) => match serde_json::from_str(&line) {
                    Ok(value) => return Ok(value),
                    Err(_) if self.allow_test_harness_output => {
                        // Rust's test harness writes bounded status lines around the fake child.
                        // Production sessions reject non-protocol stdout immediately.
                        non_protocol_lines += 1;
                        if non_protocol_lines > 8 {
                            return Err(CodexAccountAuthError::InvalidResponse);
                        }
                    }
                    Err(_) => return Err(CodexAccountAuthError::InvalidResponse),
                },
                Ok(OutputLine::TooLong { .. }) => {
                    return Err(CodexAccountAuthError::InvalidResponse);
                }
                Ok(OutputLine::Closed) | Err(RecvTimeoutError::Disconnected) => {
                    return Err(CodexAccountAuthError::ConnectionEnded);
                }
                Err(RecvTimeoutError::Timeout) => return Err(CodexAccountAuthError::TimedOut),
            }
        }
    }

    fn finish(&mut self) -> Result<(), CodexAccountAuthError> {
        self.cleanup_attempted = true;
        #[cfg(test)]
        if self.force_cleanup_failure {
            self.retain_profile_fail_closed();
            return Err(CodexAccountAuthError::ConnectionEnded);
        }
        match self.child.terminate(self.terminate_grace) {
            Ok(Some(_)) => Ok(()),
            Ok(None) | Err(_) => {
                self.retain_profile_fail_closed();
                Err(CodexAccountAuthError::ConnectionEnded)
            }
        }
    }

    fn retain_profile_fail_closed(&mut self) {
        if let Some(lease) = self.lease.take() {
            std::mem::forget(lease);
        }
    }
}

impl Drop for RpcSession {
    fn drop(&mut self) {
        if self.cleanup_attempted {
            return;
        }
        self.cleanup_attempted = true;
        if !matches!(self.child.terminate(self.terminate_grace), Ok(Some(_))) {
            self.retain_profile_fail_closed();
        }
    }
}

fn decode_account_state(value: &Value) -> Result<CodexAccountState, CodexAccountAuthError> {
    let requires_openai_auth = value
        .get("requiresOpenaiAuth")
        .and_then(Value::as_bool)
        .ok_or(CodexAccountAuthError::InvalidResponse)?;
    let account = match value.get("account") {
        Some(Value::Null) => None,
        Some(Value::Object(object))
            if object.get("type").and_then(Value::as_str) == Some("chatgpt") =>
        {
            let email = match object.get("email") {
                Some(Value::Null) | None => None,
                Some(Value::String(email))
                    if email.len() <= 1024 && !email.chars().any(char::is_control) =>
                {
                    Some(email.clone())
                }
                _ => return Err(CodexAccountAuthError::InvalidResponse),
            };
            let plan_type = object
                .get("planType")
                .and_then(Value::as_str)
                .filter(|plan| {
                    !plan.is_empty()
                        && plan.len() <= 128
                        && plan
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                })
                .ok_or(CodexAccountAuthError::InvalidResponse)?
                .to_owned();
            Some(CodexChatGptAccount { email, plan_type })
        }
        _ => return Err(CodexAccountAuthError::InvalidResponse),
    };
    Ok(CodexAccountState {
        account,
        requires_openai_auth,
    })
}

fn required_bounded_string(
    value: &Value,
    field: &str,
    max_len: usize,
) -> Result<String, CodexAccountAuthError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| {
            !text.is_empty() && text.len() <= max_len && !text.chars().any(char::is_control)
        })
        .map(str::to_owned)
        .ok_or(CodexAccountAuthError::InvalidResponse)
}

fn same_existing_directory(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn remove_env(env: &mut BTreeMap<OsString, OsString>, name: &str) {
    env.retain(|key, _| {
        !key.to_str()
            .is_some_and(|key| key.eq_ignore_ascii_case(name))
    });
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detect::DetectEnv;
    use serde_json::{Value, json};
    use std::ffi::OsString;
    use std::io::{BufRead, Write};
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;
    use tempfile::TempDir;

    const ACCOUNT_ID: &str = "5c61fc90-b5b6-4970-979c-a5876275e90f";
    const AUTH_URL: &str = "https://auth.openai.com/oauth/authorize?client_id=official";
    const LOGIN_ID: &str = "1dd5994d-b5dd-47b6-a4b0-ea1e351651b5";

    struct Fixture {
        _temp: TempDir,
        profiles: Arc<ManagedProfiles>,
        manager: CodexAccountAuthManager,
        exit_marker: PathBuf,
        // Fields drop in declaration order. Keep the shared slot last so it covers the child,
        // bounded RPC/process cleanup, profile authority, and temporary-root teardown.
        _recursive_test_process_slot: std::sync::MutexGuard<'static, ()>,
    }

    fn fixture(scenario: &str) -> Fixture {
        fixture_with_timeouts(
            scenario,
            AuthTimeouts {
                request: Duration::from_secs(2),
                login: Duration::from_secs(2),
                terminate_grace: Duration::from_millis(50),
            },
        )
    }

    fn fixture_with_timeouts(scenario: &str, timeouts: AuthTimeouts) -> Fixture {
        let recursive_test_process_slot = lock(&crate::RECURSIVE_TEST_EXECUTABLE_SLOT);
        let temp = tempfile::tempdir().expect("tempdir");
        let temp_root = if cfg!(target_os = "macos") {
            temp.path().canonicalize().expect("canonical tempdir")
        } else {
            temp.path().to_path_buf()
        };
        let profiles = Arc::new(
            ManagedProfiles::new(temp_root.join("managed-profiles")).expect("managed profiles"),
        );
        let current_exe = std::env::current_exe().expect("current test executable");
        let exit_marker = temp_root.join("fake-app-server-exited");
        let source_env = DetectEnv {
            vars: vec![
                (
                    "HOME".into(),
                    temp_root.join("ordinary-home").into_os_string(),
                ),
                (
                    "USERPROFILE".into(),
                    temp_root.join("ordinary-home").into_os_string(),
                ),
                ("OPENAI_API_KEY".into(), "must-not-reach-child".into()),
                (
                    "CODEX_APP_SERVER_LOGIN_ISSUER".into(),
                    "https://attacker.invalid".into(),
                ),
                (
                    "CODEX_APP_SERVER_LOGIN_CLIENT_ID".into(),
                    "attacker-client".into(),
                ),
                ("CODEX_APP_SERVER_DEV_OPEN_APP_URL".into(), "1".into()),
            ],
            windows: cfg!(windows),
            probe_timeout: Some(Duration::from_secs(2)),
        };
        let mut extra_env: BTreeMap<OsString, OsString> = [
            (
                OsString::from("ACCOUNT_AUTH_FAKE_SCENARIO"),
                scenario.into(),
            ),
            (
                OsString::from("ACCOUNT_AUTH_FAKE_EXIT_MARKER"),
                exit_marker.clone().into_os_string(),
            ),
        ]
        .into_iter()
        .collect();
        if scenario == "cleanup_unproven" {
            extra_env.insert("ACCOUNT_AUTH_FORCE_CLEANUP_FAILURE".into(), "1".into());
        }
        let manager = CodexAccountAuthManager::new_for_test(
            current_exe,
            source_env,
            Arc::clone(&profiles),
            vec![
                "--exact".into(),
                "account_auth::tests::fake_codex_app_server".into(),
                "--nocapture".into(),
            ],
            extra_env,
            timeouts,
        );
        Fixture {
            _temp: temp,
            profiles,
            manager,
            exit_marker,
            _recursive_test_process_slot: recursive_test_process_slot,
        }
    }

    #[test]
    fn reads_account_only_from_official_app_server_response() {
        let fixture = fixture("read_connected");
        let state = fixture
            .manager
            .read_account(ACCOUNT_ID)
            .expect("account read");

        assert_eq!(
            state,
            CodexAccountState {
                account: Some(CodexChatGptAccount {
                    email: Some("person@example.test".into()),
                    plan_type: "pro".into(),
                }),
                requires_openai_auth: true,
            }
        );
    }

    #[test]
    fn supplied_account_lease_is_held_through_observation_and_process_cleanup() {
        let fixture = fixture("read_connected");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("codex", ACCOUNT_ID)
            .expect("exclusive lease");
        let observed = std::sync::atomic::AtomicBool::new(false);
        fixture
            .manager
            .read_account_with_lease_observed(ACCOUNT_ID, lease, |result| {
                assert!(result.is_ok());
                assert!(
                    fixture
                        .profiles
                        .acquire_session_lease("codex", ACCOUNT_ID)
                        .is_err(),
                    "observer must run before the auth lease is released"
                );
                observed.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .expect("account read");
        assert!(observed.load(std::sync::atomic::Ordering::SeqCst));
        let _session = fixture
            .profiles
            .acquire_session_lease("codex", ACCOUNT_ID)
            .expect("app-server exited before return");
    }

    #[test]
    fn unproven_cleanup_retains_the_profile_lease_fail_closed() {
        let fixture = fixture("cleanup_unproven");
        let error = fixture
            .manager
            .read_account(ACCOUNT_ID)
            .expect_err("forced cleanup failure");
        assert!(matches!(error, CodexAccountAuthError::ConnectionEnded));
        assert!(
            fixture
                .profiles
                .acquire_session_lease("codex", ACCOUNT_ID)
                .is_err(),
            "cleanup uncertainty must retain the exclusive profile lease"
        );
    }

    #[test]
    fn unproven_login_cleanup_never_reports_a_removable_terminal() {
        let fixture = fixture("cleanup_unproven");
        let pending = fixture
            .manager
            .start_chatgpt_login(ACCOUNT_ID)
            .expect("start login");
        assert!(matches!(
            pending.wait(),
            Err(CodexAccountAuthError::ConnectionEnded)
        ));
        assert!(
            !pending.is_finished(),
            "unproven cleanup must remain tracked by IPC/shutdown"
        );
        assert!(matches!(
            pending.cancel(),
            Err(CodexAccountAuthError::ConnectionEnded)
        ));
        assert!(
            fixture
                .profiles
                .acquire_session_lease("codex", ACCOUNT_ID)
                .is_err(),
            "unproven login cleanup retains the exclusive profile lease"
        );
    }

    #[test]
    fn successful_login_ignores_stale_completion_and_rereads_account() {
        let fixture = fixture("login_stale_then_success");
        let pending = fixture
            .manager
            .start_chatgpt_login(ACCOUNT_ID)
            .expect("start login");
        assert_eq!(pending.auth_url().as_str(), AUTH_URL);
        let debug = format!("{pending:?}");
        assert!(!debug.contains(AUTH_URL));
        assert!(!debug.contains(LOGIN_ID));

        let state = pending.wait().expect("completed login");
        assert_eq!(
            state.account,
            Some(CodexChatGptAccount {
                email: Some("connected@example.test".into()),
                plan_type: "plus".into(),
            })
        );
    }

    #[test]
    fn already_connected_is_observed_only_after_confirmed_process_exit() {
        let fixture = fixture("read_connected");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("codex", ACCOUNT_ID)
            .expect("exclusive lease");
        let observed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observer_flag = Arc::clone(&observed);
        let exit_marker = fixture.exit_marker.clone();
        let error = fixture
            .manager
            .start_chatgpt_login_with_lease_observed(ACCOUNT_ID, lease, move |result| {
                assert!(result.is_ok(), "connected account remains positive truth");
                assert!(
                    exit_marker.exists(),
                    "provider cleanup must finish before positive truth is published"
                );
                observer_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .expect_err("an existing connection does not start another login");
        assert_eq!(error, CodexAccountAuthError::AlreadyConnected);
        assert!(observed.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn rejects_non_official_auth_origin_without_leaking_it() {
        let fixture = fixture("login_bad_origin");
        let error = fixture
            .manager
            .start_chatgpt_login(ACCOUNT_ID)
            .expect_err("untrusted origin must be rejected");
        let rendered = error.to_string();
        assert!(!rendered.contains("attacker.invalid"));
        assert!(rendered.contains("official authentication origin"));
    }

    #[test]
    fn rejects_app_server_that_reports_a_different_profile_home() {
        let fixture = fixture("wrong_profile_home");
        let error = fixture
            .manager
            .read_account(ACCOUNT_ID)
            .expect_err("app-server home must match selected profile");
        assert!(matches!(error, CodexAccountAuthError::InvalidResponse));
    }

    #[test]
    fn provider_login_failure_does_not_expose_provider_error_text() {
        let fixture = fixture("login_failure");
        let pending = fixture
            .manager
            .start_chatgpt_login(ACCOUNT_ID)
            .expect("start login");
        let rendered = pending.wait().expect_err("login failure").to_string();
        assert!(rendered.contains("sign-in failed"));
        assert!(!rendered.contains("provider-secret"));
    }

    #[test]
    fn login_timeout_is_bounded_and_cancels_the_official_flow() {
        let fixture = fixture_with_timeouts(
            "login_wait_for_cancel",
            AuthTimeouts {
                request: Duration::from_secs(1),
                login: Duration::from_millis(75),
                terminate_grace: Duration::from_millis(25),
            },
        );
        let pending = fixture
            .manager
            .start_chatgpt_login(ACCOUNT_ID)
            .expect("start login");
        let error = pending.wait().expect_err("login must time out");
        assert!(matches!(error, CodexAccountAuthError::TimedOut));
    }

    #[test]
    fn successful_completion_without_account_is_not_reported_connected() {
        let fixture = fixture("login_success_missing_account");
        let pending = fixture
            .manager
            .start_chatgpt_login(ACCOUNT_ID)
            .expect("start login");
        let error = pending
            .wait()
            .expect_err("completion alone is not account proof");
        assert!(error.to_string().contains("did not confirm an account"));
    }

    #[test]
    fn explicit_cancel_uses_matching_login_id() {
        let fixture = fixture("login_wait_for_cancel");
        let pending = fixture
            .manager
            .start_chatgpt_login(ACCOUNT_ID)
            .expect("start login");
        pending.cancel().expect("cancel login");
        let _lease = fixture
            .profiles
            .acquire_session_lease("codex", ACCOUNT_ID)
            .expect("cancel waits for process cleanup before returning");
        let error = pending.wait().expect_err("canceled login has no account");
        assert!(matches!(error, CodexAccountAuthError::Canceled));
    }

    #[test]
    fn concurrent_cancel_callers_share_one_quiescent_terminal_outcome() {
        let fixture = fixture("login_wait_for_cancel_delayed");
        let pending = Arc::new(
            fixture
                .manager
                .start_chatgpt_login(ACCOUNT_ID)
                .expect("start login"),
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
        assert!(
            pending.is_finished(),
            "cancel returns only after worker cleanup"
        );
        assert!(fixture.exit_marker.exists(), "app-server must have exited");
        let _lease = fixture
            .profiles
            .acquire_session_lease("codex", ACCOUNT_ID)
            .expect("both cancel callers observed profile quiescence");
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

        let fixture = fixture("login_wait_for_cancel");
        let lease = fixture
            .profiles
            .acquire_sign_in_lease("codex", ACCOUNT_ID)
            .expect("exclusive lease");
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let mut release = ReleaseOnDrop(Some(release_tx));
        let mut pending = fixture
            .manager
            .start_chatgpt_login_with_lease_observed(ACCOUNT_ID, lease, move |_| {
                entered_tx
                    .send(())
                    .map_err(|_| CodexAccountAuthError::StateUpdateFailed)?;
                release_rx
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|_| CodexAccountAuthError::StateUpdateFailed)?;
                Ok(())
            })
            .expect("start login");
        pending.wait_timeout = Duration::from_millis(10);

        let wait_result = pending.wait();
        let observer_entered = entered_rx.recv_timeout(Duration::from_secs(5));
        let lease_remained_exclusive = fixture
            .profiles
            .acquire_session_lease("codex", ACCOUNT_ID)
            .is_err();
        release.release();
        let cancel_result = pending.cancel();
        let cleanup_finished = pending.is_finished();
        let session_lease_after_cleanup =
            fixture.profiles.acquire_session_lease("codex", ACCOUNT_ID);

        assert!(matches!(wait_result, Err(CodexAccountAuthError::TimedOut)));
        observer_entered.expect("cleanup observer was not reached");
        assert!(
            lease_remained_exclusive,
            "a wait timeout must retain the auth lease through final observation"
        );
        cancel_result.expect("join requested cancellation");
        assert!(cleanup_finished);
        let _lease =
            session_lease_after_cleanup.expect("lease releases only after delayed cleanup");
    }

    #[test]
    fn logout_operates_only_on_managed_profile_and_confirms_empty_state() {
        let fixture = fixture("logout");
        let state = fixture.manager.logout(ACCOUNT_ID).expect("logout");
        assert_eq!(
            state,
            CodexAccountState {
                account: None,
                requires_openai_auth: true,
            }
        );
    }

    #[test]
    fn validates_only_official_https_authorization_origin() {
        for accepted in [
            "https://auth.openai.com/oauth/authorize",
            "https://AUTH.OPENAI.COM/oauth/authorize?x=1",
            "https://auth.openai.com:443/oauth/authorize",
        ] {
            assert!(
                CodexAuthUrl::parse(accepted.to_owned()).is_ok(),
                "{accepted}"
            );
        }
        for rejected in [
            "http://auth.openai.com/oauth/authorize",
            "https://auth.openai.com.evil.invalid/oauth/authorize",
            "https://person@auth.openai.com/oauth/authorize",
            "https://auth.openai.com:444/oauth/authorize",
            "https://auth.openai.com/other",
            "https://auth.openai.com\\@evil.invalid/oauth/authorize",
            "https://auth.openai.com%2eevil.invalid/oauth/authorize",
        ] {
            assert!(
                CodexAuthUrl::parse(rejected.to_owned()).is_err(),
                "{rejected}"
            );
        }
    }

    #[test]
    fn only_verified_consumer_plans_are_supported_by_managed_runtime() {
        for plan in ["free", "go", "plus", "pro", "prolite"] {
            assert!(
                CodexChatGptAccount {
                    email: None,
                    plan_type: plan.into(),
                }
                .managed_runtime_is_supported()
            );
        }
        for plan in [
            "team",
            "self_serve_business_prolite",
            "business",
            "ent26",
            "enterprise",
            "edu",
            "unknown",
        ] {
            assert!(
                !CodexChatGptAccount {
                    email: None,
                    plan_type: plan.into(),
                }
                .managed_runtime_is_supported()
            );
        }

        for plan in [
            "team",
            "self_serve_business_prolite",
            "business",
            "ent26",
            "enterprise",
            "edu",
            "education",
        ] {
            assert_eq!(
                CodexChatGptAccount {
                    email: None,
                    plan_type: plan.into(),
                }
                .cloud_config_eligibility(),
                managed_policy::CloudConfigEligibility::Eligible,
                "{plan}"
            );
        }
        assert_eq!(
            CodexChatGptAccount {
                email: None,
                plan_type: "future_plan".into(),
            }
            .cloud_config_eligibility(),
            managed_policy::CloudConfigEligibility::Unknown
        );
    }

    #[test]
    fn fake_codex_app_server() {
        let Ok(scenario) = std::env::var("ACCOUNT_AUTH_FAKE_SCENARIO") else {
            return;
        };
        run_fake_server(&scenario);
    }

    fn run_fake_server(scenario: &str) {
        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout().lock();
        let codex_home = std::env::var("CODEX_HOME").expect("managed CODEX_HOME");
        assert!(std::env::var_os("OPENAI_API_KEY").is_none());
        assert!(std::env::var_os("CODEX_APP_SERVER_LOGIN_ISSUER").is_none());
        assert!(std::env::var_os("CODEX_APP_SERVER_LOGIN_CLIENT_ID").is_none());
        assert!(std::env::var_os("CODEX_APP_SERVER_DEV_OPEN_APP_URL").is_none());
        let ordinary_home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
        assert!(ordinary_home.is_some(), "ordinary home is preserved");

        let mut reads = 0usize;
        for line in stdin.lock().lines() {
            let line = line.expect("stdin line");
            let Ok(request) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let method = request.get("method").and_then(Value::as_str).unwrap_or("");
            let id = request.get("id").cloned();
            match method {
                "initialize" => {
                    assert_eq!(
                        request["params"],
                        json!({
                            "clientInfo": {"name":"kalcode","title":null,"version":env!("CARGO_PKG_VERSION")},
                            "capabilities": {"experimentalApi":false}
                        })
                    );
                    let reported_home = if scenario == "wrong_profile_home" {
                        std::env::temp_dir().join("not-the-managed-profile")
                    } else {
                        PathBuf::from(&codex_home)
                    };
                    respond(
                        &mut stdout,
                        id,
                        json!({
                            "userAgent":"codex_cli_rs/0.155.1",
                            "codexHome":reported_home,
                            "platformFamily":if cfg!(windows) {"windows"} else {"unix"},
                            "platformOs":std::env::consts::OS,
                        }),
                    );
                }
                "initialized" => assert!(id.is_none()),
                "account/read" => {
                    assert_eq!(request["params"], json!({"refreshToken":false}));
                    reads += 1;
                    let result = match scenario {
                        "read_connected" => account("person@example.test", "pro"),
                        "login_stale_then_success" if reads > 1 => {
                            account("connected@example.test", "plus")
                        }
                        "logout" if reads == 1 => account("before@example.test", "pro"),
                        _ => json!({"account":null,"requiresOpenaiAuth":true}),
                    };
                    respond(&mut stdout, id, result);
                }
                "account/login/start" => {
                    assert_eq!(request["params"], json!({"type":"chatgpt"}));
                    let auth_url = if scenario == "login_bad_origin" {
                        "https://attacker.invalid/oauth/authorize?secret=do-not-print"
                    } else {
                        AUTH_URL
                    };
                    respond(
                        &mut stdout,
                        id,
                        json!({"type":"chatgpt","loginId":LOGIN_ID,"authUrl":auth_url}),
                    );
                    if scenario == "login_stale_then_success" {
                        notify(
                            &mut stdout,
                            "account/login/completed",
                            json!({"loginId":"stale-login","success":true,"error":null,"onboardingEntrypoint":null}),
                        );
                    }
                    if scenario == "login_failure" {
                        notify(
                            &mut stdout,
                            "account/login/completed",
                            json!({"loginId":LOGIN_ID,"success":false,"error":"provider-secret must not escape","onboardingEntrypoint":null}),
                        );
                    } else if !scenario.starts_with("login_wait_for_cancel")
                        && scenario != "login_bad_origin"
                    {
                        notify(
                            &mut stdout,
                            "account/login/completed",
                            json!({"loginId":LOGIN_ID,"success":true,"error":null,"onboardingEntrypoint":null}),
                        );
                    }
                }
                "account/login/cancel" => {
                    assert_eq!(request["params"], json!({"loginId":LOGIN_ID}));
                    if scenario == "login_wait_for_cancel_delayed" {
                        std::thread::sleep(Duration::from_millis(150));
                    }
                    respond(&mut stdout, id, json!({"status":"canceled"}));
                }
                "account/logout" => {
                    assert!(request.get("params").is_none());
                    respond(&mut stdout, id, json!({}));
                }
                _ => {}
            }
        }
        if let Some(path) = std::env::var_os("ACCOUNT_AUTH_FAKE_EXIT_MARKER") {
            std::fs::write(path, b"exited").expect("exit marker");
        }
    }

    fn account(email: &str, plan: &str) -> Value {
        json!({
            "account":{"type":"chatgpt","email":email,"planType":plan},
            "requiresOpenaiAuth":true
        })
    }

    fn respond(stdout: &mut impl Write, id: Option<Value>, result: Value) {
        writeln!(stdout, "{}", json!({"id":id,"result":result})).expect("response");
        stdout.flush().expect("flush response");
    }

    fn notify(stdout: &mut impl Write, method: &str, params: Value) {
        writeln!(stdout, "{}", json!({"method":method,"params":params})).expect("notification");
        stdout.flush().expect("flush notification");
    }
}
