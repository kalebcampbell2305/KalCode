//! Canonical managed-provider account authority and official native provider authentication IPC.
//!
//! Account metadata remains in the core database, provider credentials remain only in the
//! provider's isolated native profile, and official authentication URLs open in the operating
//! system browser without crossing the WebView boundary.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentProvider, AuthState, ProviderError, ProviderId};
use kalcode_contracts::provider_accounts::ProviderAccount;
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

#[cfg(feature = "e2e")]
mod e2e;

const CODEX_TRUTH_TTL: Duration = Duration::from_secs(5 * 60);
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
    OrganizationPlan,
    PlanUnverified,
}

impl RuntimeAuthError {
    /// A launch refusal with a stable code and fixed, user-safe copy. Only a provider that is
    /// missing maps to a plain provider error; nothing here is a provider start failure.
    fn into_provider_error(self) -> ProviderError {
        use kalcode_contracts::threads::error_codes;
        let refused = |code: &str, message: String| ProviderError::Refused {
            code: code.to_owned(),
            message,
        };
        let version = |window: &VersionWindow| {
            refused(
                error_codes::PROVIDER_VERSION_UNSUPPORTED,
                window_unsupported_message(window),
            )
        };
        match self {
            Self::Account(error) => refused(error.code, error.message),
            Self::ProviderUnavailable | Self::GeminiUnavailable => ProviderError::NotInstalled,
            Self::Busy => refused(
                error_codes::PROVIDER_ACCOUNT_BUSY,
                "This account is busy with a sign-in or account change in KalCode. Finish it, then resume this thread."
                    .into(),
            ),
            Self::Provider(CodexAccountAuthError::UnsupportedVersion) => {
                version(&kalcode_providers::codex::MANAGED_VERSIONS)
            }
            Self::Gemini(GeminiAccountAuthError::UnsupportedVersion) => {
                version(&kalcode_providers::gemini::MANAGED_VERSIONS)
            }
            Self::Claude(error) => match claude_failure_ipc(&error) {
                Some((code, message)) if code == error_codes::PROVIDER_VERSION_UNSUPPORTED => {
                    refused(code, message)
                }
                _ => refused(
                    error_codes::PROVIDER_ACCOUNT_CHECK_FAILED,
                    format!(
                        "KalCode couldn't confirm this Claude Code account with Claude Code's official account check (reason: {}). Check your connection, then resume this thread.",
                        error.reason_code()
                    ),
                ),
            },
            Self::Provider(_) => refused(
                error_codes::PROVIDER_ACCOUNT_CHECK_FAILED,
                "KalCode couldn't confirm this Codex account with Codex's official account check. Check your connection, then resume this thread."
                    .into(),
            ),
            Self::Gemini(_) => refused(
                error_codes::PROVIDER_ACCOUNT_CHECK_FAILED,
                "KalCode couldn't confirm this Gemini CLI account with Gemini CLI's official account check. Check your connection, then resume this thread."
                    .into(),
            ),
            Self::OrganizationPlan => refused(
                error_codes::PROVIDER_ACCOUNT_PLAN_UNSUPPORTED,
                "KalCode doesn't support Codex organization plans (Business, Enterprise, Edu) yet. Use a personal ChatGPT plan for this Codex account."
                    .into(),
            ),
            Self::PlanUnverified => refused(
                error_codes::PROVIDER_ACCOUNT_PLAN_UNVERIFIED,
                "KalCode couldn't verify this Codex account's plan. Sign in to this Codex account again in Providers, then resume this thread."
                    .into(),
            ),
        }
    }

    fn into_ipc(self, command: &'static str) -> IpcError {
        if let Self::Claude(error) = &self
            && let Some((code, message)) = claude_failure_ipc(error)
        {
            return KalError::new(ErrorCategory::Provider, code, message).log_and_convert(command);
        }
        let unsupported_window = match &self {
            Self::Provider(CodexAccountAuthError::UnsupportedVersion) => {
                Some(&kalcode_providers::codex::MANAGED_VERSIONS)
            }
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
            Self::OrganizationPlan => (
                "provider_account_plan_unsupported",
                "This Codex organization plan isn't supported by managed profiles yet.",
            ),
            Self::PlanUnverified => (
                "provider_account_plan_unverified",
                "KalCode couldn't verify a supported Codex consumer plan for this account.",
            ),
        };
        KalError::new(ErrorCategory::Provider, code, message).log_and_convert(command)
    }
}

/// `provider_version_unsupported` copy for a provider whose certified lines live in a
/// [`VersionWindow`], in the same shape as the Claude refusal. Codex and Gemini account errors do
/// not carry the found version, so the refusal names the supported window and install command.
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
        let codex_auth = source_env
            .resolve_executable_only(&catalog::codex_spec())
            .map(|executable| {
                Arc::new(CodexAccountAuthManager::new(
                    executable,
                    source_env.clone(),
                    Arc::clone(&profiles),
                ))
            });
        let gemini_auth = source_env
            .resolve_executable_only(&catalog::gemini_spec())
            .map(|executable| {
                Arc::new(GeminiAccountAuthManager::new(
                    executable,
                    source_env.clone(),
                    Arc::clone(&profiles),
                ))
            });
        Ok(Self {
            inner: Arc::new(RuntimeInner {
                guardian,
                accounts: AccountStore::new(core),
                profiles,
                source_env,
                claude_auth,
                codex_auth,
                gemini_auth,
                codex_truth: Mutex::new(CodexTruth::default()),
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
        let (state, identity, error_code) = match result {
            Ok(state) if state.logged_in => {
                (AuthState::Authenticated, state.identity.as_deref(), None)
            }
            Ok(_) => (AuthState::NotAuthenticated, None, None),
            Err(_) => (AuthState::Unknown, None, Some("claude_auth_failed")),
        };
        self.inner
            .accounts
            .mark_authentication(account_id, state, identity, error_code)
            .map(|_| ())
            .map_err(|_| ClaudeAccountAuthError::StateUpdateFailed)
    }

    fn refresh_claude_account(
        &self,
        account_id: &str,
    ) -> Result<ProviderAccount, RuntimeAuthError> {
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
                    .read_account_with_lease_observed(account_id, lease, move |result| {
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
        if result.is_err() {
            let failure = recorded_failure
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            let _ = self.inner.accounts.mark_authentication(
                account_id,
                AuthState::Unknown,
                None,
                Some("claude_auth_failed"),
            );
            return Err(match failure {
                Some(error) => RuntimeAuthError::Claude(error),
                None => RuntimeAuthError::Busy,
            });
        }
        self.inner
            .accounts
            .get(account_id)
            .map_err(RuntimeAuthError::Account)
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
        if result.is_err() {
            let failure = recorded_failure
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            if failure != Some(ClaudeAccountAuthError::AlreadyConnected) {
                let _ = self.inner.accounts.mark_authentication(
                    account_id,
                    AuthState::Unknown,
                    None,
                    Some("claude_auth_failed"),
                );
            }
            return Err(match failure {
                Some(error) => RuntimeAuthError::Claude(error),
                None => RuntimeAuthError::Busy,
            });
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
        if result.is_err() {
            let failure = recorded_failure
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            let _ = self.inner.accounts.mark_authentication(
                account_id,
                AuthState::Unknown,
                None,
                Some("claude_auth_failed"),
            );
            return Err(match failure {
                Some(error) => RuntimeAuthError::Claude(error),
                None => RuntimeAuthError::Busy,
            });
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
        // The identity is Gemini's `active` Google account (display only, never logged); it is
        // present only for a signed-in profile, so sign-out and failures clear it.
        let (state, identity, error_code) = match result {
            Ok(state) => (state.auth, state.identity.as_deref(), None),
            Err(_) => (AuthState::Unknown, None, Some("gemini_auth_failed")),
        };
        self.inner
            .accounts
            .mark_authentication(account_id, state, identity, error_code)
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
            let _ = self.inner.accounts.mark_authentication(
                account_id,
                AuthState::Unknown,
                None,
                Some("gemini_auth_failed"),
            );
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
        let observer = self.clone();
        let profiles = Arc::clone(&self.inner.profiles);
        self.with_gemini_account(account_id, |lease| {
            gemini_account_auth::read_account_with_lease_observed(
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
        {
            let truth = self
                .inner
                .codex_truth
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if truth.generations.get(account_id) != Some(&generation) {
                return Err(CodexAccountAuthError::StateUpdateFailed);
            }
        }
        let (state, identity, error_code, eligibility) = match result {
            Ok(state) => match &state.account {
                Some(account) => (
                    AuthState::Authenticated,
                    account.email.as_deref(),
                    None,
                    Some(state.cloud_config_eligibility()),
                ),
                None => (AuthState::NotAuthenticated, None, None, None),
            },
            Err(_) => (AuthState::Unknown, None, Some("codex_auth_failed"), None),
        };
        self.inner
            .accounts
            .mark_authentication(account_id, state, identity, error_code)
            .map_err(|_| CodexAccountAuthError::StateUpdateFailed)?;

        let mut truth = self
            .inner
            .codex_truth
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if truth.generations.get(account_id) != Some(&generation) {
            return Err(CodexAccountAuthError::StateUpdateFailed);
        }
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

    fn cached_codex_eligibility(
        &self,
        account_id: &str,
    ) -> Result<CloudConfigEligibility, RuntimeAuthError> {
        let truth = self
            .inner
            .codex_truth
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = truth.cache.get(account_id) else {
            return Err(RuntimeAuthError::PlanUnverified);
        };
        if truth.generations.get(account_id) != Some(&entry.generation)
            || entry.checked_at.elapsed() > CODEX_TRUTH_TTL
        {
            return Err(RuntimeAuthError::PlanUnverified);
        }
        Ok(entry.eligibility)
    }

    fn refresh_codex_account(&self, account_id: &str) -> Result<ProviderAccount, RuntimeAuthError> {
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
                    .read_account_with_lease_observed(account_id, lease, move |result| {
                        observer.observe_codex(account_id, generation, result)
                    })
                    .map_err(|error| ProviderError::Start(error.to_string()))
            },
        );
        drop(operation);
        if result.is_err() {
            let _ = self.inner.accounts.mark_authentication(
                account_id,
                AuthState::Unknown,
                None,
                Some("codex_auth_failed"),
            );
        }
        result.map_err(|error| match error {
            ProviderError::NotInstalled => RuntimeAuthError::ProviderUnavailable,
            ProviderError::Start(message)
                if message.contains("already in use") || message.contains("profile is in use") =>
            {
                RuntimeAuthError::Busy
            }
            ProviderError::Refused { code, .. }
                if code == kalcode_contracts::threads::error_codes::PROVIDER_ACCOUNT_BUSY =>
            {
                RuntimeAuthError::Busy
            }
            _ => RuntimeAuthError::Provider(CodexAccountAuthError::ConnectionEnded),
        })?;
        self.inner
            .accounts
            .get(account_id)
            .map_err(RuntimeAuthError::Account)
    }

    /// Refreshes security-sensitive Codex plan truth before any shared launch lease is acquired.
    /// A stale cache is never treated as durable authentication.
    pub fn prepare_account_launch(
        &self,
        provider: &ProviderId,
        account_id: &str,
    ) -> Result<(), ProviderError> {
        if provider.as_str() != ProviderId::CODEX {
            return Ok(());
        }
        if self.cached_codex_eligibility(account_id).is_err() {
            self.refresh_codex_account(account_id)
                .map_err(RuntimeAuthError::into_provider_error)?;
        }
        match self
            .cached_codex_eligibility(account_id)
            .map_err(RuntimeAuthError::into_provider_error)?
        {
            CloudConfigEligibility::Ineligible => Ok(()),
            CloudConfigEligibility::Eligible => {
                Err(RuntimeAuthError::OrganizationPlan.into_provider_error())
            }
            CloudConfigEligibility::Unknown => {
                Err(RuntimeAuthError::PlanUnverified.into_provider_error())
            }
        }
    }

    /// Resolver used by the interactive Codex adapter after `prepare_account_launch` and while
    /// the outer shared account lease is held.
    pub fn codex_cloud_config(
        &self,
        account_id: &str,
    ) -> Result<CloudConfigEligibility, ProviderError> {
        self.cached_codex_eligibility(account_id)
            .map_err(RuntimeAuthError::into_provider_error)
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
        if result.is_err() {
            let failure = provider_failure
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            if failure != Some(CodexAccountAuthError::AlreadyConnected) {
                let _ = self.inner.accounts.mark_authentication(
                    account_id,
                    AuthState::Unknown,
                    None,
                    Some("codex_auth_failed"),
                );
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
        if result.is_err() {
            let _ = self.inner.accounts.mark_authentication(
                account_id,
                AuthState::Unknown,
                None,
                Some("codex_auth_failed"),
            );
        }
        result.map_err(|_| RuntimeAuthError::Provider(CodexAccountAuthError::ConnectionEnded))?;
        self.inner
            .accounts
            .get(account_id)
            .map_err(RuntimeAuthError::Account)
    }
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
    fn codex_and_gemini_version_refusals_name_the_certified_window_and_install_command() {
        for (error, window) in [
            (
                RuntimeAuthError::Provider(CodexAccountAuthError::UnsupportedVersion),
                &kalcode_providers::codex::MANAGED_VERSIONS,
            ),
            (
                RuntimeAuthError::Gemini(GeminiAccountAuthError::UnsupportedVersion),
                &kalcode_providers::gemini::MANAGED_VERSIONS,
            ),
        ] {
            let ipc = error.into_ipc("provider_login_start");
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
        }
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
    fn codex_truth_is_generation_bound_fresh_and_fail_closed_for_org_plans() {
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
                .is_err(),
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
        assert!(matches!(
            fixture
                .runtime
                .prepare_account_launch(&ProviderId::new(ProviderId::CODEX), &fixture.account.id),
            Err(ProviderError::Refused { code, message })
                if code == "provider_account_plan_unsupported"
                    && message.contains("organization plans")
        ));

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
                .is_err(),
            "expired truth cannot authorize a session"
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
                .is_err()
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
