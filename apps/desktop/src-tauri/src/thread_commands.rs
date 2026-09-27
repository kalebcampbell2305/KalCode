//! Thread IPC commands (campaign Z3; names and shapes per docs/CONTRACTS.md, plus
//! `thread_options` and `thread_tool_calls`, which the Threads surface needs).
//!
//! Every input is validated natively by the thread runtime (`kalcode_threads::validate`):
//! ids with `is_valid_id`, names/prompts/models by length and character set, permission modes
//! by enum. The WebView never supplies a path, executable or shell string — a thread's working
//! directory comes from the workspace resolver.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use kalcode_contracts::agent::{
    AgentEvent, AgentEventSink, AgentProvider, AgentSession, ProviderCapabilities,
    ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::context::PromptReview;
use kalcode_contracts::permissions::{PermissionGate, PermissionMode};
use kalcode_contracts::provider_accounts::{ProviderAccount, ProviderAccountScopes};
use kalcode_contracts::threads::{ThreadMessage, ThreadStatus, ThreadSummary};
use kalcode_core::{Core, ErrorCategory, IpcError, KalError};
use kalcode_permissions::{PermissionService, ThreadModeStore};
use kalcode_providers::accounts::AccountStore;
use kalcode_providers::health::observe::ObservedProvider;
use kalcode_providers::managed::ManagedProfiles;
use kalcode_providers::model::{AdapterState, ProviderStatus};
use kalcode_providers::{ClaudeCodeProvider, CodexProvider, DetectEnv, GeminiProvider};
use kalcode_threads::{
    CoreWorkspaces, CreateThread, ProviderRegistry, StreamId, ThreadOptions, ThreadRuntime,
    ToolCallRecord,
};
use tauri::ipc::Channel;
use tauri::{State, Webview};

use crate::AppState;
use crate::provider_auth_commands::ProviderRuntimeAuthority;
use crate::provider_commands::detect_and_record;
use crate::resource_commands::ResourceAdmissionProvider;

/// Detection results (Z2) that decide which providers threads may use.
type Detection = kalcode_providers::ProviderRegistry;

/// The thread runtime as the permission engine's `ThreadModeStore` (Z4). Bound after the runtime
/// starts (the runtime holds the engine as its gate, so the engine can't hold the runtime
/// strongly). Until then, and if the runtime is gone, threads can't be found or changed.
#[derive(Default)]
pub struct ThreadModes {
    runtime: OnceLock<Weak<ThreadRuntime>>,
}

impl ThreadModes {
    fn bind(&self, runtime: &Arc<ThreadRuntime>) {
        let _ = self.runtime.set(Arc::downgrade(runtime));
    }

    fn runtime(&self) -> kalcode_core::Result<Arc<ThreadRuntime>> {
        self.runtime.get().and_then(Weak::upgrade).ok_or_else(|| {
            KalError::internal(
                "threads_unavailable",
                "KalCode's thread runtime isn't available.",
            )
        })
    }
}

impl ThreadModeStore for ThreadModes {
    fn thread(&self, thread_id: &str) -> kalcode_core::Result<Option<ThreadSummary>> {
        match self.runtime()?.get(thread_id) {
            Ok(thread) => Ok(Some(thread)),
            Err(error) if error.code == "thread_not_found" => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn set_mode(
        &self,
        thread_id: &str,
        mode: PermissionMode,
        profile_id: Option<&str>,
    ) -> kalcode_core::Result<ThreadSummary> {
        self.runtime()?
            .set_permission_mode(thread_id, mode, profile_id)
    }

    fn custom_profile_id(&self, thread_id: &str) -> Option<String> {
        self.runtime()
            .ok()?
            .permission_profile_id(thread_id)
            .ok()
            .flatten()
    }
}

/// Thread runtime state for the shell. `runtime` is `None` when the core or the permission
/// engine failed to start: threads never run without the engine deciding their actions.
pub struct ThreadsState {
    resources: Arc<crate::resource_commands::ResourceGovernorState>,
    routes: crate::provider_pane_commands::PaneRoutes,
    health: Option<Arc<kalcode_providers::HealthMonitor>>,
    runtime: Option<Arc<ThreadRuntime>>,
    permissions: Option<Arc<PermissionService>>,
    /// Adapters offered to threads: exactly the providers detection reports usable.
    providers: Arc<ProviderRegistry>,
    detection: Arc<Detection>,
    provider_runtime: Option<ProviderRuntimeAuthority>,
    /// One live stream per webview; a new `thread_stream` call replaces the previous one.
    streams: Mutex<HashMap<String, StreamId>>,
}

/// The native adapter for a provider (Claude Code, Codex, Gemini CLI), observed by Provider
/// Health (PROVIDERS-2) so its sessions feed the health model.
struct AccountBoundProvider {
    inner: Arc<dyn AgentProvider>,
    accounts: AccountStore,
    profiles: ManagedProfiles,
    runtime: Option<ProviderRuntimeAuthority>,
    /// Debug and E2E fixtures may intentionally exercise the pre-account runtime contract. This
    /// is always false in shipped builds because its caller uses `TEST_HOOKS_ENABLED`.
    allow_unbound_test_fixture: bool,
}

impl AccountBoundProvider {
    #[cfg(test)]
    fn new(
        inner: Arc<dyn AgentProvider>,
        accounts: AccountStore,
        profiles: ManagedProfiles,
        allow_unbound_test_fixture: bool,
    ) -> Self {
        Self {
            inner,
            accounts,
            profiles,
            runtime: None,
            allow_unbound_test_fixture,
        }
    }

    fn managed(
        inner: Arc<dyn AgentProvider>,
        runtime: ProviderRuntimeAuthority,
        allow_unbound_test_fixture: bool,
    ) -> Self {
        Self {
            inner,
            accounts: runtime.account_store(),
            profiles: runtime.managed_profiles(),
            runtime: Some(runtime),
            allow_unbound_test_fixture,
        }
    }
}

impl AgentProvider for AccountBoundProvider {
    fn id(&self) -> ProviderId {
        self.inner.id()
    }

    fn display_name(&self) -> &str {
        self.inner.display_name()
    }

    fn detect(&self) -> ProviderDetection {
        self.inner.detect()
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.inner.capabilities()
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        let account_id = match config.provider_account_id.as_deref() {
            Some(account_id) if kalcode_contracts::ids::is_valid_id(account_id) => {
                account_id.to_owned()
            }
            Some(_) => return Err(ProviderError::NotAuthenticated),
            None if self.allow_unbound_test_fixture => {
                return self.inner.start_session(config, sink);
            }
            None => return Err(ProviderError::NotAuthenticated),
        };
        let provider_id = self.inner.id();
        if let Some(runtime) = &self.runtime {
            runtime.prepare_account_launch(&provider_id, &account_id)?;
        }
        self.accounts.launch_with_active_account(
            &self.profiles,
            provider_id.as_str(),
            &account_id,
            |_| self.inner.start_session(config, sink),
        )
    }
}

/// Account-selecting headless adapter. Detection/capability metadata comes from the ordinary
/// provider adapter, but every real start constructs an account-isolated managed adapter.
struct ManagedHeadlessProvider {
    id: ProviderId,
    display_name: String,
    detection: ProviderDetection,
    capabilities: ProviderCapabilities,
    runtime: ProviderRuntimeAuthority,
    /// Debug/E2E-only unmanaged fixture. Production builds never construct this adapter.
    test_fixture: Option<Arc<dyn AgentProvider>>,
}

impl AgentProvider for ManagedHeadlessProvider {
    fn id(&self) -> ProviderId {
        self.id.clone()
    }

    fn display_name(&self) -> &str {
        &self.display_name
    }

    fn detect(&self) -> ProviderDetection {
        self.detection.clone()
    }

    fn capabilities(&self) -> ProviderCapabilities {
        self.capabilities.clone()
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        let Some(account_id) = config.provider_account_id.as_deref() else {
            if let Some(fixture) = &self.test_fixture {
                return fixture.start_session(config, sink);
            }
            return Err(ProviderError::NotAuthenticated);
        };
        self.runtime
            .managed_headless_provider(&self.id, account_id)?
            .start_session(config, sink)
    }
}

fn adapter(
    status: &ProviderStatus,
    runtime: ProviderRuntimeAuthority,
    routes: &crate::provider_pane_commands::PaneRoutes,
    health: Option<&Arc<kalcode_providers::HealthMonitor>>,
    resources: Arc<crate::resource_commands::ResourceGovernorState>,
) -> Option<Arc<dyn AgentProvider>> {
    let id = &status.id;
    let detection = status.detection.clone()?;
    let test_fixture: Option<Arc<dyn AgentProvider>> = if crate::environment::TEST_HOOKS_ENABLED {
        match id.as_str() {
            ProviderId::CLAUDE_CODE => {
                Some(Arc::new(ClaudeCodeProvider::new(DetectEnv::from_process())))
            }
            ProviderId::CODEX => Some(Arc::new(CodexProvider::new(DetectEnv::from_process()))),
            ProviderId::GEMINI_CLI => {
                Some(Arc::new(GeminiProvider::new(DetectEnv::from_process())))
            }
            _ => return None,
        }
    } else {
        None
    };
    let headless: Arc<dyn AgentProvider> = Arc::new(ManagedHeadlessProvider {
        id: id.clone(),
        display_name: status.display_name.clone(),
        detection,
        capabilities: status.capabilities.clone(),
        runtime: runtime.clone(),
        test_fixture,
    });
    let adapter: Arc<dyn AgentProvider> = match id.as_str() {
        // Z7-W4: the per-thread runtime router when provider panes are enabled.
        ProviderId::CLAUDE_CODE => routes.route_claude(headless),
        ProviderId::CODEX => routes.route_cli(ProviderId::CODEX, headless),
        ProviderId::GEMINI_CLI => routes.route_cli(ProviderId::GEMINI_CLI, headless),
        _ => return None,
    };
    let observed = ObservedProvider::wrap(adapter, health);
    let governed = ResourceAdmissionProvider::wrap(observed, resources);
    Some(Arc::new(AccountBoundProvider::managed(
        governed,
        runtime,
        crate::environment::TEST_HOOKS_ENABLED,
    )))
}

impl ThreadsState {
    /// Starts the thread runtime over `core`.
    ///
    /// - Providers (Z2): adapters are registered from `detection` by [`Self::sync_providers`],
    ///   so a thread can only use a provider that is installed at a supported version, not
    ///   known to be signed out, and has a KalCode adapter (today: Claude Code).
    /// - Workspaces (Z1): [`CoreWorkspaces`] over the workspaces table (canonical roots).
    /// - Permissions (Z4): the permission engine is the runtime's `PermissionGate`: every
    ///   action a provider asks about is evaluated (allow, deny, or an approval request the
    ///   user answers), decisions arrive back as `approval.*` events by request id, and a
    ///   stopped thread's pending requests expire. `modes` is bound to the runtime so the
    ///   engine can read and change thread modes. Without the engine, threads don't start.
    // Keep account-owned startup dependencies explicit at the runtime composition boundary.
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        core: Option<&Arc<Core>>,
        detection: Arc<Detection>,
        permissions: Option<Arc<PermissionService>>,
        modes: &ThreadModes,
        provider_runtime: Option<ProviderRuntimeAuthority>,
        routes: crate::provider_pane_commands::PaneRoutes,
        health: Option<Arc<kalcode_providers::HealthMonitor>>,
        resources: Arc<crate::resource_commands::ResourceGovernorState>,
    ) -> Self {
        let providers = Arc::new(ProviderRegistry::new());
        let runtime = match (core, &permissions) {
            (Some(core), Some(service)) => {
                let gate: Arc<dyn PermissionGate> = service.clone();
                match ThreadRuntime::new(
                    core.clone(),
                    Arc::clone(&providers),
                    Arc::new(CoreWorkspaces::new(core.clone())),
                    gate,
                ) {
                    Ok(runtime) => Some(Arc::new(runtime)),
                    Err(error) => {
                        tracing::error!(event = "threads.start_failed", error_code = error.code, error = %error.diagnostic());
                        None
                    }
                }
            }
            (Some(_), None) => {
                tracing::error!(
                    event = "threads.start_failed",
                    reason = "permission_engine_unavailable"
                );
                None
            }
            (None, _) => None,
        };
        if let Some(runtime) = &runtime {
            modes.bind(runtime);
        }
        let state = Self {
            resources,
            routes,
            health,
            runtime,
            permissions,
            providers,
            detection,
            provider_runtime,
            streams: Mutex::new(HashMap::new()),
        };
        state.sync_providers();
        state
    }

    /// Registers the adapter of every provider detection reports usable and unregisters the
    /// rest. Threads already running keep their sessions. Uses the cached detection.
    pub fn sync_providers(&self) {
        let usable = self.detection.usable();
        for status in self.detection.list() {
            if status.adapter != AdapterState::Implemented {
                continue;
            }
            if usable.contains(&status.id) {
                if self.providers.get(&status.id).is_none()
                    && let Some(runtime) = &self.provider_runtime
                    && let Some(provider) = adapter(
                        &status,
                        runtime.clone(),
                        &self.routes,
                        self.health.as_ref(),
                        self.resources.clone(),
                    )
                {
                    self.providers.register(provider);
                    tracing::info!(
                        event = "threads.provider_registered",
                        provider_id = status.id.as_str()
                    );
                }
            } else if self.providers.unregister(&status.id) {
                tracing::info!(
                    event = "threads.provider_unregistered",
                    provider_id = status.id.as_str()
                );
            }
        }
    }

    /// Before the first thread operation of a session, detects providers once (read-only:
    /// `--version` and the documented sign-in status command, never a prompt) so the runtime
    /// offers the real set. Later changes arrive through `providers_detect`.
    pub(crate) fn ensure_providers(&self, core: Option<&Arc<Core>>) {
        let never_detected = self
            .detection
            .list()
            .iter()
            .all(|status| status.detection.is_none());
        if never_detected {
            detect_and_record(core, &self.detection);
            self.sync_providers();
        }
    }

    /// Refuses to forget a workspace while one of its threads may still have a provider
    /// session (anything but completed, failed, interrupted or offline).
    pub fn refuse_if_threads_open(&self, workspace_id: &str) -> Result<(), IpcError> {
        let Some(runtime) = &self.runtime else {
            return Ok(());
        };
        let threads = runtime
            .list(Some(workspace_id), false)
            .map_err(|e| e.log_and_convert("workspace_remove"))?;
        let open = threads.iter().any(|t| {
            !matches!(
                t.status,
                ThreadStatus::Completed
                    | ThreadStatus::Failed
                    | ThreadStatus::Interrupted
                    | ThreadStatus::Offline
            )
        });
        if open {
            return Err(KalError::validation(
                "threads_running",
                "Stop this workspace's threads before removing it.",
            )
            .to_ipc());
        }
        Ok(())
    }

    /// The running thread runtime, for KalVoice's thread commands (Z12).
    pub fn runtime_handle(&self) -> Option<Arc<ThreadRuntime>> {
        self.runtime.clone()
    }

    pub(crate) fn runtime(&self) -> Result<&Arc<ThreadRuntime>, IpcError> {
        self.runtime.as_ref().ok_or_else(|| {
            KalError::internal(
                "threads_unavailable",
                "KalCode's thread runtime isn't available. Restart KalCode; if this keeps happening, export diagnostics.",
            )
            .to_ipc()
        })
    }

    /// Drops the live stream held by `label` (its page reloaded or closed).
    pub fn drop_stream(&self, label: &str) {
        let removed = self
            .streams
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(label);
        if let (Some(id), Some(runtime)) = (removed, &self.runtime) {
            runtime.unsubscribe_stream(id);
        }
    }

    /// Ends every running session. `Ok` proves every provider accepted termination.
    pub fn shutdown_checked(&self) -> kalcode_core::Result<()> {
        self.runtime
            .as_ref()
            .map_or(Ok(()), |runtime| runtime.shutdown_checked())
    }

    /// Compatibility wrapper for callers that cannot surface shutdown failure yet.
    pub fn shutdown(&self) {
        if let Err(error) = self.shutdown_checked() {
            tracing::error!(
                event = "threads_state.shutdown_incomplete",
                error = %error.diagnostic()
            );
        }
    }
}

fn required(value: Option<String>, code: &'static str, message: &str) -> Result<String, IpcError> {
    value.ok_or_else(|| KalError::validation(code, message).to_ipc())
}

fn require_prompt_review_window_label(label: &str) -> Result<(), IpcError> {
    if label == "main" {
        Ok(())
    } else {
        Err(KalError::new(
            ErrorCategory::Permission,
            "thread_prompt_review_owner_invalid",
            "Prompt review is available only in the main KalCode window.",
        )
        .to_ipc())
    }
}

fn require_prompt_review_webview(webview: &Webview) -> Result<(), IpcError> {
    require_prompt_review_window_label(webview.label())
}

fn validate_create_controls(
    permission_mode: PermissionMode,
    confirm_bypass: Option<bool>,
    profile_id: Option<&str>,
) -> Result<(), IpcError> {
    if profile_id.is_some_and(|id| !kalcode_contracts::ids::is_valid_id(id)) {
        return Err(KalError::validation(
            "invalid_profile",
            "That permission profile isn't valid.",
        )
        .to_ipc());
    }
    if permission_mode == PermissionMode::Bypass && confirm_bypass != Some(true) {
        return Err(KalError::validation(
            "bypass_not_confirmed",
            "Bypass needs your explicit confirmation.",
        )
        .to_ipc());
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn resolved_create_request(
    core: &Arc<Core>,
    provider_id: String,
    provider_account_id: Option<String>,
    workspace_id: String,
    model: Option<String>,
    permission_mode: PermissionMode,
    prompt: String,
    name: Option<String>,
) -> kalcode_core::Result<CreateThread> {
    let account = resolve_creation_account(
        core,
        &provider_id,
        &workspace_id,
        provider_account_id.as_deref(),
        None,
    )?;
    Ok(CreateThread {
        provider_id,
        provider_account_id: account.as_ref().map(|account| account.id.clone()),
        account_label: account.map(|account| account.display_name),
        workspace_id,
        model,
        permission_mode,
        prompt,
        name,
    })
}

fn validate_optional_prompt_review(
    text: Option<&str>,
    prompt_review_id: Option<&str>,
) -> Result<(), IpcError> {
    if prompt_review_id.is_some() && text.is_none_or(|text| text.trim().is_empty()) {
        return Err(KalError::validation(
            "prompt_review_without_prompt",
            "A prompt confirmation can only be used with the exact reviewed message.",
        )
        .to_ipc());
    }
    Ok(())
}

/// Resolves the account snapshot for a new provider session. Explicit ids take precedence over
/// an owner-visible label query; otherwise workspace bindings and the provider default apply.
/// Account credentials and profile locations never cross this boundary.
pub(crate) fn resolve_creation_account(
    core: &Arc<Core>,
    provider_id: &str,
    workspace_id: &str,
    explicit_id: Option<&str>,
    account_label_query: Option<&str>,
) -> kalcode_core::Result<Option<ProviderAccount>> {
    resolve_creation_account_with_test_policy(
        core,
        provider_id,
        workspace_id,
        explicit_id,
        account_label_query,
        crate::environment::TEST_HOOKS_ENABLED,
    )
}

fn resolve_creation_account_with_test_policy(
    core: &Arc<Core>,
    provider_id: &str,
    workspace_id: &str,
    explicit_id: Option<&str>,
    account_label_query: Option<&str>,
    allow_empty_test_fixture: bool,
) -> kalcode_core::Result<Option<ProviderAccount>> {
    let store = AccountStore::new(core.clone());
    if let Some(account_id) = explicit_id {
        let account = store.get(account_id)?;
        return validate_creation_account(account, provider_id).map(Some);
    }

    if let Some(query) = account_label_query {
        let query = query.trim();
        if query.is_empty() {
            return Err(KalError::validation(
                "provider_account_query_invalid",
                "Choose a connected provider account.",
            ));
        }
        let folded = query.to_lowercase();
        let mut matches = store
            .list(Some(provider_id))?
            .into_iter()
            .filter(|account| account.display_name.to_lowercase() == folded);
        let Some(account) = matches.next() else {
            return Err(KalError::validation(
                "provider_account_not_found",
                "That provider account isn't connected. Open Providers to connect or choose an account.",
            ));
        };
        if matches.next().is_some() {
            return Err(KalError::validation(
                "provider_account_ambiguous",
                "More than one provider account matches that label. Choose the account explicitly.",
            ));
        }
        return Ok(Some(account));
    }

    let scopes = ProviderAccountScopes {
        workspace_id: Some(workspace_id.to_owned()),
        ..ProviderAccountScopes::default()
    };
    if let Some(account) = store.resolve(provider_id, &scopes)? {
        return Ok(Some(account));
    }

    // Debug/E2E fixtures predate managed provider accounts. This exception is compiled out of
    // shipped builds and only applies when that provider has no account metadata at all.
    if allow_empty_test_fixture && store.list(Some(provider_id))?.is_empty() {
        return Ok(None);
    }
    Err(KalError::validation(
        "provider_account_required",
        "Connect an account for this provider in Providers before starting a thread.",
    ))
}

fn validate_creation_account(
    account: ProviderAccount,
    provider_id: &str,
) -> kalcode_core::Result<ProviderAccount> {
    if account.provider_id.as_str() != provider_id {
        return Err(KalError::validation(
            "provider_account_mismatch",
            "That account belongs to a different provider.",
        ));
    }
    if account.archived_at.is_some() {
        return Err(KalError::validation(
            "provider_account_archived",
            "That account was removed from KalCode. Reconnect it or choose an active account.",
        ));
    }
    Ok(account)
}

#[tauri::command(async)]
pub fn thread_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    workspace_id: Option<String>,
    include_archived: Option<bool>,
) -> Result<Vec<ThreadSummary>, IpcError> {
    _runtime_access.revalidate()?;
    state
        .runtime()?
        .list(workspace_id.as_deref(), include_archived.unwrap_or(false))
        .map_err(|e| e.log_and_convert("thread_list"))
}

#[tauri::command(async)]
pub fn thread_get(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    state
        .runtime()?
        .get(&thread_id)
        .map_err(|e| e.log_and_convert("thread_get"))
}

#[tauri::command(async)]
pub fn thread_messages(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
    limit: u32,
    before: Option<String>,
) -> Result<Vec<ThreadMessage>, IpcError> {
    _runtime_access.revalidate()?;
    state
        .runtime()?
        .messages(&thread_id, limit, before.as_deref())
        .map_err(|e| e.log_and_convert("thread_messages"))
}

#[tauri::command(async)]
pub fn thread_tool_calls(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
    limit: u32,
) -> Result<Vec<ToolCallRecord>, IpcError> {
    _runtime_access.revalidate()?;
    state
        .runtime()?
        .tool_calls(&thread_id, limit)
        .map_err(|e| e.log_and_convert("thread_tool_calls"))
}

#[tauri::command(async)]
pub fn thread_options(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
) -> Result<ThreadOptions, IpcError> {
    _runtime_access.revalidate()?;
    state.ensure_providers(app.core.as_ref());
    let mut options = state
        .runtime()?
        .options()
        .map_err(|e| e.log_and_convert("thread_options"))?;
    // New threads start in the user's default mode (Settings → Permissions) when it can be
    // chosen at creation; Bypass and Custom are set on the thread afterwards, with confirmation.
    if let Some(default) = state
        .permissions
        .as_ref()
        .and_then(|service| service.settings().ok())
        .map(|settings| settings.default_mode)
        .filter(|mode| options.permission_modes.contains(mode))
    {
        options.default_permission_mode = default;
    }
    Ok(options)
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn thread_review_create_prompt(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    app: State<'_, AppState>,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    provider_id: String,
    provider_account_id: Option<String>,
    workspace_id: String,
    model: Option<String>,
    permission_mode: PermissionMode,
    prompt: String,
    name: Option<String>,
    confirm_bypass: Option<bool>,
    profile_id: Option<String>,
) -> Result<PromptReview, IpcError> {
    _runtime_access.revalidate()?;
    require_prompt_review_webview(&webview)?;
    validate_create_controls(permission_mode, confirm_bypass, profile_id.as_deref())?;
    let request = resolved_create_request(
        app.core()?,
        provider_id,
        provider_account_id,
        workspace_id,
        model,
        permission_mode,
        prompt,
        name,
    )
    .map_err(|error| error.log_and_convert("thread_review_create_prompt_account"))?;
    state
        .runtime()?
        .review_create_prompt(&request)
        .map_err(|error| error.log_and_convert("thread_review_create_prompt"))
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn thread_create(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    provider_id: String,
    provider_account_id: Option<String>,
    workspace_id: String,
    model: Option<String>,
    permission_mode: PermissionMode,
    prompt: String,
    name: Option<String>,
    // CA-1 contract additions. Accepted and validated; the runtime still refuses Bypass and
    // Custom at creation (they are set afterwards through `thread_set_permission_mode`, with
    // `confirmBypass` / `profileId`), so neither changes behaviour yet.
    confirm_bypass: Option<bool>,
    profile_id: Option<String>,
    prompt_review_id: Option<String>,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    validate_create_controls(permission_mode, confirm_bypass, profile_id.as_deref())?;
    let request = resolved_create_request(
        app.core()?,
        provider_id,
        provider_account_id,
        workspace_id,
        model,
        permission_mode,
        prompt,
        name,
    )
    .map_err(|error| error.log_and_convert("thread_create_account"))?;
    state.ensure_providers(app.core.as_ref());
    state
        .runtime()?
        .create_reviewed(request, prompt_review_id.as_deref())
        .map_err(|e| e.log_and_convert("thread_create"))
}

#[tauri::command(async)]
pub fn thread_review_prompt(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
    text: Option<String>,
) -> Result<PromptReview, IpcError> {
    _runtime_access.revalidate()?;
    require_prompt_review_webview(&webview)?;
    let text = required(text, "invalid_prompt", "Write a message first.")?;
    state
        .runtime()?
        .review_thread_prompt(&thread_id, &text)
        .map_err(|error| error.log_and_convert("thread_review_prompt"))
}

#[tauri::command(async)]
pub fn thread_cancel_prompt_review(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    review_id: String,
) -> Result<bool, IpcError> {
    _runtime_access.revalidate()?;
    require_prompt_review_webview(&webview)?;
    state
        .runtime()?
        .cancel_prompt_review(&review_id)
        .map_err(|error| error.log_and_convert("thread_cancel_prompt_review"))
}

#[tauri::command(async)]
pub fn thread_send(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
    text: Option<String>,
    prompt_review_id: Option<String>,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    let text = required(text, "invalid_prompt", "Write a message first.")?;
    state
        .runtime()?
        .send_reviewed(&thread_id, &text, prompt_review_id.as_deref())
        .map_err(|e| e.log_and_convert("thread_send"))
}

#[tauri::command(async)]
pub fn thread_interrupt(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    state
        .runtime()?
        .interrupt(&thread_id)
        .map_err(|e| e.log_and_convert("thread_interrupt"))
}

#[tauri::command(async)]
pub fn thread_resume(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
    text: Option<String>,
    prompt_review_id: Option<String>,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    validate_optional_prompt_review(text.as_deref(), prompt_review_id.as_deref())?;
    state.ensure_providers(app.core.as_ref());
    state
        .runtime()?
        .resume_reviewed(&thread_id, text.as_deref(), prompt_review_id.as_deref())
        .map_err(|e| e.log_and_convert("thread_resume"))
}

#[tauri::command(async)]
pub fn thread_stop(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    state
        .runtime()?
        .stop(&thread_id)
        .map_err(|e| e.log_and_convert("thread_stop"))
}

#[tauri::command(async)]
pub fn thread_rename(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
    name: Option<String>,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    let name = required(name, "invalid_name", "Give the thread a name.")?;
    state
        .runtime()?
        .rename(&thread_id, &name)
        .map_err(|e| e.log_and_convert("thread_rename"))
}

#[tauri::command(async)]
pub fn thread_archive(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    state
        .runtime()?
        .archive(&thread_id)
        .map_err(|e| e.log_and_convert("thread_archive"))
}

/// Streams a thread's live message deltas to the calling webview. Each webview holds one
/// stream: subscribing to another thread replaces it, and a page (re)load drops it.
#[tauri::command(async)]
pub fn thread_stream(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
    on_event: Channel<AgentEvent>,
) -> Result<StreamId, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?;
    let id = runtime
        .subscribe_stream(&thread_id, move |event| {
            on_event.send(event.clone()).is_ok()
        })
        .map_err(|e| e.log_and_convert("thread_stream"))?;
    let previous = state
        .streams
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(webview.label().to_owned(), id);
    if let Some(previous) = previous {
        runtime.unsubscribe_stream(previous);
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    use kalcode_contracts::agent::{
        AgentEventSink, AgentSession, AuthState, DetectionState, ProviderCapabilities,
        ProviderDetection, ProviderError, SessionConfig,
    };
    use kalcode_contracts::permissions::PermissionMode;
    use kalcode_contracts::provider_accounts::ProviderAccountBindingKind;
    use kalcode_core::flags::BuildChannel;
    use kalcode_core::{CoreConfig, Paths};
    use kalcode_providers::accounts::AccountStore;
    use kalcode_providers::managed::ManagedProfiles;

    #[derive(Default)]
    struct StartSpy {
        starts: Mutex<Vec<SessionConfig>>,
    }

    impl StartSpy {
        fn starts(&self) -> Vec<SessionConfig> {
            self.starts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
    }

    impl AgentProvider for StartSpy {
        fn id(&self) -> ProviderId {
            ProviderId::new(ProviderId::CODEX)
        }

        fn display_name(&self) -> &str {
            "Start spy"
        }

        fn detect(&self) -> ProviderDetection {
            ProviderDetection {
                provider_id: self.id(),
                display_name: self.display_name().into(),
                state: DetectionState::Installed,
                display_path: None,
                version: None,
                minimum_version: None,
                auth: AuthState::Authenticated,
                message: None,
                checked_at: String::new(),
            }
        }

        fn capabilities(&self) -> ProviderCapabilities {
            kalcode_providers::catalog::codex_capabilities()
        }

        fn start_session(
            &self,
            config: SessionConfig,
            _sink: Box<dyn AgentEventSink>,
        ) -> Result<Box<dyn AgentSession>, ProviderError> {
            self.starts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(config);
            Err(ProviderError::Unsupported)
        }
    }

    fn session_config(provider_account_id: Option<String>) -> SessionConfig {
        SessionConfig {
            thread_id: kalcode_contracts::ids::new_id(),
            workspace_id: kalcode_contracts::ids::new_id(),
            provider_account_id,
            working_directory: std::env::temp_dir().to_string_lossy().into_owned(),
            model: None,
            permission_mode: PermissionMode::Approve,
            resume_session_id: None,
            secret_ref: None,
        }
    }

    #[test]
    fn production_adapter_refuses_unbound_or_invalid_accounts_without_calling_provider() {
        let fixture = AccountFixture::new();
        let inner = Arc::new(StartSpy::default());
        let provider = AccountBoundProvider::new(
            inner.clone(),
            fixture.store.clone(),
            fixture.profiles.clone(),
            false,
        );

        for account in [None, Some("not-a-kalcode-id".to_owned())] {
            assert_eq!(
                provider
                    .start_session(session_config(account), Box::new(|_: AgentEvent| {}))
                    .err(),
                Some(ProviderError::NotAuthenticated)
            );
        }
        assert!(inner.starts().is_empty());
    }

    #[test]
    fn production_adapter_preserves_bound_account_for_the_inner_provider() {
        let fixture = AccountFixture::new();
        let inner = Arc::new(StartSpy::default());
        let provider = AccountBoundProvider::new(
            inner.clone(),
            fixture.store.clone(),
            fixture.profiles.clone(),
            false,
        );
        let account_id = fixture
            .store
            .create("codex", "Personal")
            .expect("account")
            .id;
        let config = session_config(Some(account_id.clone()));

        assert_eq!(
            provider
                .start_session(config.clone(), Box::new(|_: AgentEvent| {}))
                .err(),
            Some(ProviderError::Unsupported)
        );
        assert_eq!(inner.starts(), vec![config]);
        assert_eq!(
            inner.starts()[0].provider_account_id.as_deref(),
            Some(account_id.as_str())
        );
    }

    #[test]
    fn explicit_test_fixture_policy_allows_an_unbound_provider() {
        let fixture = AccountFixture::new();
        let inner = Arc::new(StartSpy::default());
        let provider = AccountBoundProvider::new(
            inner.clone(),
            fixture.store.clone(),
            fixture.profiles.clone(),
            true,
        );
        let config = session_config(None);

        assert_eq!(
            provider
                .start_session(config.clone(), Box::new(|_: AgentEvent| {}))
                .err(),
            Some(ProviderError::Unsupported)
        );
        assert_eq!(inner.starts(), vec![config]);
    }

    #[test]
    fn production_adapter_rejects_archived_and_cross_provider_accounts_before_delegation() {
        let fixture = AccountFixture::new();
        let inner = Arc::new(StartSpy::default());
        let provider = AccountBoundProvider::new(
            inner.clone(),
            fixture.store.clone(),
            fixture.profiles.clone(),
            false,
        );
        let archived = fixture.store.create("codex", "Old").expect("codex");
        fixture
            .store
            .archive(&fixture.profiles, &archived.id)
            .expect("archive");
        let gemini = fixture
            .store
            .create("gemini-cli", "School")
            .expect("gemini");

        for account_id in [archived.id, gemini.id] {
            assert!(matches!(
                provider
                    .start_session(
                        session_config(Some(account_id)),
                        Box::new(|_: AgentEvent| {})
                    )
                    .err(),
                Some(ProviderError::Start(_))
            ));
        }
        assert!(inner.starts().is_empty());
    }

    struct AccountFixture {
        _temp: tempfile::TempDir,
        core: Arc<Core>,
        store: AccountStore,
        profiles: ManagedProfiles,
        workspace_id: String,
    }

    impl AccountFixture {
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
            let workspace_id = kalcode_contracts::ids::new_id();
            core.transact(|tx| {
                let root_path = temp_root.join("workspace").display().to_string();
                let now = kalcode_core::time::now_rfc3339();
                tx.execute(
                    "INSERT INTO workspaces (
                       id, name, root_path, created_at, last_opened_at
                     ) VALUES (?1, 'Fixture', ?2, ?3, ?3)",
                    (&workspace_id, &root_path, &now),
                )?;
                Ok(((), Vec::new()))
            })
            .expect("workspace fixture");
            let profiles = ManagedProfiles::for_data_dir(&temp_root).expect("managed profiles");
            Self {
                _temp: temp,
                store: AccountStore::new(core.clone()),
                core,
                profiles,
                workspace_id,
            }
        }

        fn resolve(
            &self,
            provider_id: &str,
            explicit_id: Option<&str>,
            account_label_query: Option<&str>,
        ) -> kalcode_core::Result<Option<kalcode_contracts::provider_accounts::ProviderAccount>>
        {
            resolve_creation_account_with_test_policy(
                &self.core,
                provider_id,
                &self.workspace_id,
                explicit_id,
                account_label_query,
                false,
            )
        }
    }

    #[test]
    fn creation_account_uses_explicit_then_workspace_then_provider_default() {
        let fixture = AccountFixture::new();
        let personal = fixture.store.create("codex", "Personal").expect("personal");
        let work = fixture.store.create("codex", "Work").expect("work");
        fixture
            .store
            .bind(
                "codex",
                ProviderAccountBindingKind::Workspace,
                &fixture.workspace_id,
                &work.id,
            )
            .expect("workspace binding");

        assert_eq!(
            fixture
                .resolve("codex", None, None)
                .expect("workspace account")
                .expect("selected")
                .id,
            work.id
        );
        assert_eq!(
            fixture
                .resolve("codex", Some(&personal.id), None)
                .expect("explicit account")
                .expect("selected")
                .id,
            personal.id
        );
        assert_eq!(
            fixture
                .resolve("codex", None, Some(" personal "))
                .expect("label account")
                .expect("selected")
                .id,
            personal.id
        );
        fixture
            .store
            .unbind(
                "codex",
                ProviderAccountBindingKind::Workspace,
                &fixture.workspace_id,
            )
            .expect("unbind workspace");
        assert_eq!(
            fixture
                .resolve("codex", None, None)
                .expect("provider default")
                .expect("selected")
                .id,
            personal.id
        );
    }

    #[test]
    fn creation_account_rejects_cross_provider_and_archived_explicit_ids() {
        let fixture = AccountFixture::new();
        let gemini = fixture
            .store
            .create("gemini-cli", "School")
            .expect("gemini");
        assert_eq!(
            fixture
                .resolve("codex", Some(&gemini.id), None)
                .expect_err("cross-provider account")
                .code,
            "provider_account_mismatch"
        );

        let codex = fixture.store.create("codex", "Old").expect("codex");
        fixture
            .store
            .archive(&fixture.profiles, &codex.id)
            .expect("archive");
        assert_eq!(
            fixture
                .resolve("codex", Some(&codex.id), None)
                .expect_err("archived account")
                .code,
            "provider_account_archived"
        );
    }

    #[test]
    fn creation_account_label_query_is_exact_and_ambiguity_fails_closed() {
        let fixture = AccountFixture::new();
        fixture.store.create("codex", "Äccount").expect("upper");
        fixture.store.create("codex", "äccount").expect("lower");
        assert_eq!(
            fixture
                .resolve("codex", None, Some("ÄCCOUNT"))
                .expect_err("ambiguous case-folded label")
                .code,
            "provider_account_ambiguous"
        );
        assert_eq!(
            fixture
                .resolve("codex", None, Some("missing"))
                .expect_err("unknown label")
                .code,
            "provider_account_not_found"
        );
    }

    #[test]
    fn production_account_resolution_requires_a_connected_account() {
        let fixture = AccountFixture::new();
        assert_eq!(
            fixture
                .resolve("codex", None, None)
                .expect_err("account required")
                .code,
            "provider_account_required"
        );
    }

    #[test]
    fn prompt_review_is_main_window_only_and_resume_ids_require_a_prompt() {
        require_prompt_review_window_label("main").expect("main window");
        for label in ["provider-codex", "browser-1-untrusted"] {
            assert_eq!(
                require_prompt_review_window_label(label)
                    .expect_err("untrusted webview")
                    .code,
                "thread_prompt_review_owner_invalid"
            );
        }

        validate_optional_prompt_review(Some("continue"), Some("opaque-review"))
            .expect("review with prompt");
        validate_optional_prompt_review(None, None).expect("resume without prompt or review");
        for text in [None, Some(""), Some("   ")] {
            assert_eq!(
                validate_optional_prompt_review(text, Some("opaque-review"))
                    .expect_err("review without prompt")
                    .code,
                "prompt_review_without_prompt"
            );
        }
    }

    #[test]
    fn create_review_and_effect_share_the_exact_resolved_account_request() {
        let fixture = AccountFixture::new();
        let account = fixture.store.create("codex", "Work").expect("account");
        fixture
            .store
            .bind(
                "codex",
                ProviderAccountBindingKind::Workspace,
                &fixture.workspace_id,
                &account.id,
            )
            .expect("workspace binding");

        let build = || {
            resolved_create_request(
                &fixture.core,
                "codex".into(),
                None,
                fixture.workspace_id.clone(),
                Some("default".into()),
                PermissionMode::Approve,
                "review this exact prompt".into(),
                Some("Exact request".into()),
            )
            .expect("resolved create request")
        };
        let reviewed = build();
        let effected = build();
        assert_eq!(reviewed, effected);
        assert_eq!(
            reviewed.provider_account_id.as_deref(),
            Some(account.id.as_str())
        );
        assert_eq!(reviewed.account_label.as_deref(), Some("Work"));

        assert_eq!(
            validate_create_controls(PermissionMode::Bypass, None, None)
                .expect_err("bypass confirmation")
                .code,
            "bypass_not_confirmed"
        );
        validate_create_controls(PermissionMode::Bypass, Some(true), None)
            .expect("confirmed bypass request");
    }
}
