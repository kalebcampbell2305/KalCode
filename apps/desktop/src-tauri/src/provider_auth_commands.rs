//! Canonical managed-provider account authority and official native provider authentication IPC.
//!
//! Account metadata remains in the core database, provider credentials remain only in the
//! provider's isolated native profile, and official authentication URLs open in the operating
//! system browser without crossing the WebView boundary.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentProvider, AuthState, ProviderError, ProviderId};
use kalcode_contracts::provider_accounts::{
    ProviderAccount, ProviderAccountModel, ProviderAccountModelCatalog,
};
use kalcode_core::{ErrorCategory, IpcError, KalError};
use kalcode_providers::account_auth::{
    CodexAccountAuthError, CodexAccountAuthManager, CodexAccountState, PendingCodexLogin,
};
use kalcode_providers::accounts::AccountStore;
use kalcode_providers::claude_account_auth::{
    ClaudeAccountAuthError, ClaudeAccountAuthManager, ClaudeAccountState, PendingClaudeLogin,
};
use kalcode_providers::codex::managed_policy::CloudConfigEligibility;
use kalcode_providers::gemini_account_auth::{
    self, GeminiAccountAuthError, GeminiAccountAuthManager, GeminiAccountState, PendingGeminiLogin,
};
use kalcode_providers::guardian::{GenerationQuiescenceProof, GuardianError, GuardianRuntime};
use kalcode_providers::managed::ManagedProfiles;
use kalcode_providers::version_window::VersionWindow;
use kalcode_providers::{ClaudeCodeProvider, CodexProvider, DetectEnv, GeminiProvider, catalog};
use serde::Serialize;
use tauri::WebviewWindow;
use tauri_plugin_opener::OpenerExt;

use crate::AppState;

mod cursor;
pub use cursor::*;

#[cfg(feature = "e2e")]
mod e2e;

const CODEX_TRUTH_TTL: Duration = Duration::from_secs(5 * 60);
// Account model discovery is informational and starts asynchronously from the UI. Give an exact
// account's startup refresh time to publish its auth truth instead of leaking that internal
// single-flight as a user-visible error. This never cancels the incumbent validation.
const ACCOUNT_CATALOG_VALIDATION_WAIT: Duration = Duration::from_secs(6);
const MAX_PENDING_LOGINS: usize = 8;
const AUTH_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug)]
enum RuntimeAuthError {
    Account(KalError),
    ProviderUnavailable,
    Busy,
    Provider(CodexAccountAuthError),
    Claude(ClaudeAccountAuthError),
    Gemini(GeminiAccountAuthError),
    GeminiUnavailable,
    Adapter(ProviderError),
    ModelsUnavailable,
}

impl RuntimeAuthError {
    fn into_ipc(self, command: &'static str) -> IpcError {
        if let Self::Claude(error) = &self
            && let Some((code, message)) = claude_failure_ipc(error)
        {
            return KalError::new(ErrorCategory::Provider, code, message).log_and_convert(command);
        }
        let unsupported_window = match &self {
            Self::Gemini(GeminiAccountAuthError::UnsupportedVersion) => {
                Some(&kalcode_providers::gemini::MANAGED_VERSIONS)
            }
            _ => None,
        };
        if let Some(window) = unsupported_window {
            return KalError::new(
                ErrorCategory::Provider,
                "provider_version_unsupported",
                window_unsupported_message(window),
            )
            .log_and_convert(command);
        }
        let (code, message) = match self {
            Self::Account(error) => return error.log_and_convert(command),
            Self::ProviderUnavailable => (
                "provider_auth_unavailable",
                "Codex isn't installed, so KalCode can't open its official account service.",
            ),
            Self::Busy => (
                "provider_account_busy",
                "Finish the current sign-in or stop sessions using this account, then try again.",
            ),
            Self::Provider(CodexAccountAuthError::AlreadyConnected) => (
                "provider_account_already_connected",
                "This managed Codex account is already connected.",
            ),
            Self::Provider(CodexAccountAuthError::Canceled) => {
                ("provider_login_canceled", "Codex sign-in was canceled.")
            }
            Self::Provider(CodexAccountAuthError::NotAuthenticated) => (
                "provider_account_not_authenticated",
                "Connect this Codex account before loading its available models.",
            ),
            Self::Provider(CodexAccountAuthError::IncompatibleCapabilities) => (
                "provider_capability_unavailable",
                "Codex could not start this managed account because the installed runtime is missing required capabilities and no compatible runtime is available. Update Codex, then try again.",
            ),
            Self::Provider(_) => (
                "provider_auth_failed",
                "The official Codex account operation did not complete safely.",
            ),
            Self::Claude(ClaudeAccountAuthError::AlreadyConnected) => (
                "provider_account_already_connected",
                "This managed Claude Code account is already connected.",
            ),
            Self::Claude(ClaudeAccountAuthError::Canceled) => (
                "provider_login_canceled",
                "Claude Code sign-in was canceled.",
            ),
            Self::Claude(_) => (
                "provider_auth_failed",
                "The official Claude Code account operation did not complete safely.",
            ),
            Self::GeminiUnavailable => (
                "provider_auth_unavailable",
                "Gemini CLI isn't installed, so KalCode can't run its official sign-in.",
            ),
            Self::Gemini(GeminiAccountAuthError::AlreadyConnected) => (
                "provider_account_already_connected",
                "This managed Gemini account is already signed in.",
            ),
            Self::Gemini(GeminiAccountAuthError::Canceled) => {
                ("provider_login_canceled", "Gemini sign-in was canceled.")
            }
            Self::Gemini(GeminiAccountAuthError::AccountNotConfirmed) => (
                "provider_login_not_confirmed",
                "Gemini CLI finished without saving a Google sign-in. Try again and finish \
                 signing in in your browser.",
            ),
            Self::Gemini(GeminiAccountAuthError::TimedOut) => (
                "provider_login_timed_out",
                "Gemini sign-in didn't finish in time. Try again.",
            ),
            Self::Gemini(_) => (
                "provider_auth_failed",
                "The official Gemini CLI account operation did not complete safely.",
            ),
            Self::Adapter(error) => {
                let (code, message) = match error {
                    ProviderError::NotInstalled => (
                        "provider_not_installed".to_owned(),
                        "That provider is not installed on this computer.".to_owned(),
                    ),
                    ProviderError::NotAuthenticated => (
                        "provider_account_not_authenticated".to_owned(),
                        "Connect this provider account before loading its available models."
                            .to_owned(),
                    ),
                    ProviderError::Refused { code, message } => (code, message),
                    ProviderError::Protocol(_) => (
                        "provider_models_invalid".to_owned(),
                        "The provider returned an invalid model catalog. Update it, then retry."
                            .to_owned(),
                    ),
                    _ => (
                        "provider_models_unavailable".to_owned(),
                        "KalCode could not load this account's model catalog. Retry when the provider is available."
                            .to_owned(),
                    ),
                };
                return IpcError {
                    category: ErrorCategory::Provider,
                    code,
                    message,
                    retryable: true,
                };
            }
            Self::ModelsUnavailable => (
                "provider_models_unavailable",
                "This provider does not expose a model catalog in this KalCode build.",
            ),
        };
        KalError::new(ErrorCategory::Provider, code, message).log_and_convert(command)
    }
}

/// `provider_version_unsupported` copy for a provider whose certified lines live in a
/// [`VersionWindow`]. Codex compatibility is capability based and does not use this version-window
/// refusal; Gemini still does until its adapter adopts the shared compatibility layer.
fn window_unsupported_message(window: &VersionWindow) -> String {
    let mut message = format!(
        "Managed {profile} accounts need {cli} {range}; pre-release builds aren't supported.",
        profile = window.profile_name,
        cli = window.cli_name,
        range = window.supported_range(),
    );
    match window.install_command() {
        Some(command) => message.push_str(&format!(
            " Install the newest supported version with `{command}`, then try again."
        )),
        None => message.push_str(" Install a supported release, then try again."),
    }
    message.push_str(" (reason: provider_version_unsupported)");
    message
}

/// Whether an account operation was refused only because its profile is busy: a session or
/// another account operation holds the lease, so the operation never started.
fn is_profile_busy(error: &ProviderError) -> bool {
    match error {
        ProviderError::Start(message) => {
            message.contains("already in use") || message.contains("profile is in use")
        }
        ProviderError::Refused { code, .. } => {
            code == kalcode_contracts::threads::error_codes::PROVIDER_ACCOUNT_BUSY
        }
        _ => false,
    }
}

/// User-visible Claude account failures carry a stable, credential-free reason code so a failed
/// sign-in is diagnosable from the toast and the log alone. Returns `None` for the outcomes that
/// already have their own dedicated copy.
fn claude_failure_ipc(error: &ClaudeAccountAuthError) -> Option<(&'static str, String)> {
    match error {
        ClaudeAccountAuthError::AlreadyConnected | ClaudeAccountAuthError::Canceled => None,
        ClaudeAccountAuthError::UnsupportedVersion { found } => Some((
            "provider_version_unsupported",
            format!(
                "Managed Claude Code accounts need Claude Code {}; this computer has {}. Install \
                 a supported release, then try again. (reason: provider_version_unsupported)",
                kalcode_providers::claude::certified_managed_versions_label(),
                found
                    .as_deref()
                    .unwrap_or("a version KalCode couldn't read")
            ),
        )),
        // Catch-all: every other variant shares `provider_auth_failed` and is told apart by its
        // reason code. A new variant that needs its own IPC code or copy must get an explicit arm
        // above; it will not get one automatically.
        error => Some((
            "provider_auth_failed",
            format!(
                "The official Claude Code account operation did not complete safely. \
                 (reason: {}{})",
                error.reason_code(),
                error
                    .exit_code()
                    .map(|code| format!(", exit {code}"))
                    .unwrap_or_default()
            ),
        )),
    }
}

#[derive(Clone, Copy)]
struct EligibilityEntry {
    eligibility: CloudConfigEligibility,
    generation: u64,
    checked_at: Instant,
}

#[derive(Default)]
struct CodexTruth {
    cache: HashMap<String, EligibilityEntry>,
    generations: HashMap<String, u64>,
    active_operations: HashSet<String>,
}

struct RuntimeInner {
    guardian: GuardianRuntime,
    accounts: AccountStore,
    profiles: Arc<ManagedProfiles>,
    source_env: DetectEnv,
    claude_auth: Option<Arc<ClaudeAccountAuthManager>>,
    codex_auth: Option<Arc<CodexAccountAuthManager>>,
    gemini_auth: Option<Arc<GeminiAccountAuthManager>>,
    codex_truth: Mutex<CodexTruth>,
    active_validations: Mutex<HashMap<(String, String), Arc<AtomicBool>>>,
    validation_changed: Condvar,
}

/// Cheap clone passed to every runtime factory. It is the only desktop owner of account metadata,
/// managed-profile roots, and current Codex plan eligibility.
#[derive(Clone)]
pub struct ProviderRuntimeAuthority {
    inner: Arc<RuntimeInner>,
}

struct AccountOperation {
    runtime: ProviderRuntimeAuthority,
    account_id: String,
    generation: u64,
}

struct AccountValidation {
    runtime: ProviderRuntimeAuthority,
    key: (String, String),
    canceled: Arc<AtomicBool>,
}

impl AccountValidation {
    fn cancellation(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.canceled)
    }
}

impl Drop for AccountValidation {
    fn drop(&mut self) {
        let mut active = self
            .runtime
            .inner
            .active_validations
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if active
            .get(&self.key)
            .is_some_and(|canceled| Arc::ptr_eq(canceled, &self.canceled))
        {
            active.remove(&self.key);
        }
        self.runtime.inner.validation_changed.notify_all();
    }
}

impl Drop for AccountOperation {
    fn drop(&mut self) {
        let mut truth = self
            .runtime
            .inner
            .codex_truth
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if truth.generations.get(&self.account_id) == Some(&self.generation) {
            truth.active_operations.remove(&self.account_id);
        }
    }
}

impl ProviderRuntimeAuthority {
    fn start(core: Arc<kalcode_core::Core>, data_dir: &std::path::Path) -> Result<Self, String> {
        let executable =
            std::env::current_exe().map_err(|_| "desktop_executable_unavailable".to_owned())?;
        let directory = executable
            .parent()
            .ok_or_else(|| "desktop_executable_unavailable".to_owned())?;
        let helper = directory.join(if cfg!(windows) {
            "kalcode-provider-guardian.exe"
        } else {
            "kalcode-provider-guardian"
        });
        Self::start_with_helper(core, data_dir, &helper)
    }

    fn start_with_helper(
        core: Arc<kalcode_core::Core>,
        data_dir: &std::path::Path,
        helper: &std::path::Path,
    ) -> Result<Self, String> {
        let guardian = GuardianRuntime::launch(helper, data_dir).map_err(|error| {
            match error {
                GuardianError::RecoveryOwned => "workspace_owned",
                GuardianError::RecoveryPending
                | GuardianError::QuiescencePending
                | GuardianError::BlockedUnclean => "workspace_recovery_pending",
                GuardianError::CorruptMarker
                | GuardianError::UnknownSchema(_)
                | GuardianError::MarkerEncoding(_) => "workspace_recovery_metadata_invalid",
                _ => "provider_guardian_unavailable",
            }
            .to_owned()
        })?;
        let profiles = Arc::new(
            ManagedProfiles::for_data_dir_guarded(
                data_dir,
                guardian.authority(),
                guardian.profile_generation(),
            )
            .map_err(|_| "managed_profile_root_unavailable".to_owned())?,
        );
        let source_env = DetectEnv::from_process();
        let claude_auth = source_env
            .resolve_executable_only(&catalog::claude_spec())
            .map(|executable| {
                Arc::new(ClaudeAccountAuthManager::new(
                    executable,
                    source_env.clone(),
                    Arc::clone(&profiles),
                ))
            });
        // Keep the manager available even when Codex is installed after KalCode starts. Each
        // account operation resolves the current binary again, so this fallback is only a
        // construction placeholder and is never used to launch a missing CLI.
        let codex_auth = Some(codex_auth_manager(&source_env, &profiles));
        let gemini_auth = source_env
            .resolve_executable_only(&catalog::gemini_spec())
            .map(|executable| {
                Arc::new(GeminiAccountAuthManager::new(
                    executable,
                    source_env.clone(),
                    Arc::clone(&profiles),
                ))
            });
        let accounts = AccountStore::new(core);
        accounts
            .restore_legacy_startup_invalidations()
            .map_err(|_| "provider_account_restore_failed".to_owned())?;
        Ok(Self {
            inner: Arc::new(RuntimeInner {
                guardian,
                accounts,
                profiles,
                source_env,
                claude_auth,
                codex_auth,
                gemini_auth,
                codex_truth: Mutex::new(CodexTruth::default()),
                active_validations: Mutex::new(HashMap::new()),
                validation_changed: Condvar::new(),
            }),
        })
    }

    pub fn managed_profiles(&self) -> ManagedProfiles {
        self.inner.profiles.as_ref().clone()
    }

    pub fn seal(&self) -> Result<(), GuardianError> {
        self.inner.guardian.authority().seal()
    }

    pub fn drain_guardian(&self) -> Result<GenerationQuiescenceProof, GuardianError> {
        self.inner.guardian.seal_and_drain()
    }

    pub fn terminal_guardian(
        &self,
    ) -> Result<Arc<dyn kalcode_core::workspaces::PtyGuardian>, GuardianError> {
        self.inner.guardian.terminal_guardian()
    }

    pub fn probe_guardian(
        &self,
    ) -> Result<kalcode_providers::guardian::ProviderProbeGuardian, GuardianError> {
        self.inner.guardian.probe_guardian()
    }

    pub fn account_store(&self) -> AccountStore {
        self.inner.accounts.clone()
    }

    fn begin_account_validation(
        &self,
        provider: &str,
        account_id: &str,
    ) -> Result<AccountValidation, RuntimeAuthError> {
        let key = (provider.to_owned(), account_id.to_owned());
        let mut active = self
            .inner
            .active_validations
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if active.contains_key(&key) {
            return Err(RuntimeAuthError::Busy);
        }
        let canceled = Arc::new(AtomicBool::new(false));
        active.insert(key.clone(), Arc::clone(&canceled));
        Ok(AccountValidation {
            runtime: self.clone(),
            key,
            canceled,
        })
    }

    /// Waits for one exact account validation and takes its slot atomically. Catalog reads are
    /// allowed to follow a startup refresh, but must never cancel it or race another refresh into
    /// the gap between observing a free slot and claiming it.
    fn begin_account_catalog_validation(
        &self,
        provider: &str,
        account_id: &str,
        timeout: Duration,
    ) -> Result<AccountValidation, RuntimeAuthError> {
        let key = (provider.to_owned(), account_id.to_owned());
        let started = Instant::now();
        let deadline = started.checked_add(timeout).unwrap_or(started);
        let mut active = self
            .inner
            .active_validations
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        loop {
            if !active.contains_key(&key) {
                let canceled = Arc::new(AtomicBool::new(false));
                active.insert(key.clone(), Arc::clone(&canceled));
                return Ok(AccountValidation {
                    runtime: self.clone(),
                    key,
                    canceled,
                });
            }

            let now = Instant::now();
            if now >= deadline {
                return Err(RuntimeAuthError::Busy);
            }
            let waited = self
                .inner
                .validation_changed
                .wait_timeout(active, deadline.saturating_duration_since(now))
                .unwrap_or_else(PoisonError::into_inner);
            active = waited.0;
            if waited.1.timed_out() && active.contains_key(&key) {
                return Err(RuntimeAuthError::Busy);
            }
        }
    }

    /// Asks one exact background validation to stop. The observer sees the token within one
    /// receive poll, ends its read without recording a result, and tears down on its own thread.
    fn cancel_account_validation(&self, provider: &str, account_id: &str) {
        let key = (provider.to_owned(), account_id.to_owned());
        let active = self
            .inner
            .active_validations
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(canceled) = active.get(&key) {
            canceled.store(true, Ordering::Release);
        }
    }

    /// Cancels one exact background validation and waits for its RAII registration to be removed.
    /// The provider process receives the cancellation token, proves cleanup, then the validation
    /// removes itself and wakes this waiter. No provider I/O runs while the registry mutex is held.
    #[cfg(test)]
    fn preempt_account_validation(
        &self,
        provider: &str,
        account_id: &str,
        timeout: Duration,
    ) -> bool {
        let key = (provider.to_owned(), account_id.to_owned());
        let deadline = Instant::now() + timeout;
        let mut active = self
            .inner
            .active_validations
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(canceled) = active.get(&key) {
            canceled.store(true, Ordering::Release);
        }
        while active.contains_key(&key) {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let waited = self
                .inner
                .validation_changed
                .wait_timeout(active, deadline.saturating_duration_since(now))
                .unwrap_or_else(PoisonError::into_inner);
            active = waited.0;
            if waited.1.timed_out() && active.contains_key(&key) {
                return false;
            }
        }
        true
    }

    /// Seeds credential-free managed-provider identities only for the explicitly attested native
    /// E2E data directory. Shipped builds do not compile this entry point.
    #[cfg(feature = "e2e")]
    pub(crate) fn seed_e2e_fixture(&self, data_dir: &std::path::Path) -> Result<(), &'static str> {
        e2e::seed_from_environment(self, data_dir).map_err(|error| error.code)
    }

    fn observe_claude(
        &self,
        account_id: &str,
        result: &Result<ClaudeAccountState, ClaudeAccountAuthError>,
    ) -> Result<(), ClaudeAccountAuthError> {
        let update = match result {
            Ok(state) if state.logged_in => self.inner.accounts.mark_authentication(
                account_id,
                AuthState::Authenticated,
                state.identity.as_deref(),
                None,
            ),
            Ok(_) => self.inner.accounts.mark_authentication(
                account_id,
                AuthState::NotAuthenticated,
                None,
                None,
            ),
            Err(_) => self
                .inner
                .accounts
                .mark_validation_error(account_id, "claude_auth_failed"),
        };
        update
            .map(|_| ())
            .map_err(|_| ClaudeAccountAuthError::StateUpdateFailed)
    }

    fn refresh_claude_account(
        &self,
        account_id: &str,
    ) -> Result<ProviderAccount, RuntimeAuthError> {
        // Claude Code 2.1.x may refresh OAuth credentials while evaluating `auth status --json`,
        // and its short-lived status path can exit before that refresh drains. Startup must never
        // risk corrupting a valid provider-native session. Restore the durable safe account state;
        // the long-lived Claude coding process remains the authoritative native session check.
        let restored = self
            .inner
            .accounts
            .get_active_for_provider(account_id, &ProviderId::new(ProviderId::CLAUDE_CODE))
            .map_err(RuntimeAuthError::Account)?;
        if restored.last_error_code.as_deref() == Some("claude_auth_failed") {
            // This code was produced by the retired short-lived status probe and is no longer an
            // authoritative health signal. Clear only that obsolete error; keep auth/identity and
            // every real launch failure unchanged.
            return self
                .inner
                .accounts
                .clear_validation_error(account_id)
                .map_err(RuntimeAuthError::Account);
        }
        Ok(restored)
    }

    fn start_claude_login(
        &self,
        account_id: &str,
    ) -> Result<Arc<PendingClaudeLogin>, RuntimeAuthError> {
        let manager = self
            .inner
            .claude_auth
            .as_ref()
            .cloned()
            .ok_or(RuntimeAuthError::ProviderUnavailable)?;
        let observer = self.clone();
        let observed_account_id = account_id.to_owned();
        let recorded_failure = Arc::new(Mutex::new(None));
        let provider_failure = Arc::clone(&recorded_failure);
        let result = self.inner.accounts.authenticate_with_active_account(
            &self.inner.profiles,
            ProviderId::CLAUDE_CODE,
            account_id,
            move |_, lease| {
                manager
                    .start_login_with_lease_observed(account_id, lease, move |result| {
                        observer.observe_claude(&observed_account_id, result)
                    })
                    .map(Arc::new)
                    .map_err(|error| {
                        *provider_failure
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner) = Some(error.clone());
                        ProviderError::Start(error.to_string())
                    })
            },
        );
        if let Err(error) = &result {
            let failure = recorded_failure
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            // Only a lease refused for a busy profile ran no Claude operation and changes no
            // account state. Any other failure before the operation (an invalid, archived or
            // other-provider account, or an unreadable profile) is not busy.
            if failure.is_none() && is_profile_busy(error) {
                return Err(RuntimeAuthError::Busy);
            }
            if failure != Some(ClaudeAccountAuthError::AlreadyConnected) {
                let _ = self
                    .inner
                    .accounts
                    .mark_validation_error(account_id, "claude_auth_failed");
            }
            return Err(RuntimeAuthError::Claude(
                failure.unwrap_or(ClaudeAccountAuthError::ProfileUnavailable),
            ));
        }
        result.map_err(|_| RuntimeAuthError::Claude(ClaudeAccountAuthError::StartFailed))
    }

    fn logout_claude(&self, account_id: &str) -> Result<ProviderAccount, RuntimeAuthError> {
        let manager = self
            .inner
            .claude_auth
            .as_ref()
            .cloned()
            .ok_or(RuntimeAuthError::ProviderUnavailable)?;
        let observer = self.clone();
        let recorded_failure = Arc::new(Mutex::new(None));
        let provider_failure = Arc::clone(&recorded_failure);
        let result = self.inner.accounts.authenticate_with_active_account(
            &self.inner.profiles,
            ProviderId::CLAUDE_CODE,
            account_id,
            move |_, lease| {
                manager
                    .logout_with_lease_observed(account_id, lease, move |result| {
                        observer.observe_claude(account_id, result)
                    })
                    .map_err(|error| {
                        *provider_failure
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner) = Some(error.clone());
                        ProviderError::Start(error.to_string())
                    })
            },
        );
        if let Err(error) = &result {
            let failure = recorded_failure
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            // Only a lease refused for a busy profile ran no Claude operation and changes no
            // account state. Any other failure before the operation (an invalid, archived or
            // other-provider account, or an unreadable profile) is not busy.
            if failure.is_none() && is_profile_busy(error) {
                return Err(RuntimeAuthError::Busy);
            }
            let _ = self
                .inner
                .accounts
                .mark_validation_error(account_id, "claude_auth_failed");
            return Err(RuntimeAuthError::Claude(
                failure.unwrap_or(ClaudeAccountAuthError::ProfileUnavailable),
            ));
        }
        self.inner
            .accounts
            .get(account_id)
            .map_err(RuntimeAuthError::Account)
    }

    fn observe_gemini(
        &self,
        account_id: &str,
        result: &Result<GeminiAccountState, GeminiAccountAuthError>,
    ) -> Result<(), GeminiAccountAuthError> {
        // The identity is Gemini's `active` Google account (display only, never logged). A
        // provider-confirmed sign-out clears it; a failed check preserves the last safe value.
        let update = match result {
            Ok(state) => self.inner.accounts.mark_authentication(
                account_id,
                state.auth,
                state.identity.as_deref(),
                None,
            ),
            Err(_) => self
                .inner
                .accounts
                .mark_validation_error(account_id, "gemini_auth_failed"),
        };
        update
            .map(|_| ())
            .map_err(|_| GeminiAccountAuthError::StateUpdateFailed)
    }

    fn gemini_manager(&self) -> Result<Arc<GeminiAccountAuthManager>, RuntimeAuthError> {
        self.inner
            .gemini_auth
            .as_ref()
            .cloned()
            .ok_or(RuntimeAuthError::GeminiUnavailable)
    }

    /// Runs one Gemini account operation under the account's exclusive lease and records a
    /// bounded failure when the provider operation (or the lease itself) did not succeed.
    fn with_gemini_account<T>(
        &self,
        account_id: &str,
        operation: impl FnOnce(
            kalcode_providers::managed::ProfileLease,
        ) -> Result<T, GeminiAccountAuthError>,
    ) -> Result<T, RuntimeAuthError> {
        let recorded_failure = Arc::new(Mutex::new(None));
        let provider_failure = Arc::clone(&recorded_failure);
        let result = self.inner.accounts.authenticate_with_active_account(
            &self.inner.profiles,
            ProviderId::GEMINI_CLI,
            account_id,
            move |_, lease| {
                operation(lease).map_err(|error| {
                    *provider_failure
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = Some(error.clone());
                    ProviderError::Start(error.to_string())
                })
            },
        );
        if let Ok(value) = result {
            return Ok(value);
        }
        let failure = recorded_failure
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        // Record only a failure of Gemini's own operation. A busy profile or an account that isn't
        // an active Gemini account changes nothing (never another provider's account state).
        if failure
            .as_ref()
            .is_some_and(|error| *error != GeminiAccountAuthError::AlreadyConnected)
        {
            let _ = self
                .inner
                .accounts
                .mark_validation_error(account_id, "gemini_auth_failed");
        }
        Err(match failure {
            Some(error) => RuntimeAuthError::Gemini(error),
            None => RuntimeAuthError::Busy,
        })
    }

    /// Reads Gemini's own credential presence for the account. No provider process runs, so this
    /// works even when Gemini CLI isn't installed.
    fn refresh_gemini_account(
        &self,
        account_id: &str,
    ) -> Result<ProviderAccount, RuntimeAuthError> {
        let _validation = self.begin_account_validation(ProviderId::GEMINI_CLI, account_id)?;
        let observer = self.clone();
        let profiles = Arc::clone(&self.inner.profiles);
        let observer_profiles = Arc::clone(&profiles);
        let recorded_failure = Arc::new(Mutex::new(None));
        let provider_failure = Arc::clone(&recorded_failure);
        let result = self.inner.accounts.observe_with_active_account(
            &profiles,
            ProviderId::GEMINI_CLI,
            account_id,
            move |_, lease| {
                gemini_account_auth::observe_account_with_lease_observed(
                    &observer_profiles,
                    account_id,
                    lease,
                    move |result| observer.observe_gemini(account_id, result),
                )
                .map_err(|error| {
                    *provider_failure
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = Some(error.clone());
                    ProviderError::Start(error.to_string())
                })
            },
        );
        if let Err(error) = result {
            let failure = recorded_failure
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            if failure == Some(GeminiAccountAuthError::Canceled) {
                return self
                    .inner
                    .accounts
                    .get(account_id)
                    .map_err(RuntimeAuthError::Account);
            }
            if failure.is_none() && is_profile_busy(&error) {
                return Err(RuntimeAuthError::Busy);
            }
            if failure.is_some() {
                let _ = self
                    .inner
                    .accounts
                    .mark_validation_error(account_id, "gemini_auth_failed");
            }
            return Err(match failure {
                Some(error) => RuntimeAuthError::Gemini(error),
                None => RuntimeAuthError::Busy,
            });
        }
        self.inner
            .accounts
            .get(account_id)
            .map_err(RuntimeAuthError::Account)
    }

    fn start_gemini_login(
        &self,
        account_id: &str,
    ) -> Result<Arc<PendingGeminiLogin>, RuntimeAuthError> {
        let manager = self.gemini_manager()?;
        let observer = self.clone();
        let observed_account_id = account_id.to_owned();
        self.with_gemini_account(account_id, move |lease| {
            manager
                .start_login_with_lease_observed(account_id, lease, move |result| {
                    observer.observe_gemini(&observed_account_id, result)
                })
                .map(Arc::new)
        })
    }

    /// Removes only this account's Gemini credential files. No provider process runs, so a person
    /// can always sign out, even after uninstalling Gemini CLI.
    fn logout_gemini(&self, account_id: &str) -> Result<ProviderAccount, RuntimeAuthError> {
        let observer = self.clone();
        let profiles = Arc::clone(&self.inner.profiles);
        self.with_gemini_account(account_id, |lease| {
            gemini_account_auth::logout_with_lease_observed(
                &profiles,
                account_id,
                lease,
                |result| observer.observe_gemini(account_id, result),
            )
        })?;
        self.inner
            .accounts
            .get(account_id)
            .map_err(RuntimeAuthError::Account)
    }

    fn begin_codex_operation(
        &self,
        account_id: &str,
    ) -> Result<AccountOperation, RuntimeAuthError> {
        let mut truth = self
            .inner
            .codex_truth
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !truth.active_operations.insert(account_id.to_owned()) {
            return Err(RuntimeAuthError::Busy);
        }
        let generation = truth
            .generations
            .get(account_id)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        truth.generations.insert(account_id.to_owned(), generation);
        truth.cache.remove(account_id);
        Ok(AccountOperation {
            runtime: self.clone(),
            account_id: account_id.to_owned(),
            generation,
        })
    }

    fn observe_codex(
        &self,
        account_id: &str,
        generation: u64,
        result: &Result<CodexAccountState, CodexAccountAuthError>,
    ) -> Result<(), CodexAccountAuthError> {
        // The generation check, durable account update, and cache update form one commit. No
        // provider I/O runs under this mutex. Holding it here prevents a superseded observer from
        // writing an expired state between a generation check and the next foreground operation.
        let mut truth = self
            .inner
            .codex_truth
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if truth.generations.get(account_id) != Some(&generation) {
            return Err(CodexAccountAuthError::StateUpdateFailed);
        }
        let eligibility = match result {
            Ok(state) => {
                let (authentication, identity, eligibility) = match &state.account {
                    Some(account) => (
                        AuthState::Authenticated,
                        account.email.as_deref(),
                        Some(state.cloud_config_eligibility()),
                    ),
                    None => (AuthState::NotAuthenticated, None, None),
                };
                self.inner
                    .accounts
                    .mark_authentication(account_id, authentication, identity, None)
                    .map_err(|_| CodexAccountAuthError::StateUpdateFailed)?;
                eligibility
            }
            Err(_) => {
                self.inner
                    .accounts
                    .mark_validation_error(account_id, "codex_auth_failed")
                    .map_err(|_| CodexAccountAuthError::StateUpdateFailed)?;
                None
            }
        };

        truth.cache.remove(account_id);
        if let Some(eligibility) = eligibility {
            truth.cache.insert(
                account_id.to_owned(),
                EligibilityEntry {
                    eligibility,
                    generation,
                    checked_at: Instant::now(),
                },
            );
        }
        Ok(())
    }

    fn cached_codex_eligibility(&self, account_id: &str) -> Option<CloudConfigEligibility> {
        let truth = self
            .inner
            .codex_truth
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let entry = truth.cache.get(account_id)?;
        if truth.generations.get(account_id) != Some(&entry.generation)
            || entry.checked_at.elapsed() > CODEX_TRUTH_TTL
        {
            return None;
        }
        Some(entry.eligibility)
    }

    fn account_models(
        &self,
        account_id: &str,
    ) -> Result<ProviderAccountModelCatalog, RuntimeAuthError> {
        let account = self
            .inner
            .accounts
            .get(account_id)
            .map_err(RuntimeAuthError::Account)?;
        let account = self
            .inner
            .accounts
            .get_active_for_provider(account_id, &account.provider_id)
            .map_err(RuntimeAuthError::Account)?;
        let models = match account.provider_id.as_str() {
            ProviderId::CODEX => self.codex_account_models(account_id, true)?,
            ProviderId::CURSOR => self
                .cursor_models(account_id)
                .map_err(RuntimeAuthError::Adapter)?
                .into_iter()
                .map(|model| ProviderAccountModel {
                    id: model.id,
                    display_name: model.display_name,
                    is_default: model.is_default,
                    default_effort: None,
                    supported_efforts: Vec::new(),
                })
                .collect(),
            provider_id => {
                let capabilities = catalog::capabilities(provider_id)
                    .ok_or(RuntimeAuthError::ModelsUnavailable)?;
                let supported_efforts =
                    kalcode_providers::interactive::supported_efforts(provider_id);
                capabilities
                    .models
                    .into_iter()
                    .map(|model| ProviderAccountModel {
                        id: model.id,
                        display_name: model.display_name,
                        is_default: model.is_default,
                        default_effort: None,
                        supported_efforts: supported_efforts.clone(),
                    })
                    .collect()
            }
        };
        Ok(ProviderAccountModelCatalog {
            account_id: account.id,
            provider_id: account.provider_id,
            models,
        })
    }

    fn codex_account_models(
        &self,
        account_id: &str,
        allow_config_repair: bool,
    ) -> Result<Vec<ProviderAccountModel>, RuntimeAuthError> {
        let validation = self.begin_account_catalog_validation(
            ProviderId::CODEX,
            account_id,
            ACCOUNT_CATALOG_VALIDATION_WAIT,
        )?;
        let cancellation = validation.cancellation();
        let manager = self
            .inner
            .codex_auth
            .as_ref()
            .cloned()
            .ok_or(RuntimeAuthError::ProviderUnavailable)?;
        let recorded_failure = Arc::new(Mutex::new(None));
        let provider_failure = Arc::clone(&recorded_failure);
        let observer = self.clone();
        let observed_account_id = account_id.to_owned();
        let result = self.inner.accounts.observe_with_active_account(
            &self.inner.profiles,
            ProviderId::CODEX,
            account_id,
            move |_, lease| {
                manager
                    .list_models_with_observer_lease_observed(
                        account_id,
                        lease,
                        cancellation,
                        move |result| {
                            if result == &Err(CodexAccountAuthError::NotAuthenticated) {
                                observer
                                    .inner
                                    .accounts
                                    .mark_authentication(
                                        &observed_account_id,
                                        AuthState::NotAuthenticated,
                                        None,
                                        Some("codex_not_authenticated"),
                                    )
                                    .map_err(|_| CodexAccountAuthError::StateUpdateFailed)?;
                            }
                            Ok(())
                        },
                    )
                    .map_err(|error| {
                        *provider_failure
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner) = Some(error.clone());
                        ProviderError::Start(error.to_string())
                    })
            },
        );
        match result {
            Ok(models) => Ok(models
                .into_iter()
                .map(|model| ProviderAccountModel {
                    id: model.model,
                    display_name: model.display_name,
                    is_default: model.is_default,
                    default_effort: Some(model.default_reasoning_effort),
                    supported_efforts: model.supported_reasoning_efforts,
                })
                .collect()),
            Err(error) => {
                let failure = recorded_failure
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .clone();
                if failure == Some(CodexAccountAuthError::Canceled)
                    || (failure.is_none() && is_profile_busy(&error))
                {
                    return Err(RuntimeAuthError::Busy);
                }
                if allow_config_repair
                    && failure == Some(CodexAccountAuthError::ProfileConfigChanged)
                {
                    drop(validation);
                    self.repair_codex_profile_config(account_id)?;
                    return self.codex_account_models(account_id, false);
                }
                Err(match failure {
                    Some(error) => RuntimeAuthError::Provider(error),
                    None if matches!(error, ProviderError::NotInstalled) => {
                        RuntimeAuthError::ProviderUnavailable
                    }
                    None => RuntimeAuthError::Provider(CodexAccountAuthError::ConnectionEnded),
                })
            }
        }
    }

    fn refresh_codex_account(&self, account_id: &str) -> Result<ProviderAccount, RuntimeAuthError> {
        self.refresh_codex_account_inner(account_id, true)
    }

    fn refresh_codex_account_inner(
        &self,
        account_id: &str,
        allow_config_repair: bool,
    ) -> Result<ProviderAccount, RuntimeAuthError> {
        let validation = self.begin_account_validation(ProviderId::CODEX, account_id)?;
        let cancellation = validation.cancellation();
        let manager = self
            .inner
            .codex_auth
            .as_ref()
            .cloned()
            .ok_or(RuntimeAuthError::ProviderUnavailable)?;
        let operation = self.begin_codex_operation(account_id)?;
        let generation = operation.generation;
        let observer = self.clone();
        let recorded_failure = Arc::new(Mutex::new(None));
        let provider_failure = Arc::clone(&recorded_failure);
        let result = self.inner.accounts.observe_with_active_account(
            &self.inner.profiles,
            ProviderId::CODEX,
            account_id,
            move |_, lease| {
                manager
                    .observe_account_with_lease_observed(
                        account_id,
                        lease,
                        cancellation,
                        move |result| observer.observe_codex(account_id, generation, result),
                    )
                    .map_err(|error| {
                        *provider_failure
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner) = Some(error.clone());
                        ProviderError::Start(error.to_string())
                    })
            },
        );
        drop(operation);
        if let Err(error) = result {
            let failure = recorded_failure
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            // A superseded background observer and a busy profile both leave the account's last
            // known state untouched. The foreground operation that superseded it owns the truth.
            if failure == Some(CodexAccountAuthError::Canceled) {
                return self
                    .inner
                    .accounts
                    .get(account_id)
                    .map_err(RuntimeAuthError::Account);
            }
            if failure.is_none() && is_profile_busy(&error) {
                return Err(RuntimeAuthError::Busy);
            }
            if allow_config_repair && failure == Some(CodexAccountAuthError::ProfileConfigChanged) {
                // Normal certified Codex sessions may persist harmless UI/model preferences.
                // Normalize only config.toml under the exact exclusive lease, then retry this
                // read-only check. A live session keeps the repair fail-closed and retains the
                // last safe account state until a later refresh.
                drop(validation);
                return match self.repair_codex_profile_config(account_id) {
                    Ok(()) => self.refresh_codex_account_inner(account_id, false),
                    Err(RuntimeAuthError::Busy) => self
                        .inner
                        .accounts
                        .get(account_id)
                        .map_err(RuntimeAuthError::Account),
                    Err(error) => Err(error),
                };
            }
            // A runtime missing required Codex capabilities is refused before the account check
            // starts. Keep the account unchanged and report the actual capability failure.
            if failure == Some(CodexAccountAuthError::IncompatibleCapabilities) {
                return Err(RuntimeAuthError::Provider(
                    CodexAccountAuthError::IncompatibleCapabilities,
                ));
            }
            let _ = self
                .inner
                .accounts
                .mark_validation_error(account_id, "codex_auth_failed");
            return Err(match failure {
                Some(error) => RuntimeAuthError::Provider(error),
                None if matches!(error, ProviderError::NotInstalled) => {
                    RuntimeAuthError::ProviderUnavailable
                }
                None => RuntimeAuthError::Provider(CodexAccountAuthError::ConnectionEnded),
            });
        }
        self.inner
            .accounts
            .get(account_id)
            .map_err(RuntimeAuthError::Account)
    }

    fn repair_codex_profile_config(&self, account_id: &str) -> Result<(), RuntimeAuthError> {
        let manager = self
            .inner
            .codex_auth
            .as_ref()
            .cloned()
            .ok_or(RuntimeAuthError::ProviderUnavailable)?;
        let recorded_failure = Arc::new(Mutex::new(None));
        let provider_failure = Arc::clone(&recorded_failure);
        let result = self.inner.accounts.authenticate_with_active_account(
            &self.inner.profiles,
            ProviderId::CODEX,
            account_id,
            move |_, lease| {
                manager
                    .repair_profile_config_with_lease(account_id, lease)
                    .map_err(|error| {
                        *provider_failure
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner) = Some(error.clone());
                        ProviderError::Start(error.to_string())
                    })
            },
        );
        match result {
            Ok(()) => Ok(()),
            Err(error) => {
                let failure = recorded_failure
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .clone();
                if failure.is_none() && is_profile_busy(&error) {
                    Err(RuntimeAuthError::Busy)
                } else {
                    Err(RuntimeAuthError::Provider(
                        failure.unwrap_or(CodexAccountAuthError::ProfileUnavailable),
                    ))
                }
            }
        }
    }

    /// Give the real provider launch priority over passive observers for this exact account.
    /// Authentication is enforced by AccountStore's shared launch lease and the provider itself;
    /// missing plan/usage metadata never adds a synchronous network check or a launch requirement.
    ///
    /// The launch cancels the exact background observer and does not wait for its teardown. The
    /// observer is credential-read-only and its shared lease coexists with sessions by design;
    /// sign-in, sign-out and archive writers are still excluded by the profile lease. Teardown
    /// (termination grace, process-tree reap and the guardian's durable quiescence proof) took
    /// seconds under load, and waiting for it refused the user's launch as busy.
    pub fn prepare_account_launch(
        &self,
        provider: &ProviderId,
        account_id: &str,
    ) -> Result<(), ProviderError> {
        self.cancel_account_validation(provider.as_str(), account_id);
        Ok(())
    }

    /// Resolver used by the interactive Codex adapter after `prepare_account_launch` and while
    /// the outer shared account lease is held.
    pub fn codex_cloud_config(
        &self,
        account_id: &str,
    ) -> Result<CloudConfigEligibility, ProviderError> {
        Ok(self
            .cached_codex_eligibility(account_id)
            .unwrap_or(CloudConfigEligibility::Unknown))
    }

    pub fn managed_headless_provider(
        &self,
        provider: &ProviderId,
        account_id: &str,
    ) -> Result<Arc<dyn AgentProvider>, ProviderError> {
        match provider.as_str() {
            ProviderId::CLAUDE_CODE => Ok(Arc::new(
                ClaudeCodeProvider::new(self.inner.source_env.clone())
                    .with_managed_profiles(self.managed_profiles()),
            )),
            ProviderId::CODEX => Ok(Arc::new(CodexProvider::new_managed(
                self.inner.source_env.clone(),
                Arc::clone(&self.inner.profiles),
                account_id.to_owned(),
                self.codex_cloud_config(account_id)?,
            )?)),
            ProviderId::GEMINI_CLI => Ok(Arc::new(GeminiProvider::new_managed(
                self.inner.source_env.clone(),
                self.managed_profiles(),
            ))),
            ProviderId::CURSOR => Err(ProviderError::Refused {
                code: "cursor_terminal_required".into(),
                message: "Cursor runs as a coding terminal. Open Code and launch a Cursor agent."
                    .into(),
            }),
            _ => Err(ProviderError::Unsupported),
        }
    }

    fn start_codex_login(
        &self,
        account_id: &str,
    ) -> Result<Arc<PendingCodexLogin>, RuntimeAuthError> {
        let manager = self
            .inner
            .codex_auth
            .as_ref()
            .cloned()
            .ok_or(RuntimeAuthError::ProviderUnavailable)?;
        let operation = self.begin_codex_operation(account_id)?;
        let generation = operation.generation;
        let observer = self.clone();
        let observed_account_id = account_id.to_owned();
        let operation = Arc::new(Mutex::new(Some(operation)));
        let completed_operation = Arc::clone(&operation);
        let provider_failure = Arc::new(Mutex::new(None));
        let recorded_failure = Arc::clone(&provider_failure);
        let result = self.inner.accounts.authenticate_with_active_account(
            &self.inner.profiles,
            ProviderId::CODEX,
            account_id,
            move |_, lease| match manager.start_chatgpt_login_with_lease_observed(
                account_id,
                lease,
                move |result| {
                    let observed = observer.observe_codex(&observed_account_id, generation, result);
                    completed_operation
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .take();
                    observed
                },
            ) {
                Ok(pending) => Ok(Arc::new(pending)),
                Err(error) => {
                    *recorded_failure
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = Some(error.clone());
                    Err(ProviderError::Start(error.to_string()))
                }
            },
        );
        if let Err(error) = &result {
            let failure = provider_failure
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            // The lease was refused before sign-in began, so nothing about the account changed.
            if failure.is_none() && is_profile_busy(error) {
                operation
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
                return Err(RuntimeAuthError::Busy);
            }
            if failure != Some(CodexAccountAuthError::AlreadyConnected) {
                let _ = self
                    .inner
                    .accounts
                    .mark_validation_error(account_id, "codex_auth_failed");
            }
            operation
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            return Err(RuntimeAuthError::Provider(
                failure.unwrap_or(CodexAccountAuthError::StartFailed),
            ));
        }
        result.map_err(|_| RuntimeAuthError::Provider(CodexAccountAuthError::StartFailed))
    }

    fn logout_codex(&self, account_id: &str) -> Result<ProviderAccount, RuntimeAuthError> {
        let manager = self
            .inner
            .codex_auth
            .as_ref()
            .cloned()
            .ok_or(RuntimeAuthError::ProviderUnavailable)?;
        let operation = self.begin_codex_operation(account_id)?;
        let generation = operation.generation;
        let observer = self.clone();
        let result = self.inner.accounts.authenticate_with_active_account(
            &self.inner.profiles,
            ProviderId::CODEX,
            account_id,
            move |_, lease| {
                manager
                    .logout_with_lease_observed(account_id, lease, move |result| {
                        observer.observe_codex(account_id, generation, result)
                    })
                    .map_err(|error| ProviderError::Start(error.to_string()))
            },
        );
        drop(operation);
        if let Err(error) = result {
            if is_profile_busy(&error) {
                return Err(RuntimeAuthError::Busy);
            }
            let _ = self
                .inner
                .accounts
                .mark_validation_error(account_id, "codex_auth_failed");
            return Err(RuntimeAuthError::Provider(
                CodexAccountAuthError::ConnectionEnded,
            ));
        }
        self.inner
            .accounts
            .get(account_id)
            .map_err(RuntimeAuthError::Account)
    }
}

fn codex_auth_manager(
    source_env: &DetectEnv,
    profiles: &Arc<ManagedProfiles>,
) -> Arc<CodexAccountAuthManager> {
    let spec = catalog::codex_spec();
    let executable = source_env
        .resolve_executable_only(&spec)
        .unwrap_or_else(|| PathBuf::from(spec.executable));
    Arc::new(CodexAccountAuthManager::new(
        executable,
        source_env.clone(),
        Arc::clone(profiles),
        env!("KALCODE_PUBLIC_VERSION"),
    ))
}

#[derive(Clone)]
enum PendingProviderLogin {
    Codex(Arc<PendingCodexLogin>),
    Claude(Arc<PendingClaudeLogin>),
    Gemini(Arc<PendingGeminiLogin>),
    #[cfg(test)]
    Synthetic(Arc<SyntheticPendingLogin>),
}

#[cfg(test)]
struct SyntheticPendingLogin {
    provider_id: &'static str,
    cancel_started: Arc<(Mutex<bool>, Condvar)>,
    allow_quiesce: Arc<(Mutex<bool>, Condvar)>,
    lease: Mutex<Option<kalcode_providers::managed::ProfileLease>>,
    failures_remaining: std::sync::atomic::AtomicUsize,
    finished: AtomicBool,
}

#[cfg(test)]
impl SyntheticPendingLogin {
    // `fetch_update` is deprecated as `try_update` on newer stable toolchains, which older
    // supported toolchains lack; keep one spelling that builds on both.
    #[allow(deprecated)]
    fn cancel(&self) -> Result<(), RuntimeAuthError> {
        if self
            .failures_remaining
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            return Err(RuntimeAuthError::Busy);
        }
        let (started, changed) = &*self.cancel_started;
        *started.lock().unwrap_or_else(PoisonError::into_inner) = true;
        changed.notify_all();

        let (allowed, changed) = &*self.allow_quiesce;
        let mut allowed = allowed.lock().unwrap_or_else(PoisonError::into_inner);
        while !*allowed {
            allowed = changed
                .wait(allowed)
                .unwrap_or_else(PoisonError::into_inner);
        }
        drop(allowed);
        self.lease
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        self.finished.store(true, Ordering::Release);
        Ok(())
    }
}

impl PendingProviderLogin {
    fn provider_id(&self) -> &'static str {
        match self {
            Self::Codex(_) => ProviderId::CODEX,
            Self::Claude(_) => ProviderId::CLAUDE_CODE,
            Self::Gemini(_) => ProviderId::GEMINI_CLI,
            #[cfg(test)]
            Self::Synthetic(pending) => pending.provider_id,
        }
    }

    fn is_finished(&self) -> bool {
        match self {
            Self::Codex(pending) => pending.is_finished(),
            Self::Claude(pending) => pending.is_finished(),
            Self::Gemini(pending) => pending.is_finished(),
            #[cfg(test)]
            Self::Synthetic(pending) => pending.finished.load(Ordering::Acquire),
        }
    }

    fn same_instance(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Codex(left), Self::Codex(right)) => Arc::ptr_eq(left, right),
            (Self::Claude(left), Self::Claude(right)) => Arc::ptr_eq(left, right),
            (Self::Gemini(left), Self::Gemini(right)) => Arc::ptr_eq(left, right),
            #[cfg(test)]
            (Self::Synthetic(left), Self::Synthetic(right)) => Arc::ptr_eq(left, right),
            _ => false,
        }
    }

    fn wait(&self) -> Result<(), RuntimeAuthError> {
        match self {
            Self::Codex(pending) => pending
                .wait()
                .map(|_| ())
                .map_err(RuntimeAuthError::Provider),
            Self::Claude(pending) => pending.wait().map(|_| ()).map_err(RuntimeAuthError::Claude),
            Self::Gemini(pending) => pending.wait().map(|_| ()).map_err(RuntimeAuthError::Gemini),
            #[cfg(test)]
            Self::Synthetic(_) => Ok(()),
        }
    }

    fn cancel(&self) -> Result<(), RuntimeAuthError> {
        match self {
            Self::Codex(pending) => pending.cancel().map_err(RuntimeAuthError::Provider),
            Self::Claude(pending) => pending.cancel().map_err(RuntimeAuthError::Claude),
            Self::Gemini(pending) => pending.cancel().map_err(RuntimeAuthError::Gemini),
            #[cfg(test)]
            Self::Synthetic(pending) => pending.cancel(),
        }
    }
}

enum PendingLoginEntry {
    Starting {
        account_id: String,
    },
    Active {
        account_id: String,
        pending: PendingProviderLogin,
    },
}

/// Managed-provider authentication command state. Runtime consumers receive only the authority
/// clone; browser login handles stay private to this IPC owner.
pub struct ProviderAuthState {
    runtime: Option<ProviderRuntimeAuthority>,
    pending: Arc<Mutex<HashMap<String, PendingLoginEntry>>>,
    starting: Arc<(Mutex<usize>, Condvar)>,
    shutting_down: Arc<AtomicBool>,
}

struct LoginStartReservation {
    handle: String,
    pending: Arc<Mutex<HashMap<String, PendingLoginEntry>>>,
    starting: Arc<(Mutex<usize>, Condvar)>,
    shutting_down: Arc<AtomicBool>,
    active: bool,
}

impl LoginStartReservation {
    fn activate(&mut self, login: PendingProviderLogin) -> bool {
        if self.shutting_down.load(Ordering::Acquire) {
            return false;
        }
        let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        if self.shutting_down.load(Ordering::Acquire) {
            return false;
        }
        let Some(PendingLoginEntry::Starting { account_id }) = pending.remove(&self.handle) else {
            return false;
        };
        pending.insert(
            self.handle.clone(),
            PendingLoginEntry::Active {
                account_id,
                pending: login,
            },
        );
        drop(pending);
        self.finish_starting();
        true
    }

    fn finish_starting(&mut self) {
        if !self.active {
            return;
        }
        self.active = false;
        let (count, changed) = &*self.starting;
        let mut count = count.lock().unwrap_or_else(PoisonError::into_inner);
        *count = count.saturating_sub(1);
        changed.notify_all();
    }
}

impl Drop for LoginStartReservation {
    fn drop(&mut self) {
        if self.active {
            self.pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&self.handle);
            self.finish_starting();
        }
    }
}

impl ProviderAuthState {
    pub fn start(app: &AppState) -> Result<Self, String> {
        let core = app
            .core
            .as_ref()
            .cloned()
            .ok_or_else(|| "core_unavailable".to_owned())?;
        let runtime = ProviderRuntimeAuthority::start(core, &app.paths.data_dir)?;
        #[cfg(feature = "e2e")]
        runtime.seed_e2e_fixture(&app.paths.data_dir)?;
        Ok(Self {
            runtime: Some(runtime),
            pending: Arc::new(Mutex::new(HashMap::new())),
            starting: Arc::new((Mutex::new(0), Condvar::new())),
            shutting_down: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn unavailable() -> Self {
        Self {
            runtime: None,
            pending: Arc::new(Mutex::new(HashMap::new())),
            starting: Arc::new((Mutex::new(0), Condvar::new())),
            shutting_down: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn runtime_authority(&self) -> Option<ProviderRuntimeAuthority> {
        self.runtime.clone()
    }

    fn runtime(&self, command: &'static str) -> Result<ProviderRuntimeAuthority, IpcError> {
        self.runtime_authority()
            .ok_or_else(|| RuntimeAuthError::ProviderUnavailable.into_ipc(command))
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<String, PendingLoginEntry>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn reserve_login(&self, account_id: String) -> Result<LoginStartReservation, RuntimeAuthError> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(RuntimeAuthError::Busy);
        }
        let mut pending = self.pending();
        pending.retain(|_, entry| match entry {
            PendingLoginEntry::Starting { .. } => true,
            PendingLoginEntry::Active { pending, .. } => !pending.is_finished(),
        });
        if pending.len() >= MAX_PENDING_LOGINS {
            return Err(RuntimeAuthError::Busy);
        }
        let (starting, _) = &*self.starting;
        let mut starting = starting.lock().unwrap_or_else(PoisonError::into_inner);
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(RuntimeAuthError::Busy);
        }
        let handle = kalcode_contracts::ids::new_id();
        pending.insert(handle.clone(), PendingLoginEntry::Starting { account_id });
        *starting = starting.saturating_add(1);
        drop(pending);
        drop(starting);
        Ok(LoginStartReservation {
            handle,
            pending: Arc::clone(&self.pending),
            starting: Arc::clone(&self.starting),
            shutting_down: Arc::clone(&self.shutting_down),
            active: true,
        })
    }

    /// Stops accepting authentication work and asks every active login to quiesce without holding
    /// the map lock. Failed or timed-out cancellations remain tracked so a later shutdown cannot
    /// falsely report success while a provider process or exclusive profile lease is still live.
    pub fn shutdown(&self) -> bool {
        self.shutting_down.store(true, Ordering::Release);
        let deadline = Instant::now() + AUTH_SHUTDOWN_TIMEOUT;
        let active: Vec<(String, PendingProviderLogin)> = {
            let pending = self.pending();
            pending
                .iter()
                .filter_map(|(handle, entry)| match entry {
                    PendingLoginEntry::Active { pending, .. } => {
                        Some((handle.clone(), pending.clone()))
                    }
                    PendingLoginEntry::Starting { .. } => None,
                })
                .collect()
        };
        let results = std::thread::scope(|scope| {
            let handles: Vec<_> = active
                .into_iter()
                .map(|(handle, pending)| {
                    scope.spawn(move || {
                        let result = pending.cancel();
                        (handle, pending, result)
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().ok())
                .collect::<Vec<_>>()
        });
        let mut all_canceled = true;
        for result in results {
            let Some((handle, login, Ok(()))) = result else {
                all_canceled = false;
                continue;
            };
            if !login.is_finished() || !remove_finished_login(&self.pending, &handle, &login) {
                all_canceled = false;
            }
        }
        if !all_canceled || Instant::now() >= deadline {
            return false;
        }

        let (starting, changed) = &*self.starting;
        let mut count = starting.lock().unwrap_or_else(PoisonError::into_inner);
        while *count != 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let waited = changed
                .wait_timeout(count, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            count = waited.0;
            if waited.1.timed_out() && *count != 0 {
                return false;
            }
        }
        self.pending().is_empty()
    }
}

fn remove_finished_login(
    pending_map: &Arc<Mutex<HashMap<String, PendingLoginEntry>>>,
    login_handle: &str,
    login: &PendingProviderLogin,
) -> bool {
    if !login.is_finished() {
        return false;
    }
    let mut entries = pending_map.lock().unwrap_or_else(PoisonError::into_inner);
    match entries.get(login_handle) {
        None => true,
        Some(PendingLoginEntry::Active { pending, .. }) if pending.same_instance(login) => {
            entries.remove(login_handle);
            true
        }
        Some(_) => false,
    }
}

fn cancel_tracked_login_blocking(
    pending_map: &Arc<Mutex<HashMap<String, PendingLoginEntry>>>,
    login_handle: &str,
    provider_id: &str,
) -> Option<Result<(), RuntimeAuthError>> {
    let pending = pending_map
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(login_handle)
        .and_then(|entry| match entry {
            PendingLoginEntry::Active { pending, .. } if pending.provider_id() == provider_id => {
                Some(pending.clone())
            }
            _ => None,
        })?;
    let result = pending.cancel();
    if result.is_ok() {
        let _ = remove_finished_login(pending_map, login_handle, &pending);
    }
    Some(result)
}

async fn cancel_tracked_login(
    state: &ProviderAuthState,
    login_handle: &str,
    provider_id: &'static str,
    command: &'static str,
    unknown_message: &'static str,
) -> Result<(), IpcError> {
    let pending = Arc::clone(&state.pending);
    let handle = login_handle.to_owned();
    let result = tauri::async_runtime::spawn_blocking(move || {
        cancel_tracked_login_blocking(&pending, &handle, provider_id)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "provider_auth_task_failed",
            "The provider account task stopped.",
        )
        .to_ipc()
    })?
    .ok_or_else(|| KalError::validation("provider_login_unknown", unknown_message).to_ipc())?;
    result.map_err(|error| error.into_ipc(command))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLoginStart {
    login_handle: String,
}

#[tauri::command(async)]
pub async fn provider_claude_account_refresh(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    account_id: String,
) -> Result<ProviderAccount, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime("provider_claude_account_refresh")?;
    tauri::async_runtime::spawn_blocking(move || {
        _runtime_access
            .revalidate_core()
            .map_err(RuntimeAuthError::Account)?;
        runtime.refresh_claude_account(&account_id)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "provider_auth_task_failed",
            "The provider account task stopped.",
        )
        .to_ipc()
    })?
    .map_err(|error| error.into_ipc("provider_claude_account_refresh"))
}

#[tauri::command(async)]
pub async fn provider_claude_login_start(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    account_id: String,
) -> Result<ProviderLoginStart, IpcError> {
    _runtime_access.revalidate()?;
    let mut reservation = state
        .reserve_login(account_id.clone())
        .map_err(|error| error.into_ipc("provider_claude_login_start"))?;
    let login_handle = reservation.handle.clone();
    let runtime = state.runtime("provider_claude_login_start")?;
    let pending_result = tauri::async_runtime::spawn_blocking(move || {
        _runtime_access
            .revalidate_core()
            .map_err(RuntimeAuthError::Account)?;
        runtime.start_claude_login(&account_id)
    })
    .await;
    let pending = match pending_result {
        Ok(Ok(pending)) => pending,
        Ok(Err(error)) => return Err(error.into_ipc("provider_claude_login_start")),
        Err(_) => {
            return Err(KalError::internal(
                "provider_auth_task_failed",
                "The provider account task stopped.",
            )
            .to_ipc());
        }
    };
    if !reservation.activate(PendingProviderLogin::Claude(Arc::clone(&pending))) {
        let _ = pending.cancel();
        return Err(KalError::internal(
            "provider_auth_task_failed",
            "The provider account task stopped.",
        )
        .to_ipc());
    }
    Ok(ProviderLoginStart { login_handle })
}

#[tauri::command(async)]
pub async fn provider_claude_login_wait(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    login_handle: String,
) -> Result<ProviderAccount, IpcError> {
    _runtime_access.revalidate()?;
    let (account_id, pending) = state
        .pending()
        .get(&login_handle)
        .and_then(|entry| match entry {
            PendingLoginEntry::Active {
                account_id,
                pending: PendingProviderLogin::Claude(pending),
            } => Some((
                account_id.clone(),
                PendingProviderLogin::Claude(Arc::clone(pending)),
            )),
            _ => None,
        })
        .ok_or_else(|| {
            KalError::validation(
                "provider_login_unknown",
                "That Claude Code sign-in is no longer active.",
            )
            .to_ipc()
        })?;
    let wait_login = pending.clone();
    let result = tauri::async_runtime::spawn_blocking(move || wait_login.wait())
        .await
        .map_err(|_| {
            KalError::internal(
                "provider_auth_task_failed",
                "The provider account task stopped.",
            )
            .to_ipc()
        })?;
    let _ = remove_finished_login(&state.pending, &login_handle, &pending);
    result.map_err(|error| error.into_ipc("provider_claude_login_wait"))?;
    state
        .runtime("provider_claude_login_wait")?
        .account_store()
        .get(&account_id)
        .map_err(|error| error.log_and_convert("provider_claude_login_wait"))
}

#[tauri::command(async)]
pub async fn provider_claude_login_cancel(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    login_handle: String,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    cancel_tracked_login(
        &state,
        &login_handle,
        ProviderId::CLAUDE_CODE,
        "provider_claude_login_cancel",
        "That Claude Code sign-in is no longer active.",
    )
    .await
}

#[tauri::command(async)]
pub async fn provider_claude_logout(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    account_id: String,
) -> Result<ProviderAccount, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime("provider_claude_logout")?;
    tauri::async_runtime::spawn_blocking(move || {
        _runtime_access
            .revalidate_core()
            .map_err(RuntimeAuthError::Account)?;
        runtime.logout_claude(&account_id)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "provider_auth_task_failed",
            "The provider account task stopped.",
        )
        .to_ipc()
    })?
    .map_err(|error| error.into_ipc("provider_claude_logout"))
}

#[tauri::command(async)]
pub async fn provider_account_models(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    account_id: String,
) -> Result<ProviderAccountModelCatalog, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime("provider_account_models")?;
    tauri::async_runtime::spawn_blocking(move || {
        _runtime_access
            .revalidate_core()
            .map_err(RuntimeAuthError::Account)?;
        runtime.account_models(&account_id)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "provider_models_task_failed",
            "The provider model catalog task stopped. Retry.",
        )
        .to_ipc()
    })?
    .map_err(|error| error.into_ipc("provider_account_models"))
}

#[tauri::command(async)]
pub async fn provider_codex_account_refresh(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    account_id: String,
) -> Result<ProviderAccount, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime("provider_codex_account_refresh")?;
    tauri::async_runtime::spawn_blocking(move || {
        _runtime_access
            .revalidate_core()
            .map_err(RuntimeAuthError::Account)?;
        runtime.refresh_codex_account(&account_id)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "provider_auth_task_failed",
            "The provider account task stopped.",
        )
        .to_ipc()
    })?
    .map_err(|error| error.into_ipc("provider_codex_account_refresh"))
}

#[tauri::command(async)]
pub async fn provider_codex_login_start(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    account_id: String,
) -> Result<ProviderLoginStart, IpcError> {
    _runtime_access.revalidate()?;
    let mut reservation = state
        .reserve_login(account_id.clone())
        .map_err(|error| error.into_ipc("provider_codex_login_start"))?;
    let login_handle = reservation.handle.clone();
    let runtime = match state.runtime("provider_codex_login_start") {
        Ok(runtime) => runtime,
        Err(error) => return Err(error),
    };
    let account_for_start = account_id.clone();
    let pending_result = tauri::async_runtime::spawn_blocking(move || {
        _runtime_access
            .revalidate_core()
            .map_err(RuntimeAuthError::Account)?;
        runtime.start_codex_login(&account_for_start)
    })
    .await;
    let pending = match pending_result {
        Ok(Ok(pending)) => pending,
        Ok(Err(error)) => return Err(error.into_ipc("provider_codex_login_start")),
        Err(_) => {
            return Err(KalError::internal(
                "provider_auth_task_failed",
                "The provider account task stopped.",
            )
            .to_ipc());
        }
    };
    if !reservation.activate(PendingProviderLogin::Codex(Arc::clone(&pending))) {
        let _ = pending.cancel();
        return Err(KalError::internal(
            "provider_auth_task_failed",
            "The provider account task stopped.",
        )
        .to_ipc());
    }
    if window
        .opener()
        .open_url(pending.auth_url().as_str(), None::<&str>)
        .is_err()
    {
        let _ = cancel_tracked_login(
            &state,
            &login_handle,
            ProviderId::CODEX,
            "provider_codex_login_start",
            "That provider sign-in is no longer active.",
        )
        .await;
        return Err(KalError::new(
            ErrorCategory::Provider,
            "provider_auth_browser_failed",
            "KalCode couldn't open the official Codex sign-in page in your browser.",
        )
        .log_and_convert("provider_codex_login_start"));
    }
    Ok(ProviderLoginStart { login_handle })
}

#[tauri::command(async)]
pub async fn provider_codex_login_wait(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    login_handle: String,
) -> Result<ProviderAccount, IpcError> {
    _runtime_access.revalidate()?;
    let (account_id, pending) = state
        .pending()
        .get(&login_handle)
        .and_then(|entry| match entry {
            PendingLoginEntry::Active {
                account_id,
                pending: PendingProviderLogin::Codex(pending),
            } => Some((
                account_id.clone(),
                PendingProviderLogin::Codex(Arc::clone(pending)),
            )),
            _ => None,
        })
        .ok_or_else(|| {
            KalError::validation(
                "provider_login_unknown",
                "That provider sign-in is no longer active.",
            )
            .to_ipc()
        })?;
    let wait_login = pending.clone();
    let result = tauri::async_runtime::spawn_blocking(move || wait_login.wait())
        .await
        .map_err(|_| {
            KalError::internal(
                "provider_auth_task_failed",
                "The provider account task stopped.",
            )
            .to_ipc()
        })?;
    let _ = remove_finished_login(&state.pending, &login_handle, &pending);
    result.map_err(|error| error.into_ipc("provider_codex_login_wait"))?;
    state
        .runtime("provider_codex_login_wait")?
        .account_store()
        .get(&account_id)
        .map_err(|error| error.log_and_convert("provider_codex_login_wait"))
}

#[tauri::command(async)]
pub async fn provider_codex_login_cancel(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    login_handle: String,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    cancel_tracked_login(
        &state,
        &login_handle,
        ProviderId::CODEX,
        "provider_codex_login_cancel",
        "That provider sign-in is no longer active.",
    )
    .await
}

#[tauri::command(async)]
pub async fn provider_codex_logout(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    account_id: String,
) -> Result<ProviderAccount, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime("provider_codex_logout")?;
    tauri::async_runtime::spawn_blocking(move || {
        _runtime_access
            .revalidate_core()
            .map_err(RuntimeAuthError::Account)?;
        runtime.logout_codex(&account_id)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "provider_auth_task_failed",
            "The provider account task stopped.",
        )
        .to_ipc()
    })?
    .map_err(|error| error.into_ipc("provider_codex_logout"))
}

/// Records whether this managed Gemini account has Gemini's own cached sign-in (file presence
/// only; KalCode never reads provider credentials).
#[tauri::command(async)]
pub async fn provider_gemini_account_refresh(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    account_id: String,
) -> Result<ProviderAccount, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime("provider_gemini_account_refresh")?;
    tauri::async_runtime::spawn_blocking(move || {
        _runtime_access
            .revalidate_core()
            .map_err(RuntimeAuthError::Account)?;
        runtime.refresh_gemini_account(&account_id)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "provider_auth_task_failed",
            "The provider account task stopped.",
        )
        .to_ipc()
    })?
    .map_err(|error| error.into_ipc("provider_gemini_account_refresh"))
}

/// Starts Gemini CLI's own Google sign-in for one managed account. Gemini opens the official
/// page in the system browser itself; the URL and all provider output stay native.
#[tauri::command(async)]
pub async fn provider_gemini_login_start(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    account_id: String,
) -> Result<ProviderLoginStart, IpcError> {
    _runtime_access.revalidate()?;
    let mut reservation = state
        .reserve_login(account_id.clone())
        .map_err(|error| error.into_ipc("provider_gemini_login_start"))?;
    let login_handle = reservation.handle.clone();
    let runtime = state.runtime("provider_gemini_login_start")?;
    let pending_result = tauri::async_runtime::spawn_blocking(move || {
        _runtime_access
            .revalidate_core()
            .map_err(RuntimeAuthError::Account)?;
        runtime.start_gemini_login(&account_id)
    })
    .await;
    let pending = match pending_result {
        Ok(Ok(pending)) => pending,
        Ok(Err(error)) => return Err(error.into_ipc("provider_gemini_login_start")),
        Err(_) => {
            return Err(KalError::internal(
                "provider_auth_task_failed",
                "The provider account task stopped.",
            )
            .to_ipc());
        }
    };
    if !reservation.activate(PendingProviderLogin::Gemini(Arc::clone(&pending))) {
        let _ = pending.cancel();
        return Err(KalError::internal(
            "provider_auth_task_failed",
            "The provider account task stopped.",
        )
        .to_ipc());
    }
    Ok(ProviderLoginStart { login_handle })
}

#[tauri::command(async)]
pub async fn provider_gemini_login_wait(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    login_handle: String,
) -> Result<ProviderAccount, IpcError> {
    _runtime_access.revalidate()?;
    let (account_id, pending) = state
        .pending()
        .get(&login_handle)
        .and_then(|entry| match entry {
            PendingLoginEntry::Active {
                account_id,
                pending: PendingProviderLogin::Gemini(pending),
            } => Some((
                account_id.clone(),
                PendingProviderLogin::Gemini(Arc::clone(pending)),
            )),
            _ => None,
        })
        .ok_or_else(|| {
            KalError::validation(
                "provider_login_unknown",
                "That Gemini sign-in is no longer active.",
            )
            .to_ipc()
        })?;
    let wait_login = pending.clone();
    let result = tauri::async_runtime::spawn_blocking(move || wait_login.wait())
        .await
        .map_err(|_| {
            KalError::internal(
                "provider_auth_task_failed",
                "The provider account task stopped.",
            )
            .to_ipc()
        })?;
    let _ = remove_finished_login(&state.pending, &login_handle, &pending);
    result.map_err(|error| error.into_ipc("provider_gemini_login_wait"))?;
    state
        .runtime("provider_gemini_login_wait")?
        .account_store()
        .get(&account_id)
        .map_err(|error| error.log_and_convert("provider_gemini_login_wait"))
}

#[tauri::command(async)]
pub async fn provider_gemini_login_cancel(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    login_handle: String,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    cancel_tracked_login(
        &state,
        &login_handle,
        ProviderId::GEMINI_CLI,
        "provider_gemini_login_cancel",
        "That Gemini sign-in is no longer active.",
    )
    .await
}

/// Signs one managed Gemini account out by removing only Gemini's own credential files in that
/// account's profile, under the account's exclusive lease.
#[tauri::command(async)]
pub async fn provider_gemini_logout(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    account_id: String,
) -> Result<ProviderAccount, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime("provider_gemini_logout")?;
    tauri::async_runtime::spawn_blocking(move || {
        _runtime_access
            .revalidate_core()
            .map_err(RuntimeAuthError::Account)?;
        runtime.logout_gemini(&account_id)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "provider_auth_task_failed",
            "The provider account task stopped.",
        )
        .to_ipc()
    })?
    .map_err(|error| error.into_ipc("provider_gemini_logout"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_core::flags::BuildChannel;
    use kalcode_core::{Core, CoreConfig, Paths};

    #[cfg(any(windows, target_os = "macos"))]
    struct Fixture {
        _temp: tempfile::TempDir,
        core: Arc<Core>,
        runtime: ProviderRuntimeAuthority,
        account: ProviderAccount,
    }

    #[cfg(any(windows, target_os = "macos"))]
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().expect("temp");
            let temp_root = if cfg!(target_os = "macos") {
                temp.path().canonicalize().expect("canonical temp")
            } else {
                temp.path().to_path_buf()
            };
            let core = Arc::new(
                Core::open(CoreConfig {
                    paths: Paths::new(&temp_root),
                    app_version: "0.0.0-test".into(),
                    channel: BuildChannel::Development,
                })
                .expect("core"),
            );
            let test_executable = std::env::current_exe().expect("test executable");
            let helper = test_executable
                .parent()
                .and_then(|deps| deps.parent())
                .expect("Cargo target directory")
                .join(if cfg!(windows) {
                    "kalcode-provider-guardian.exe"
                } else {
                    "kalcode-provider-guardian"
                });
            let runtime =
                ProviderRuntimeAuthority::start_with_helper(core.clone(), &temp_root, &helper)
                    .expect("runtime authority");
            let account = runtime
                .account_store()
                .create(ProviderId::CODEX, "Personal")
                .expect("account");
            Self {
                _temp: temp,
                core,
                runtime,
                account,
            }
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.core.shutdown();
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn isolated_codex_env(search_dir: Option<&std::path::Path>) -> DetectEnv {
        let mut env = DetectEnv::from_process();
        env.vars.retain(|(key, _)| {
            !key.to_string_lossy().eq_ignore_ascii_case("PATH")
                && !key.to_string_lossy().eq_ignore_ascii_case("APPDATA")
                && !key.to_string_lossy().eq_ignore_ascii_case("LOCALAPPDATA")
                && !key.to_string_lossy().eq_ignore_ascii_case("HOME")
                && !key.to_string_lossy().eq_ignore_ascii_case("USERPROFILE")
        });
        if let Some(search_dir) = search_dir {
            let search_dirs = vec![search_dir.to_path_buf()];
            #[cfg(target_os = "macos")]
            let search_dirs = search_dirs
                .into_iter()
                .chain([PathBuf::from("/usr/bin"), PathBuf::from("/bin")])
                .collect::<Vec<_>>();
            env.vars.push((
                "PATH".into(),
                std::env::join_paths(search_dirs).expect("isolated provider path"),
            ));
        }
        env.system_root = Some(
            search_dir
                .unwrap_or_else(|| std::path::Path::new("."))
                .to_path_buf(),
        );
        env
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn codex_auth_manager_exists_when_codex_is_installed_after_startup() {
        let temp = tempfile::tempdir().expect("temp");
        let profiles =
            Arc::new(ManagedProfiles::new(temp.path().join("profiles")).expect("managed profiles"));
        let env = isolated_codex_env(None);

        assert!(
            env.resolve_executable_only(&catalog::codex_spec())
                .is_none()
        );
        let manager = codex_auth_manager(&env, &profiles);
        assert_eq!(Arc::strong_count(&manager), 1);
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn gemini_credentials(
        runtime: &ProviderRuntimeAuthority,
        account_id: &str,
    ) -> std::path::PathBuf {
        runtime
            .managed_profiles()
            .profile_home(ProviderId::GEMINI_CLI, account_id)
            .expect("profile home")
            .join(".gemini")
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn gemini_account_state_is_known_from_its_own_managed_profile_only() {
        let fixture = Fixture::new();
        let store = fixture.runtime.account_store();
        let personal = store
            .create(ProviderId::GEMINI_CLI, "Personal")
            .expect("gemini account");
        let work = store
            .create(ProviderId::GEMINI_CLI, "Work")
            .expect("second gemini account");

        let refreshed = fixture
            .runtime
            .refresh_gemini_account(&personal.id)
            .expect("refresh without Gemini installed");
        assert_eq!(refreshed.authentication_state, AuthState::NotAuthenticated);
        assert_eq!(refreshed.last_error_code, None);

        let directory = gemini_credentials(&fixture.runtime, &personal.id);
        std::fs::create_dir_all(&directory).expect("gemini dir");
        std::fs::write(directory.join("gemini-credentials.json"), b"opaque")
            .expect("synthetic encrypted sign-in");
        assert_eq!(
            fixture
                .runtime
                .refresh_gemini_account(&personal.id)
                .expect("refresh")
                .authentication_state,
            AuthState::Authenticated
        );
        assert_eq!(
            fixture
                .runtime
                .refresh_gemini_account(&work.id)
                .expect("refresh other")
                .authentication_state,
            AuthState::NotAuthenticated,
            "one account's sign-in never counts for another"
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn gemini_sign_out_removes_only_that_accounts_credentials_under_its_lease() {
        let fixture = Fixture::new();
        let store = fixture.runtime.account_store();
        let personal = store
            .create(ProviderId::GEMINI_CLI, "Personal")
            .expect("gemini account");
        let work = store
            .create(ProviderId::GEMINI_CLI, "Work")
            .expect("second gemini account");
        for account in [&personal, &work] {
            let directory = gemini_credentials(&fixture.runtime, &account.id);
            std::fs::create_dir_all(&directory).expect("gemini dir");
            std::fs::write(directory.join("gemini-credentials.json"), b"opaque").expect("sign-in");
            std::fs::write(directory.join("settings.json"), b"{}").expect("settings");
        }

        let session = fixture
            .runtime
            .managed_profiles()
            .acquire_session_lease(ProviderId::GEMINI_CLI, &personal.id)
            .expect("running session");
        assert!(
            matches!(
                fixture.runtime.logout_gemini(&personal.id),
                Err(RuntimeAuthError::Busy)
            ),
            "sign-out waits for sessions using the profile"
        );
        drop(session);

        let signed_out = fixture
            .runtime
            .logout_gemini(&personal.id)
            .expect("sign out without Gemini installed");
        assert_eq!(signed_out.authentication_state, AuthState::NotAuthenticated);
        let mine = gemini_credentials(&fixture.runtime, &personal.id);
        assert!(!mine.join("gemini-credentials.json").exists());
        assert!(mine.join("settings.json").exists());
        assert!(
            gemini_credentials(&fixture.runtime, &work.id)
                .join("gemini-credentials.json")
                .exists(),
            "another account's sign-in is untouched"
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn gemini_identity_is_recorded_per_account_and_cleared_on_sign_out() {
        let fixture = Fixture::new();
        let store = fixture.runtime.account_store();
        let personal = store
            .create(ProviderId::GEMINI_CLI, "Personal")
            .expect("gemini account");
        let work = store
            .create(ProviderId::GEMINI_CLI, "Work")
            .expect("second gemini account");
        for (account, email) in [
            (&personal, "personal@example.com"),
            (&work, "work@example.com"),
        ] {
            let directory = gemini_credentials(&fixture.runtime, &account.id);
            std::fs::create_dir_all(&directory).expect("gemini dir");
            std::fs::write(directory.join("gemini-credentials.json"), b"opaque").expect("sign-in");
            std::fs::write(
                directory.join("google_accounts.json"),
                format!(r#"{{"active":"{email}","old":["former@example.com"]}}"#),
            )
            .expect("google accounts");
        }

        let refreshed = fixture
            .runtime
            .refresh_gemini_account(&personal.id)
            .expect("refresh");
        assert_eq!(refreshed.authentication_state, AuthState::Authenticated);
        assert_eq!(
            refreshed.provider_reported_identity.as_deref(),
            Some("personal@example.com")
        );
        assert_eq!(
            fixture
                .runtime
                .refresh_gemini_account(&work.id)
                .expect("refresh other")
                .provider_reported_identity
                .as_deref(),
            Some("work@example.com"),
            "each account reports only its own Google account"
        );

        let signed_out = fixture
            .runtime
            .logout_gemini(&personal.id)
            .expect("sign out");
        assert_eq!(signed_out.authentication_state, AuthState::NotAuthenticated);
        assert_eq!(signed_out.provider_reported_identity, None);
        assert_eq!(
            store
                .get(&work.id)
                .expect("work")
                .provider_reported_identity
                .as_deref(),
            Some("work@example.com")
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn gemini_sign_in_is_refused_for_another_providers_account() {
        let fixture = Fixture::new();
        // The fixture account is a Codex account: a Gemini operation must never touch it.
        let before = fixture
            .runtime
            .account_store()
            .get(&fixture.account.id)
            .expect("codex account");
        assert!(
            fixture
                .runtime
                .refresh_gemini_account(&fixture.account.id)
                .is_err()
        );
        assert!(fixture.runtime.logout_gemini(&fixture.account.id).is_err());
        let after = fixture
            .runtime
            .account_store()
            .get(&fixture.account.id)
            .expect("codex account");
        assert_eq!(after.authentication_state, before.authentication_state);
        assert_eq!(after.last_error_code, before.last_error_code);
    }

    #[test]
    fn gemini_auth_errors_are_actionable_and_credential_free() {
        for (error, code) in [
            (
                RuntimeAuthError::GeminiUnavailable,
                "provider_auth_unavailable",
            ),
            (
                RuntimeAuthError::Gemini(GeminiAccountAuthError::AccountNotConfirmed),
                "provider_login_not_confirmed",
            ),
            (
                RuntimeAuthError::Gemini(GeminiAccountAuthError::UnsupportedVersion),
                "provider_version_unsupported",
            ),
            (
                RuntimeAuthError::Gemini(GeminiAccountAuthError::Canceled),
                "provider_login_canceled",
            ),
        ] {
            let ipc = error.into_ipc("provider_gemini_login_start");
            assert_eq!(ipc.code, code);
            assert!(ipc.message.contains("Gemini"), "{}", ipc.message);
        }
    }

    #[test]
    fn claude_auth_errors_surface_a_specific_credential_free_reason_code() {
        for (error, code, detail) in [
            (
                ClaudeAccountAuthError::UnsupportedVersion {
                    found: Some("2.2.0".into()),
                },
                "provider_version_unsupported",
                "(reason: provider_version_unsupported)",
            ),
            (
                ClaudeAccountAuthError::StartFailed,
                "provider_auth_failed",
                "(reason: spawn_failed)",
            ),
            (
                ClaudeAccountAuthError::ProfileUnavailable,
                "provider_auth_failed",
                "(reason: account_profile_invalid)",
            ),
            (
                ClaudeAccountAuthError::BrowserHandoffFailed { exit_code: Some(3) },
                "provider_auth_failed",
                "(reason: browser_handoff_failed, exit 3)",
            ),
            (
                ClaudeAccountAuthError::LoginExited { exit_code: Some(1) },
                "provider_auth_failed",
                "(reason: auth_process_exited, exit 1)",
            ),
            (
                ClaudeAccountAuthError::TimedOut,
                "provider_auth_failed",
                "(reason: auth_process_timeout)",
            ),
            (
                ClaudeAccountAuthError::StatusRefreshFailed,
                "provider_auth_failed",
                "(reason: auth_status_refresh_failed)",
            ),
            (
                ClaudeAccountAuthError::UnsupportedAuthCommand,
                "provider_auth_failed",
                "(reason: unsupported_auth_command)",
            ),
            (
                ClaudeAccountAuthError::Canceled,
                "provider_login_canceled",
                "Claude Code sign-in was canceled.",
            ),
        ] {
            let ipc = RuntimeAuthError::Claude(error).into_ipc("provider_claude_login_start");
            assert_eq!(ipc.code, code);
            assert!(ipc.message.contains("Claude Code"), "{}", ipc.message);
            assert!(ipc.message.contains(detail), "{}", ipc.message);
        }
        let version = RuntimeAuthError::Claude(ClaudeAccountAuthError::UnsupportedVersion {
            found: Some("2.2.0".into()),
        })
        .into_ipc("provider_claude_login_start");
        assert!(
            version.message.contains("2.1.282 or a later 2.1.x release")
                && version.message.contains("this computer has 2.2.0"),
            "the supported and found versions are named: {}",
            version.message
        );
    }

    #[test]
    fn codex_version_drift_is_not_presented_as_a_supported_minor_window() {
        let ipc = RuntimeAuthError::Provider(CodexAccountAuthError::IncompatibleCapabilities)
            .into_ipc("provider_codex_login_start");

        assert_eq!(ipc.code, "provider_capability_unavailable");
        assert!(
            ipc.message.contains("required capabilities"),
            "{}",
            ipc.message
        );
        assert!(
            ipc.message.contains("no compatible runtime"),
            "{}",
            ipc.message
        );
        assert!(!ipc.message.contains("0.160"), "{}", ipc.message);
        assert!(
            !ipc.message.contains("supported version"),
            "{}",
            ipc.message
        );
        assert!(!ipc.message.contains("npm install"), "{}", ipc.message);
    }

    #[test]
    fn gemini_version_refusal_keeps_its_certified_window_and_install_command() {
        let window = &kalcode_providers::gemini::MANAGED_VERSIONS;
        let ipc = RuntimeAuthError::Gemini(GeminiAccountAuthError::UnsupportedVersion)
            .into_ipc("provider_gemini_login_start");

        assert_eq!(ipc.code, "provider_version_unsupported");
        assert!(
            ipc.message.starts_with(&format!(
                "Managed {} accounts need {} {}",
                window.profile_name,
                window.cli_name,
                window.supported_range()
            )),
            "{}",
            ipc.message
        );
        let command = window.install_command().expect("install command");
        assert!(
            ipc.message.contains(&format!("`{command}`")),
            "{}",
            ipc.message
        );
        assert!(
            ipc.message
                .ends_with("(reason: provider_version_unsupported)"),
            "{}",
            ipc.message
        );
        let gemini = RuntimeAuthError::Gemini(GeminiAccountAuthError::UnsupportedVersion)
            .into_ipc("provider_gemini_login_start");
        assert!(
            gemini.message.contains("0.61.x"),
            "the certified line, not one exact release: {}",
            gemini.message
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn connected(plan: &str) -> Result<CodexAccountState, CodexAccountAuthError> {
        Ok(CodexAccountState {
            account: Some(kalcode_providers::account_auth::CodexChatGptAccount {
                email: Some("person@example.test".into()),
                plan_type: plan.into(),
            }),
            requires_openai_auth: true,
        })
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    #[test]
    fn runtime_authority_fails_closed_without_a_native_guardian() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("temp");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(temp.path()),
                app_version: "0.0.0-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let helper = temp.path().join("guardian-probe");
        let marker = temp.path().join("guardian-probe.ran");
        std::fs::write(&helper, "#!/bin/sh\n: > \"$0.ran\"\nexit 0\n").expect("helper");
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700))
            .expect("helper permissions");

        let result =
            ProviderRuntimeAuthority::start_with_helper(Arc::clone(&core), temp.path(), &helper);
        let helper_started = marker.exists();
        core.shutdown();

        let error = match result {
            Ok(_) => panic!("desktop runtime authority must reject an unsupported guardian"),
            Err(error) => error,
        };
        assert_eq!(error, "provider_guardian_unavailable");
        assert!(
            !helper_started,
            "unsupported-host denial must happen before the helper starts"
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn codex_plan_metadata_is_generation_bound_but_never_authorizes_a_session() {
        let fixture = Fixture::new();
        let first = fixture
            .runtime
            .begin_codex_operation(&fixture.account.id)
            .expect("first operation");
        fixture
            .runtime
            .observe_codex(&fixture.account.id, first.generation, &connected("pro"))
            .expect("observe consumer");
        drop(first);
        assert_eq!(
            fixture
                .runtime
                .cached_codex_eligibility(&fixture.account.id)
                .expect("fresh consumer"),
            CloudConfigEligibility::Ineligible
        );

        let second = fixture
            .runtime
            .begin_codex_operation(&fixture.account.id)
            .expect("second operation");
        assert!(
            fixture
                .runtime
                .cached_codex_eligibility(&fixture.account.id)
                .is_none(),
            "a new provider refresh invalidates the old positive proof immediately"
        );
        fixture
            .runtime
            .observe_codex(
                &fixture.account.id,
                second.generation,
                &connected("business"),
            )
            .expect("observe organization plan");
        drop(second);
        // Organization plans launch like any other (native provider parity).
        fixture
            .runtime
            .prepare_account_launch(&ProviderId::new(ProviderId::CODEX), &fixture.account.id)
            .expect("organization plan launches");

        fixture
            .runtime
            .inner
            .codex_truth
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .cache
            .get_mut(&fixture.account.id)
            .expect("cached plan")
            .checked_at = Instant::now() - CODEX_TRUTH_TTL - Duration::from_secs(1);
        assert!(
            fixture
                .runtime
                .cached_codex_eligibility(&fixture.account.id)
                .is_none(),
            "expired metadata is unknown"
        );
        fixture
            .runtime
            .prepare_account_launch(&ProviderId::new(ProviderId::CODEX), &fixture.account.id)
            .expect("expired plan metadata does not block the provider session");
        assert_eq!(
            fixture
                .runtime
                .codex_cloud_config(&fixture.account.id)
                .unwrap(),
            CloudConfigEligibility::Unknown
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn account_operations_are_single_flight_and_stale_observers_cannot_publish() {
        let fixture = Fixture::new();
        let first = fixture
            .runtime
            .begin_codex_operation(&fixture.account.id)
            .expect("first");
        assert!(matches!(
            fixture.runtime.begin_codex_operation(&fixture.account.id),
            Err(RuntimeAuthError::Busy)
        ));
        let stale_generation = first.generation;
        drop(first);

        let current = fixture
            .runtime
            .begin_codex_operation(&fixture.account.id)
            .expect("current");
        assert_eq!(
            fixture
                .runtime
                .observe_codex(&fixture.account.id, stale_generation, &connected("pro"))
                .expect_err("stale observer"),
            CodexAccountAuthError::StateUpdateFailed
        );
        assert!(
            fixture
                .runtime
                .cached_codex_eligibility(&fixture.account.id)
                .is_none()
        );
        fixture
            .runtime
            .observe_codex(&fixture.account.id, current.generation, &connected("pro"))
            .expect("current observer");
        drop(current);
        assert_eq!(
            fixture
                .runtime
                .managed_headless_provider(
                    &ProviderId::new(ProviderId::CODEX),
                    &fixture.account.id,
                )
                .expect("managed provider")
                .id()
                .as_str(),
            ProviderId::CODEX
        );
    }

    /// Installs Codex and Claude account managers whose executable doesn't exist. A busy profile
    /// refuses at the exclusive lease before any process could start, and an operation that does
    /// get the lease fails without running anything.
    #[cfg(any(windows, target_os = "macos"))]
    fn install_unrunnable_auth_managers(fixture: &mut Fixture) {
        let missing = fixture._temp.path().join("missing-provider-cli");
        let inner = Arc::get_mut(&mut fixture.runtime.inner).expect("sole runtime owner");
        inner.codex_auth = Some(Arc::new(CodexAccountAuthManager::new(
            missing.clone(),
            isolated_codex_env(None),
            Arc::clone(&inner.profiles),
            env!("KALCODE_PUBLIC_VERSION"),
        )));
        inner.claude_auth = Some(Arc::new(ClaudeAccountAuthManager::new(
            missing,
            inner.source_env.clone(),
            Arc::clone(&inner.profiles),
        )));
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn observe_codex_plan(
        fixture: &Fixture,
        state: &Result<CodexAccountState, CodexAccountAuthError>,
    ) {
        let operation = fixture
            .runtime
            .begin_codex_operation(&fixture.account.id)
            .expect("operation");
        fixture
            .runtime
            .observe_codex(&fixture.account.id, operation.generation, state)
            .expect("observe");
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn foreground_preemption_cancels_only_the_exact_background_validation() {
        let fixture = Fixture::new();
        let other = fixture
            .runtime
            .account_store()
            .create(ProviderId::CODEX, "Other")
            .expect("other account");
        let validation = fixture
            .runtime
            .begin_account_validation(ProviderId::CODEX, &fixture.account.id)
            .expect("validation");
        let cancellation = validation.cancellation();
        let other_validation = fixture
            .runtime
            .begin_account_validation(ProviderId::CODEX, &other.id)
            .expect("other validation");
        let other_cancellation = other_validation.cancellation();
        // Hang guards, not latency budgets: on a loaded gate machine the observer thread can wait
        // well over 250 ms to be scheduled (gate 37499865413). `preempt_account_validation`
        // returns false on timeout, so `true` already proves the exact validation was cancelled
        // and released before the deadline.
        let observer = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            while !cancellation.load(Ordering::Acquire) && Instant::now() < deadline {
                std::thread::yield_now();
            }
            assert!(cancellation.load(Ordering::Acquire));
            drop(validation);
        });

        assert!(fixture.runtime.preempt_account_validation(
            ProviderId::CODEX,
            &fixture.account.id,
            Duration::from_secs(30)
        ));
        observer.join().expect("observer exits");
        assert!(!other_cancellation.load(Ordering::Acquire));
        drop(other_validation);
        let _next = fixture
            .runtime
            .begin_account_validation(ProviderId::CODEX, &fixture.account.id)
            .expect("exact validation registry released");
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn account_model_catalog_waits_for_the_exact_validation_then_acquires_it() {
        let mut fixture = Fixture::new();
        install_read_only_codex_app_server(&mut fixture, "pro", false, false);
        let validation = fixture
            .runtime
            .begin_account_validation(ProviderId::CODEX, &fixture.account.id)
            .expect("startup validation");
        let cancellation = validation.cancellation();
        let runtime = fixture.runtime.clone();
        let account_id = fixture.account.id.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(0);
        let (result_tx, result_rx) = std::sync::mpsc::sync_channel(0);
        let catalog = std::thread::spawn(move || {
            entered_tx.send(()).expect("catalog entered");
            result_tx
                .send(runtime.account_models(&account_id))
                .expect("catalog result received");
        });

        // Hang guards only: a loaded gate can delay the thread start and the cold
        // cmd -> PowerShell fake provider well past their usual sub-second times.
        entered_rx
            .recv_timeout(Duration::from_secs(30))
            .expect("catalog entered");
        assert!(
            result_rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "catalog discovery must wait instead of surfacing a transient busy error"
        );
        assert!(
            !cancellation.load(Ordering::Acquire),
            "catalog discovery must not cancel the startup refresh"
        );

        drop(validation);
        let result = result_rx
            .recv_timeout(Duration::from_secs(120))
            .expect("catalog resumes after validation release")
            .expect("catalog succeeds");
        assert_eq!(result.models[0].id, "codex-test-exact");
        catalog.join().expect("catalog joins");
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn account_model_catalog_timeout_never_cancels_the_incumbent_validation() {
        let fixture = Fixture::new();
        let validation = fixture
            .runtime
            .begin_account_validation(ProviderId::CODEX, &fixture.account.id)
            .expect("startup validation");
        let cancellation = validation.cancellation();

        assert!(matches!(
            fixture.runtime.begin_account_catalog_validation(
                ProviderId::CODEX,
                &fixture.account.id,
                Duration::from_millis(25),
            ),
            Err(RuntimeAuthError::Busy)
        ));
        assert!(
            !cancellation.load(Ordering::Acquire),
            "a catalog timeout must leave the foreground validation untouched"
        );
        assert!(matches!(
            fixture
                .runtime
                .begin_account_validation(ProviderId::CODEX, &fixture.account.id),
            Err(RuntimeAuthError::Busy)
        ));
        drop(validation);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn account_model_catalog_validation_does_not_wait_for_another_account() {
        let fixture = Fixture::new();
        let other = fixture
            .runtime
            .account_store()
            .create(ProviderId::CODEX, "Other")
            .expect("other account");
        let validation = fixture
            .runtime
            .begin_account_validation(ProviderId::CODEX, &fixture.account.id)
            .expect("startup validation");
        let cancellation = validation.cancellation();

        let catalog = fixture
            .runtime
            .begin_account_catalog_validation(ProviderId::CODEX, &other.id, Duration::ZERO)
            .expect("another account claims its independent slot immediately");
        assert!(!cancellation.load(Ordering::Acquire));
        assert!(!catalog.cancellation().load(Ordering::Acquire));
        drop(catalog);
        drop(validation);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn same_account_catalog_validations_serialize_without_overlap() {
        let fixture = Fixture::new();
        let first = fixture
            .runtime
            .begin_account_catalog_validation(
                ProviderId::CODEX,
                &fixture.account.id,
                Duration::ZERO,
            )
            .expect("first catalog validation");
        let runtime = fixture.runtime.clone();
        let account_id = fixture.account.id.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(0);
        let (acquired_tx, acquired_rx) = std::sync::mpsc::sync_channel(0);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
        let second = std::thread::spawn(move || {
            entered_tx.send(()).expect("second entered");
            let validation = runtime
                .begin_account_catalog_validation(
                    ProviderId::CODEX,
                    &account_id,
                    Duration::from_secs(2),
                )
                .expect("second catalog validation");
            acquired_tx.send(()).expect("second acquired");
            release_rx.recv().expect("second released");
            drop(validation);
        });

        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("second entered");
        assert!(
            acquired_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err(),
            "the second catalog validation cannot overlap the first"
        );
        drop(first);
        acquired_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("second acquires after first releases");
        assert!(matches!(
            fixture
                .runtime
                .begin_account_validation(ProviderId::CODEX, &fixture.account.id),
            Err(RuntimeAuthError::Busy)
        ));
        release_tx.send(()).expect("release second");
        second.join().expect("second joins");
        let _released = fixture
            .runtime
            .begin_account_validation(ProviderId::CODEX, &fixture.account.id)
            .expect("second released exact account slot");
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn launch_preempts_a_delayed_background_observer_without_false_sign_out() {
        let mut fixture = Fixture::new();
        let marker = install_read_only_codex_app_server(&mut fixture, "pro", true, false);
        let store = fixture.runtime.account_store();
        store
            .mark_authentication(
                &fixture.account.id,
                AuthState::Authenticated,
                Some("cached@example.test"),
                None,
            )
            .expect("cached account");
        let runtime = fixture.runtime.clone();
        let account_id = fixture.account.id.clone();
        let background = std::thread::spawn(move || runtime.refresh_codex_account(&account_id));
        // Only waits for the observer to reach its delayed read; the delay starts at the marker.
        // A cold cmd -> PowerShell start took over 20 s under parallel test load, so this is a
        // hang guard, and an observer that ends before reaching the read reports its result.
        let entered_deadline = Instant::now() + Duration::from_secs(120);
        while !marker.exists() && !background.is_finished() && Instant::now() < entered_deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if !marker.exists() && background.is_finished() {
            panic!(
                "background observer ended before account/read: {:?}",
                background.join().expect("background observer joins")
            );
        }
        assert!(marker.exists(), "background observer entered account/read");

        let started = Instant::now();
        fixture
            .runtime
            .prepare_account_launch(&ProviderId::new(ProviderId::CODEX), &fixture.account.id)
            .expect("foreground launch proceeds after preemption");
        // A preempting launch only cancels the observer: it neither waits for the observer's
        // teardown nor starts another account check. Waiting for the read would take 45 s.
        assert!(
            started.elapsed() < DELAYED_OBSERVER_READ / 3,
            "launch must not wait for the observer's delayed account read: {:?}",
            started.elapsed()
        );
        let canceled = background
            .join()
            .expect("background observer joins")
            .expect("preemption resolves current safe account");
        assert_eq!(canceled.authentication_state, AuthState::Authenticated);

        let refreshed = store.get(&fixture.account.id).expect("refreshed account");
        assert_eq!(refreshed.authentication_state, AuthState::Authenticated);
        assert_eq!(
            refreshed.provider_reported_identity.as_deref(),
            Some("cached@example.test")
        );
        assert_eq!(refreshed.last_error_code, None);
    }

    /// Gate 37536759481: under parallel test load the preempted observer's teardown (terminate
    /// grace, reap and the guardian's durable quiescence proof) outlasted the launch's 6 s wait,
    /// and the user's launch was refused as `provider_account_busy`. A validation that is still
    /// registered must be canceled, never block or refuse the launch.
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn launch_never_waits_for_or_refuses_on_a_slow_observer_teardown() {
        let fixture = Fixture::new();
        let validation = fixture
            .runtime
            .begin_account_validation(ProviderId::CODEX, &fixture.account.id)
            .expect("background validation");
        let cancellation = validation.cancellation();

        let started = Instant::now();
        fixture
            .runtime
            .prepare_account_launch(&ProviderId::new(ProviderId::CODEX), &fixture.account.id)
            .expect("launch proceeds while the observer is still tearing down");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "launch must not wait for observer teardown: {:?}",
            started.elapsed()
        );
        assert!(cancellation.load(Ordering::Acquire), "observer canceled");
        drop(validation);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn validation_errors_preserve_last_safe_state_and_explicit_expiry_clears_it() {
        let fixture = Fixture::new();
        let store = fixture.runtime.account_store();
        let claude = store
            .create(ProviderId::CLAUDE_CODE, "Claude")
            .expect("Claude account");
        let gemini = store
            .create(ProviderId::GEMINI_CLI, "Gemini")
            .expect("Gemini account");

        for (account, identity) in [
            (&fixture.account, "codex@example.test"),
            (&claude, "claude@example.test"),
            (&gemini, "gemini@example.test"),
        ] {
            store
                .mark_authentication(&account.id, AuthState::Authenticated, Some(identity), None)
                .expect("connected");
        }

        fixture
            .runtime
            .observe_claude(&claude.id, &Err(ClaudeAccountAuthError::ConnectionEnded))
            .expect("record Claude error");
        fixture
            .runtime
            .observe_gemini(&gemini.id, &Err(GeminiAccountAuthError::ConnectionEnded))
            .expect("record Gemini error");
        observe_codex_plan(&fixture, &Err(CodexAccountAuthError::ConnectionEnded));

        for (account, identity, error) in [
            (&fixture.account, "codex@example.test", "codex_auth_failed"),
            (&claude, "claude@example.test", "claude_auth_failed"),
            (&gemini, "gemini@example.test", "gemini_auth_failed"),
        ] {
            let preserved = store.get(&account.id).expect("preserved account");
            assert_eq!(preserved.authentication_state, AuthState::Authenticated);
            assert_eq!(
                preserved.provider_reported_identity.as_deref(),
                Some(identity)
            );
            assert_eq!(preserved.last_error_code.as_deref(), Some(error));
        }

        fixture
            .runtime
            .observe_claude(
                &claude.id,
                &Ok(ClaudeAccountState {
                    logged_in: false,
                    auth_method: None,
                    identity: None,
                    subscription_type: None,
                }),
            )
            .expect("record Claude expiry");
        fixture
            .runtime
            .observe_gemini(
                &gemini.id,
                &Ok(GeminiAccountState {
                    auth: AuthState::NotAuthenticated,
                    identity: None,
                }),
            )
            .expect("record Gemini expiry");
        observe_codex_plan(
            &fixture,
            &Ok(CodexAccountState {
                account: None,
                requires_openai_auth: true,
            }),
        );

        for account in [&fixture.account, &claude, &gemini] {
            let expired = store.get(&account.id).expect("expired account");
            assert_eq!(expired.authentication_state, AuthState::NotAuthenticated);
            assert_eq!(expired.provider_reported_identity, None);
            assert_eq!(expired.last_error_code, None);
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn expire_codex_plan(fixture: &Fixture) {
        if let Some(entry) = fixture
            .runtime
            .inner
            .codex_truth
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .cache
            .get_mut(&fixture.account.id)
        {
            entry.checked_at = Instant::now() - CODEX_TRUTH_TTL - Duration::from_secs(1);
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn codex_launch_refusal(fixture: &Fixture) -> Option<String> {
        match fixture
            .runtime
            .prepare_account_launch(&ProviderId::new(ProviderId::CODEX), &fixture.account.id)
        {
            Ok(()) => None,
            Err(ProviderError::Refused { code, .. }) => Some(code),
            Err(error) => panic!("unexpected launch failure: {error:?}"),
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    fn codex_session(fixture: &Fixture) -> kalcode_providers::managed::ProfileLease {
        fixture
            .runtime
            .managed_profiles()
            .acquire_session_lease(ProviderId::CODEX, &fixture.account.id)
            .expect("live session")
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn codex_launch_uses_cached_auth_without_refreshing_stale_plan_metadata() {
        let mut fixture = Fixture::new();
        install_read_only_codex_app_server(&mut fixture, "pro", false, false);
        let store = fixture.runtime.account_store();
        observe_codex_plan(&fixture, &connected("pro"));
        let session = codex_session(&fixture);
        expire_codex_plan(&fixture);

        assert_eq!(
            codex_launch_refusal(&fixture),
            None,
            "missing metadata does not block a second independent session"
        );
        assert_eq!(
            fixture
                .runtime
                .codex_cloud_config(&fixture.account.id)
                .expect("unknown plan metadata is informational"),
            CloudConfigEligibility::Unknown
        );
        let account = store.get(&fixture.account.id).expect("account");
        assert_eq!(account.authentication_state, AuthState::Authenticated);
        assert_eq!(
            account.last_error_code, None,
            "a busy check is not a failure"
        );

        // Starting a session does not rewrite identity from an unnecessary provider check.
        observe_codex_plan(&fixture, &connected("business"));
        expire_codex_plan(&fixture);
        assert_eq!(codex_launch_refusal(&fixture), None);
        assert_eq!(
            store
                .get(&fixture.account.id)
                .expect("fresh account truth")
                .provider_reported_identity
                .as_deref(),
            Some("person@example.test")
        );
        drop(session);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn live_session_does_not_hide_a_failed_codex_check_or_clear_safe_auth() {
        let mut fixture = Fixture::new();
        install_unrunnable_auth_managers(&mut fixture);
        let store = fixture.runtime.account_store();
        store
            .mark_authentication(
                &fixture.account.id,
                AuthState::Authenticated,
                Some("preserved@example.test"),
                None,
            )
            .expect("known safe account");
        let session = codex_session(&fixture);

        assert!(!matches!(
            fixture.runtime.refresh_codex_account(&fixture.account.id),
            Err(RuntimeAuthError::Busy)
        ));
        assert_eq!(
            codex_launch_refusal(&fixture),
            None,
            "a failed passive check cannot invalidate a persisted authenticated session"
        );
        let after = store.get(&fixture.account.id).expect("account");
        assert_eq!(after.authentication_state, AuthState::Authenticated);
        assert_eq!(
            after.provider_reported_identity.as_deref(),
            Some("preserved@example.test")
        );
        assert_eq!(after.last_error_code.as_deref(), Some("codex_auth_failed"));
        drop(session);
    }

    /// Installs a Codex auth manager whose CLI reports `version` and does nothing else.
    #[cfg(any(windows, target_os = "macos"))]
    fn install_codex_reporting(fixture: &mut Fixture, version: &str) {
        let dir = fixture._temp.path().join(format!("codex-{version}"));
        std::fs::create_dir_all(&dir).expect("fake codex directory");
        #[cfg(windows)]
        let executable = {
            let script = dir.join("codex.cmd");
            std::fs::write(
                &script,
                format!("@echo off\r\necho codex-cli {version}\r\n"),
            )
            .expect("fake codex");
            script
        };
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.join("codex");
            std::fs::write(
                &script,
                format!("#!/bin/sh\nprintf 'codex-cli {version}\\n'\n"),
            )
            .expect("fake codex");
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
                .expect("executable fake codex");
            script
        };
        let inner = Arc::get_mut(&mut fixture.runtime.inner).expect("sole runtime owner");
        inner.codex_auth = Some(Arc::new(CodexAccountAuthManager::new(
            executable,
            isolated_codex_env(Some(&dir)),
            Arc::clone(&inner.profiles),
            env!("KALCODE_PUBLIC_VERSION"),
        )));
    }

    /// How long the delayed fake holds its first `account/read`. Long enough that a launch which
    /// waited for it is unmistakable from one that preempted it, even on a loaded machine: under
    /// the gate's parallel test load a preempting launch measured 6.75 s (gate 37253600852), so
    /// the launch bound (a third of this) must sit well above that. A passing run never waits for
    /// it: the preempted observer is terminated.
    #[cfg(any(windows, target_os = "macos"))]
    const DELAYED_OBSERVER_READ: Duration = Duration::from_secs(45);

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn account_model_catalog_preserves_exact_model_and_effort_metadata() {
        let mut fixture = Fixture::new();
        install_read_only_codex_app_server(&mut fixture, "pro", false, false);
        let catalog = fixture
            .runtime
            .account_models(&fixture.account.id)
            .expect("account models");
        assert_eq!(catalog.account_id, fixture.account.id);
        assert_eq!(catalog.provider_id.as_str(), ProviderId::CODEX);
        assert_eq!(catalog.models.len(), 1);
        assert_eq!(catalog.models[0].id, "codex-test-exact");
        assert_eq!(catalog.models[0].default_effort.as_deref(), Some("high"));
        assert_eq!(catalog.models[0].supported_efforts, ["low", "high"]);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn model_discovery_expiry_signs_out_only_the_exact_account() {
        let mut fixture = Fixture::new();
        install_read_only_codex_app_server(&mut fixture, "pro", false, true);
        let store = fixture.runtime.account_store();
        let other = store
            .create(ProviderId::CODEX, "Other")
            .expect("other account");
        for account in [&fixture.account, &other] {
            store
                .mark_authentication(
                    &account.id,
                    AuthState::Authenticated,
                    Some("preserved@example.test"),
                    None,
                )
                .expect("seed auth truth");
        }

        assert!(matches!(
            fixture.runtime.account_models(&fixture.account.id),
            Err(RuntimeAuthError::Provider(
                CodexAccountAuthError::NotAuthenticated
            ))
        ));
        let expired = store.get(&fixture.account.id).expect("expired account");
        assert_eq!(expired.authentication_state, AuthState::NotAuthenticated);
        assert_eq!(expired.provider_reported_identity, None);
        assert_eq!(
            expired.last_error_code.as_deref(),
            Some("codex_not_authenticated")
        );
        let unaffected = store.get(&other.id).expect("other account");
        assert_eq!(unaffected.authentication_state, AuthState::Authenticated);
        assert_eq!(
            unaffected.provider_reported_identity.as_deref(),
            Some("preserved@example.test")
        );
    }

    /// Installs only the certified read-only Codex app-server account surface. This fake never
    /// reads provider credentials or contacts a provider.
    #[cfg(any(windows, target_os = "macos"))]
    fn install_read_only_codex_app_server(
        fixture: &mut Fixture,
        plan: &str,
        delay_first_read: bool,
        signed_out: bool,
    ) -> std::path::PathBuf {
        let dir = fixture._temp.path().join("codex-read-only");
        std::fs::create_dir_all(&dir).expect("fake codex directory");
        let first_read_marker = dir.join("first-read-entered");
        #[cfg(windows)]
        let executable = {
            let server = dir.join("codex-app-server.ps1");
            std::fs::write(
                &server,
                format!(
                    r#"$ErrorActionPreference = 'Stop'
while (($line = [Console]::In.ReadLine()) -ne $null) {{
  $request = $line | ConvertFrom-Json
  if ($request.method -eq 'initialize') {{
    $result = @{{ userAgent = 'codex_cli_rs/0.160.0'; codexHome = $env:CODEX_HOME; platformFamily = 'windows'; platformOs = 'windows' }}
  }} elseif ($request.method -eq 'account/read') {{
    if ($request.params.refreshToken -ne $false) {{ exit 9 }}
    if ({delay_first_read} -and -not (Test-Path -LiteralPath '{marker}')) {{
      [IO.File]::WriteAllText('{marker}', 'entered')
      Start-Sleep -Seconds {delay}
    }}
    $result = @{{ account = {account}; requiresOpenaiAuth = $true }}
  }} elseif ($request.method -eq 'model/list') {{
    if ($request.params.includeHidden -ne $false -or $request.params.limit -ne 100) {{ exit 9 }}
    $efforts = @(@{{ reasoningEffort = 'low'; description = 'Low' }}, @{{ reasoningEffort = 'high'; description = 'High' }})
    $model = @{{ id = 'catalog-exact'; model = 'codex-test-exact'; displayName = 'Codex exact'; description = 'Exact account model'; hidden = $false; isDefault = $true; defaultReasoningEffort = 'high'; supportedReasoningEfforts = $efforts }}
    $result = @{{ data = @($model); nextCursor = $null }}
  }} else {{ continue }}
  [Console]::Out.WriteLine((@{{ id = $request.id; result = $result }} | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}}
"#,
                    delay_first_read = if delay_first_read { "$true" } else { "$false" },
                    delay = DELAYED_OBSERVER_READ.as_secs(),
                    marker = first_read_marker.to_string_lossy().replace('`', "``").replace('\'', "''"),
                    account = if signed_out {
                        "$null".to_owned()
                    } else {
                        format!("@{{ type = 'chatgpt'; email = 'restored@example.test'; planType = '{plan}' }}")
                    },
                ),
            )
            .expect("fake app-server");
            let script = dir.join("codex.cmd");
            std::fs::write(
                &script,
                "@echo off\r\nif \"%~1\"==\"--version\" (echo codex-cli 0.160.0& exit /b 0)\r\nif \"%~1\"==\"--help\" goto root_help\r\nif \"%~1\"==\"exec\" if \"%~2\"==\"--help\" goto exec_help\r\nif \"%~1\"==\"exec\" if \"%~2\"==\"resume\" if \"%~3\"==\"--help\" goto exec_resume_help\r\nif \"%~1\"==\"resume\" if \"%~2\"==\"--help\" goto resume_help\r\nif \"%~1\"==\"app-server\" if \"%~2\"==\"--help\" goto app_server_help\r\n:scan\r\nif \"%~1\"==\"\" exit /b 2\r\nif \"%~1\"==\"app-server\" goto server\r\nshift /1\r\ngoto scan\r\n:root_help\r\necho Commands:\r\necho   exec Run Codex non-interactively\r\necho   mcp Manage MCP servers\r\necho   app-server Run the app server\r\necho   resume Resume an interactive session\r\necho Options: -c -m -C -s -a --no-daemon\r\nexit /b 0\r\n:exec_help\r\necho Commands:\r\necho   resume Resume a previous session\r\necho Options: -c --model --json --sandbox --output-schema --skip-git-repo-check\r\nexit /b 0\r\n:exec_resume_help\r\necho Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\r\necho Options: --json\r\nexit /b 0\r\n:resume_help\r\necho Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]\r\nexit /b 0\r\n:app_server_help\r\necho Usage: codex app-server [OPTIONS]\r\nexit /b 0\r\n:server\r\n\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"%~dp0codex-app-server.ps1\"\r\nexit /b %ERRORLEVEL%\r\n",
            )
            .expect("fake codex");
            script
        };
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;

            let script = dir.join("codex");
            std::fs::write(
                &script,
                format!(
                    r#"#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\n' 'codex-cli 0.160.0'; exit 0; fi
case "$*" in
  "--help") printf '%s\n' 'Commands:' '  exec Run Codex non-interactively' '  mcp Manage MCP servers' '  app-server Run the app server' '  resume Resume an interactive session' 'Options: -c -m -C -s -a --no-daemon'; exit 0 ;;
  "exec --help") printf '%s\n' 'Commands:' '  resume Resume a previous session' 'Options: -c --model --json --sandbox --output-schema --skip-git-repo-check'; exit 0 ;;
  "exec resume --help") printf '%s\n' 'Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]' 'Options: --json'; exit 0 ;;
  "resume --help") printf '%s\n' 'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]'; exit 0 ;;
  "app-server --help") printf '%s\n' 'Usage: codex app-server [OPTIONS]'; exit 0 ;;
esac
found=false
for arg in "$@"; do if [ "$arg" = "app-server" ]; then found=true; fi; done
$found || exit 2
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\1/')
  case "$line" in
    *'"method":"initialize"'*) printf '{{"id":%s,"result":{{"userAgent":"codex_cli_rs/0.160.0","codexHome":"%s","platformFamily":"unix","platformOs":"macos"}}}}\n' "$id" "$CODEX_HOME" ;;
    *'"method":"account/read"'*'"refreshToken":false'*)
      if {delay_first_read} && [ ! -e '{marker}' ]; then : > '{marker}'; sleep {delay}; fi
      printf '{{"id":%s,"result":{{"account":{account},"requiresOpenaiAuth":true}}}}\n' "$id"
      ;;
    *'"method":"model/list"'*)
      printf '{{"id":%s,"result":{{"data":[{{"id":"catalog-exact","model":"codex-test-exact","displayName":"Codex exact","description":"Exact account model","hidden":false,"isDefault":true,"defaultReasoningEffort":"high","supportedReasoningEfforts":[{{"reasoningEffort":"low","description":"Low"}},{{"reasoningEffort":"high","description":"High"}}]}}],"nextCursor":null}}}}\n' "$id"
      ;;
  esac
done
"#,
                    delay_first_read = if delay_first_read { "true" } else { "false" },
                    delay = DELAYED_OBSERVER_READ.as_secs(),
                    marker = first_read_marker.to_string_lossy().replace('\'', "'\\''"),
                    account = if signed_out {
                        "null".to_owned()
                    } else {
                        format!(r#"{{"type":"chatgpt","email":"restored@example.test","planType":"{plan}"}}"#)
                    },
                ),
            )
            .expect("fake codex");
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
                .expect("executable fake codex");
            script
        };
        let inner = Arc::get_mut(&mut fixture.runtime.inner).expect("sole runtime owner");
        inner.codex_auth = Some(Arc::new(CodexAccountAuthManager::new(
            executable,
            isolated_codex_env(Some(&dir)),
            Arc::clone(&inner.profiles),
            env!("KALCODE_PUBLIC_VERSION"),
        )));
        first_read_marker
    }

    /// A stable version string alone never proves compatibility. This fake omits the required
    /// app-server capabilities, so the account stays unchanged and the error names capabilities.
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn codex_missing_capabilities_leave_the_account_unchanged() {
        let mut fixture = Fixture::new();
        install_codex_reporting(&mut fixture, "0.161.0");
        let store = fixture.runtime.account_store();
        let before = store.get(&fixture.account.id).expect("account");

        assert!(matches!(
            fixture.runtime.refresh_codex_account(&fixture.account.id),
            Err(RuntimeAuthError::Provider(
                CodexAccountAuthError::IncompatibleCapabilities
            ))
        ));
        assert_eq!(
            codex_launch_refusal(&fixture),
            None,
            "the real provider adapter enforces its required capabilities at launch"
        );
        let after = store.get(&fixture.account.id).expect("account");
        assert_eq!(after.authentication_state, before.authentication_state);
        assert_eq!(after.last_error_code, None, "no account check ran");
    }

    /// An unavailable account metadata service does not add a launch precondition.
    /// The real provider launch still reports installation/version failures itself.
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn unavailable_codex_metadata_service_does_not_gate_provider_launch() {
        let mut fixture = Fixture::new();
        install_unrunnable_auth_managers(&mut fixture);
        assert_eq!(
            codex_launch_refusal(&fixture),
            None,
            "launch preparation does not require the passive metadata service"
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn codex_sign_in_or_sign_out_forgets_the_reusable_plan_verdict() {
        let mut fixture = Fixture::new();
        install_unrunnable_auth_managers(&mut fixture);

        // A completed sign-out observes a signed-out profile, so no earlier verdict survives it.
        observe_codex_plan(&fixture, &connected("pro"));
        observe_codex_plan(
            &fixture,
            &Ok(CodexAccountState {
                account: None,
                requires_openai_auth: true,
            }),
        );
        let session = codex_session(&fixture);
        assert!(
            fixture
                .runtime
                .cached_codex_eligibility(&fixture.account.id)
                .is_none()
        );
        assert_eq!(
            fixture.runtime.account_store().launch_with_active_account(
                &fixture.runtime.managed_profiles(),
                ProviderId::CODEX,
                &fixture.account.id,
                |_| Ok(())
            ),
            Err(ProviderError::NotAuthenticated),
            "the shared account launch guard still rejects confirmed sign-out"
        );
        drop(session);

        // A sign-out or sign-in that took the exclusive lease may have changed the profile, so the
        // verdict is forgotten even when the provider operation then fails.
        observe_codex_plan(&fixture, &connected("pro"));
        assert!(fixture.runtime.logout_codex(&fixture.account.id).is_err());
        let session = codex_session(&fixture);
        assert!(
            fixture
                .runtime
                .cached_codex_eligibility(&fixture.account.id)
                .is_none()
        );
        assert_eq!(codex_launch_refusal(&fixture), None);
        drop(session);

        observe_codex_plan(&fixture, &connected("pro"));
        assert!(
            fixture
                .runtime
                .start_codex_login(&fixture.account.id)
                .is_err()
        );
        let session = codex_session(&fixture);
        assert!(
            fixture
                .runtime
                .cached_codex_eligibility(&fixture.account.id)
                .is_none()
        );
        assert_eq!(codex_launch_refusal(&fixture), None);
        drop(session);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn account_writers_while_sessions_run_are_busy_but_passive_claude_restore_is_immediate() {
        let mut fixture = Fixture::new();
        install_unrunnable_auth_managers(&mut fixture);
        let store = fixture.runtime.account_store();
        let claude = store
            .create(ProviderId::CLAUDE_CODE, "Claude")
            .expect("claude account");
        observe_codex_plan(&fixture, &connected("pro"));
        let codex_session = codex_session(&fixture);
        let claude_session = fixture
            .runtime
            .managed_profiles()
            .acquire_session_lease(ProviderId::CLAUDE_CODE, &claude.id)
            .expect("live claude session");

        assert!(matches!(
            fixture.runtime.start_codex_login(&fixture.account.id),
            Err(RuntimeAuthError::Busy)
        ));
        assert!(matches!(
            fixture.runtime.logout_codex(&fixture.account.id),
            Err(RuntimeAuthError::Busy)
        ));
        assert_eq!(
            fixture
                .runtime
                .refresh_claude_account(&claude.id)
                .expect("passive restore")
                .id,
            claude.id
        );
        assert!(matches!(
            fixture.runtime.start_claude_login(&claude.id),
            Err(RuntimeAuthError::Busy)
        ));
        assert!(matches!(
            fixture.runtime.logout_claude(&claude.id),
            Err(RuntimeAuthError::Busy)
        ));

        let codex = store.get(&fixture.account.id).expect("codex account");
        assert_eq!(codex.authentication_state, AuthState::Authenticated);
        assert_eq!(codex.last_error_code, None);
        let claude_after = store.get(&claude.id).expect("claude account");
        assert_eq!(
            claude_after.authentication_state,
            claude.authentication_state
        );
        assert_eq!(claude_after.last_error_code, None);

        // Beginning a lifecycle operation invalidates the prior plan generation even when the
        // live session then refuses the writer. An unavailable metadata service does not
        // prevent another native session from using the still-authenticated account.
        assert_eq!(codex_launch_refusal(&fixture), None);
        drop((codex_session, claude_session));
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn passive_claude_restore_rejects_archived_or_missing_metadata() {
        let mut fixture = Fixture::new();
        install_unrunnable_auth_managers(&mut fixture);
        let store = fixture.runtime.account_store();
        let claude = store
            .create(ProviderId::CLAUDE_CODE, "Claude")
            .expect("claude account");
        store
            .archive(&fixture.runtime.inner.profiles, &claude.id)
            .expect("archive");
        let missing = kalcode_contracts::ids::new_id();
        let wrong_provider = store
            .create(ProviderId::GEMINI_CLI, "Gemini")
            .expect("other provider account");

        for account_id in [
            claude.id.as_str(),
            missing.as_str(),
            wrong_provider.id.as_str(),
        ] {
            assert!(matches!(
                fixture.runtime.refresh_claude_account(account_id),
                Err(RuntimeAuthError::Account(_))
            ));
            assert!(matches!(
                fixture.runtime.start_claude_login(account_id),
                Err(RuntimeAuthError::Claude(
                    ClaudeAccountAuthError::ProfileUnavailable
                ))
            ));
            assert!(matches!(
                fixture.runtime.logout_claude(account_id),
                Err(RuntimeAuthError::Claude(
                    ClaudeAccountAuthError::ProfileUnavailable
                ))
            ));
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn an_archived_codex_accounts_verdict_is_never_reused() {
        let mut fixture = Fixture::new();
        install_unrunnable_auth_managers(&mut fixture);
        let store = fixture.runtime.account_store();
        observe_codex_plan(&fixture, &connected("pro"));
        store
            .archive(&fixture.runtime.inner.profiles, &fixture.account.id)
            .expect("archive");
        expire_codex_plan(&fixture);
        assert_eq!(codex_launch_refusal(&fixture), None);
        let error = store
            .launch_with_active_account(
                &fixture.runtime.inner.profiles,
                ProviderId::CODEX,
                &fixture.account.id,
                |_| -> Result<(), ProviderError> {
                    panic!("an archived account must never reach a provider launch")
                },
            )
            .expect_err("the canonical account launch guard rejects archived accounts");
        assert!(matches!(error, ProviderError::Start(_)));

        let replacement = store
            .create(ProviderId::CODEX, "Personal")
            .expect("new account");
        fixture.account = replacement;
        let session = codex_session(&fixture);
        assert_eq!(
            fixture
                .runtime
                .codex_cloud_config(&fixture.account.id)
                .expect("metadata"),
            CloudConfigEligibility::Unknown,
            "a replacement account never inherits the prior account's plan"
        );
        assert_eq!(codex_launch_refusal(&fixture), None);
        drop(session);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn login_slots_are_reserved_atomically_before_blocking_provider_work() {
        let fixture = Fixture::new();
        let state = ProviderAuthState {
            runtime: Some(fixture.runtime.clone()),
            pending: Arc::new(Mutex::new(HashMap::new())),
            starting: Arc::new((Mutex::new(0), Condvar::new())),
            shutting_down: Arc::new(AtomicBool::new(false)),
        };
        let reservations: Vec<_> = (0..MAX_PENDING_LOGINS)
            .map(|index| {
                state
                    .reserve_login(format!("{}-{index}", fixture.account.id))
                    .expect("bounded reservation")
            })
            .collect();
        assert!(matches!(
            state.reserve_login("overflow".into()),
            Err(RuntimeAuthError::Busy)
        ));
        assert_eq!(state.pending().len(), MAX_PENDING_LOGINS);
        drop(reservations);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn shutdown_waits_for_start_reservations_and_rejects_new_work() {
        let fixture = Fixture::new();
        let state = Arc::new(ProviderAuthState {
            runtime: Some(fixture.runtime.clone()),
            pending: Arc::new(Mutex::new(HashMap::new())),
            starting: Arc::new((Mutex::new(0), Condvar::new())),
            shutting_down: Arc::new(AtomicBool::new(false)),
        });
        let reservation = state
            .reserve_login(fixture.account.id.clone())
            .expect("reservation");
        let shutdown_state = Arc::clone(&state);
        let shutdown = std::thread::spawn(move || shutdown_state.shutdown());
        while !state.shutting_down.load(Ordering::Acquire) {
            std::thread::yield_now();
        }
        assert!(matches!(
            state.reserve_login(kalcode_contracts::ids::new_id()),
            Err(RuntimeAuthError::Busy)
        ));
        assert!(
            !shutdown.is_finished(),
            "shutdown waits for the in-flight start"
        );
        drop(reservation);
        assert!(shutdown.join().expect("shutdown thread"));
        assert!(state.shutdown(), "shutdown is idempotent");
    }

    #[test]
    fn finished_login_removal_is_idempotent_for_the_same_terminal_identity() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let login_handle = kalcode_contracts::ids::new_id();
        let account_id = kalcode_contracts::ids::new_id();
        let first = Arc::new(SyntheticPendingLogin {
            provider_id: ProviderId::CODEX,
            cancel_started: Arc::new((Mutex::new(false), Condvar::new())),
            allow_quiesce: Arc::new((Mutex::new(true), Condvar::new())),
            lease: Mutex::new(None),
            failures_remaining: std::sync::atomic::AtomicUsize::new(0),
            finished: AtomicBool::new(true),
        });
        let first = PendingProviderLogin::Synthetic(first);
        pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                login_handle.clone(),
                PendingLoginEntry::Active {
                    account_id: account_id.clone(),
                    pending: first.clone(),
                },
            );

        assert!(remove_finished_login(&pending, &login_handle, &first));
        assert!(
            remove_finished_login(&pending, &login_handle, &first),
            "a concurrent owner that already removed this exact finished login is success"
        );

        let replacement = Arc::new(SyntheticPendingLogin {
            provider_id: ProviderId::CODEX,
            cancel_started: Arc::new((Mutex::new(false), Condvar::new())),
            allow_quiesce: Arc::new((Mutex::new(true), Condvar::new())),
            lease: Mutex::new(None),
            failures_remaining: std::sync::atomic::AtomicUsize::new(0),
            finished: AtomicBool::new(true),
        });
        pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                login_handle.clone(),
                PendingLoginEntry::Active {
                    account_id,
                    pending: PendingProviderLogin::Synthetic(replacement),
                },
            );
        assert!(
            !remove_finished_login(&pending, &login_handle, &first),
            "a different login under the same handle must remain tracked"
        );
        assert!(
            pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains_key(&login_handle),
            "identity mismatch must not remove the replacement"
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn wrong_provider_and_browser_failure_cancel_remain_tracked_until_quiescence() {
        let fixture = Fixture::new();
        let state = Arc::new(ProviderAuthState {
            runtime: Some(fixture.runtime.clone()),
            pending: Arc::new(Mutex::new(HashMap::new())),
            starting: Arc::new((Mutex::new(0), Condvar::new())),
            shutting_down: Arc::new(AtomicBool::new(false)),
        });
        let cancel_started = Arc::new((Mutex::new(false), Condvar::new()));
        let allow_quiesce = Arc::new((Mutex::new(false), Condvar::new()));
        let lease = fixture
            .runtime
            .inner
            .profiles
            .acquire_sign_in_lease(ProviderId::CODEX, &fixture.account.id)
            .expect("exclusive auth lease");
        let synthetic = Arc::new(SyntheticPendingLogin {
            provider_id: ProviderId::CODEX,
            cancel_started: Arc::clone(&cancel_started),
            allow_quiesce: Arc::clone(&allow_quiesce),
            lease: Mutex::new(Some(lease)),
            failures_remaining: std::sync::atomic::AtomicUsize::new(0),
            finished: AtomicBool::new(false),
        });
        let login_handle = kalcode_contracts::ids::new_id();
        state.pending().insert(
            login_handle.clone(),
            PendingLoginEntry::Active {
                account_id: fixture.account.id.clone(),
                pending: PendingProviderLogin::Synthetic(Arc::clone(&synthetic)),
            },
        );

        assert!(
            cancel_tracked_login_blocking(&state.pending, &login_handle, ProviderId::CLAUDE_CODE)
                .is_none(),
            "a Claude command must reject a Codex handle"
        );
        assert_eq!(
            state.pending().len(),
            1,
            "variant mismatch must not remove the live login"
        );

        let cancel_state = Arc::clone(&state);
        let cancel_handle = login_handle.clone();
        // The browser-opener failure path delegates to this same tracked cancellation helper.
        let cancel = std::thread::spawn(move || {
            cancel_tracked_login_blocking(&cancel_state.pending, &cancel_handle, ProviderId::CODEX)
                .expect("matching login")
        });

        let (started, changed) = &*cancel_started;
        let started = started.lock().unwrap_or_else(PoisonError::into_inner);
        let (started, timeout) = changed
            .wait_timeout_while(started, Duration::from_secs(2), |started| !*started)
            .unwrap_or_else(PoisonError::into_inner);
        assert!(*started && !timeout.timed_out(), "cancel did not begin");
        drop(started);

        let shutdown_state = Arc::clone(&state);
        let shutdown = std::thread::spawn(move || shutdown_state.shutdown());
        let deadline = Instant::now() + Duration::from_secs(2);
        while !state.shutting_down.load(Ordering::Acquire) && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(
            !shutdown.is_finished(),
            "shutdown must wait for cancellation"
        );
        assert!(
            fixture
                .runtime
                .inner
                .profiles
                .acquire_session_lease(ProviderId::CODEX, &fixture.account.id)
                .is_err(),
            "the auth lease must remain held until process-tree quiescence"
        );

        let (allowed, changed) = &*allow_quiesce;
        *allowed.lock().unwrap_or_else(PoisonError::into_inner) = true;
        changed.notify_all();
        cancel
            .join()
            .expect("cancel thread")
            .expect("cancel result");
        assert!(shutdown.join().expect("shutdown thread"));
        let _session = fixture
            .runtime
            .inner
            .profiles
            .acquire_session_lease(ProviderId::CODEX, &fixture.account.id)
            .expect("lease releases only after quiescence");
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn failed_shutdown_cancel_remains_tracked_until_a_retry_proves_quiescence() {
        let fixture = Fixture::new();
        let state = ProviderAuthState {
            runtime: Some(fixture.runtime.clone()),
            pending: Arc::new(Mutex::new(HashMap::new())),
            starting: Arc::new((Mutex::new(0), Condvar::new())),
            shutting_down: Arc::new(AtomicBool::new(false)),
        };
        let lease = fixture
            .runtime
            .inner
            .profiles
            .acquire_sign_in_lease(ProviderId::CODEX, &fixture.account.id)
            .expect("exclusive auth lease");
        let synthetic = Arc::new(SyntheticPendingLogin {
            provider_id: ProviderId::CODEX,
            cancel_started: Arc::new((Mutex::new(false), Condvar::new())),
            allow_quiesce: Arc::new((Mutex::new(true), Condvar::new())),
            lease: Mutex::new(Some(lease)),
            failures_remaining: std::sync::atomic::AtomicUsize::new(1),
            finished: AtomicBool::new(false),
        });
        let login_handle = kalcode_contracts::ids::new_id();
        state.pending().insert(
            login_handle.clone(),
            PendingLoginEntry::Active {
                account_id: fixture.account.id.clone(),
                pending: PendingProviderLogin::Synthetic(Arc::clone(&synthetic)),
            },
        );

        assert!(
            !state.shutdown(),
            "first failed cleanup cannot report success"
        );
        assert!(
            state.pending().contains_key(&login_handle),
            "failed cancellation must remain tracked"
        );
        assert!(
            fixture
                .runtime
                .inner
                .profiles
                .acquire_session_lease(ProviderId::CODEX, &fixture.account.id)
                .is_err(),
            "failed cancellation retains the exclusive auth lease"
        );

        assert!(state.shutdown(), "retry proves terminal cleanup");
        assert!(state.pending().is_empty());
        let _session = fixture
            .runtime
            .inner
            .profiles
            .acquire_session_lease(ProviderId::CODEX, &fixture.account.id)
            .expect("lease releases only after successful retry");
    }
}
