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
    AgentEvent, AgentEventSink, AgentProvider, AgentSession, AuthState, ProviderCapabilities,
    ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::context::PromptReview;
use kalcode_contracts::operations::{OperationKind, OperationSpec};
use kalcode_contracts::permissions::{PermissionGate, PermissionMode};
use kalcode_contracts::provider_accounts::{ProviderAccount, ProviderAccountScopes};
use kalcode_contracts::threads::{ThreadMessage, ThreadStatus, ThreadSummary};
use kalcode_core::{Core, ErrorCategory, IpcError, KalError};
use kalcode_permissions::{PermissionService, ThreadModeStore};
use kalcode_providers::accounts::AccountStore;
use kalcode_providers::codex::managed_policy::CloudConfigEligibility;
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

    /// Validates an Operations agent task and resolves the exact provider/account/model selection
    /// that was reviewed. This performs only read-only provider detection and metadata checks; it
    /// never starts a provider session. The queue persists this returned spec so a later launch
    /// cannot silently drift to a newly selected default account between confirmation and
    /// execution.
    pub(crate) fn canonicalize_operation(
        &self,
        core: &Arc<Core>,
        spec: &OperationSpec,
    ) -> kalcode_core::Result<OperationSpec> {
        let request = self.reviewed_operation_request(core, spec)?;
        Ok(canonical_operation_spec(spec, &request))
    }

    /// Starts a confirmed Operations agent task through the canonical thread admission path.
    /// Operations intentionally fixes the permission mode to Approve and cannot silently map
    /// unsupported scheduler fields onto provider defaults.
    pub(crate) fn start_operation(
        &self,
        core: &Arc<Core>,
        operation_id: &str,
        spec: &OperationSpec,
    ) -> kalcode_core::Result<ThreadSummary> {
        let request = self.reviewed_operation_request(core, spec)?;
        self.operation_runtime()?
            .create_reviewed_for_operation(operation_id, request, None)
    }

    fn reviewed_operation_request(
        &self,
        core: &Arc<Core>,
        spec: &OperationSpec,
    ) -> kalcode_core::Result<CreateThread> {
        self.ensure_providers(Some(core));
        let runtime = self.operation_runtime()?;
        let request = operation_request(core, runtime, spec)?;
        review_operation_prompt(runtime, &request)?;
        Ok(request)
    }

    fn operation_runtime(&self) -> kalcode_core::Result<&Arc<ThreadRuntime>> {
        self.runtime.as_ref().ok_or_else(|| {
            KalError::internal(
                "threads_unavailable",
                "KalCode's thread runtime isn't available. Restart KalCode; if this keeps happening, export diagnostics.",
            )
        })
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

fn validate_agent_operation(spec: &OperationSpec) -> kalcode_core::Result<(&str, &str)> {
    if spec.kind != OperationKind::Agent {
        return Err(KalError::validation(
            "operation_kind_unsupported",
            "Only agent tasks can start through the thread runtime.",
        ));
    }
    if spec.command.is_some() {
        return Err(KalError::validation(
            "operation_agent_command_invalid",
            "Agent tasks use a prompt and cannot also include a shell command.",
        ));
    }
    if spec.effort.is_some() {
        return Err(KalError::validation(
            "operation_effort_unsupported",
            "This KalCode build does not support effort selection for agent tasks.",
        ));
    }
    let provider_id = spec
        .provider_id
        .as_deref()
        .filter(|provider_id| !provider_id.trim().is_empty())
        .ok_or_else(|| {
            KalError::validation(
                "operation_provider_required",
                "Choose a provider for this agent task.",
            )
        })?;
    let prompt = spec
        .prompt
        .as_deref()
        .filter(|prompt| !prompt.trim().is_empty())
        .ok_or_else(|| {
            KalError::validation(
                "operation_prompt_required",
                "Enter a prompt for this agent task.",
            )
        })?;
    Ok((provider_id, prompt))
}

fn operation_request(
    core: &Arc<Core>,
    runtime: &ThreadRuntime,
    spec: &OperationSpec,
) -> kalcode_core::Result<CreateThread> {
    let (provider_id, prompt) = validate_agent_operation(spec)?;
    let provider_id = kalcode_threads::validate::provider_id(provider_id)?;
    kalcode_threads::validate::workspace_id(&spec.workspace_id)?;
    let model = kalcode_threads::validate::model(spec.model.as_deref())?;
    let options = runtime.options()?;
    let provider = options
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| {
            KalError::new(
                ErrorCategory::Provider,
                "provider_unavailable",
                format!(
                    "{} isn't connected to KalCode. Connect it in Providers, then try again.",
                    provider_id.as_str()
                ),
            )
        })?;
    if !options
        .workspaces
        .iter()
        .any(|workspace| workspace.id == spec.workspace_id)
    {
        return Err(KalError::validation(
            "workspace_not_found",
            "That workspace is no longer available in KalCode.",
        ));
    }
    if let Some(model) = &model
        && !provider.models.is_empty()
        && !provider
            .models
            .iter()
            .any(|available| &available.id == model)
    {
        return Err(KalError::validation(
            "invalid_model",
            format!("That model isn't available for {}.", provider.display_name),
        ));
    }
    resolved_create_request(
        core,
        provider_id.0,
        spec.provider_account_id.clone(),
        spec.workspace_id.clone(),
        model,
        PermissionMode::Approve,
        prompt.to_owned(),
        Some(spec.name.clone()),
    )
}

fn canonical_operation_spec(spec: &OperationSpec, request: &CreateThread) -> OperationSpec {
    let mut canonical = spec.clone();
    canonical.provider_id = Some(request.provider_id.clone());
    canonical.provider_account_id = request.provider_account_id.clone();
    canonical.model = request.model.clone();
    canonical
}

fn review_operation_prompt(
    runtime: &ThreadRuntime,
    request: &CreateThread,
) -> kalcode_core::Result<()> {
    match runtime.review_create_prompt(request)? {
        PromptReview::Clean => Ok(()),
        PromptReview::ConfirmationRequired(warning) => {
            // Do not leave an Operations-owned confirmation handle available for replay. The
            // normal Threads flow is the sole owner of prompt confirmations.
            if let Err(error) = runtime.cancel_prompt_review(&warning.review_id) {
                tracing::warn!(
                    event = "operations.agent_prompt_review_cancel_failed",
                    error_code = error.code
                );
            }
            Err(KalError::new(
                ErrorCategory::Permission,
                "operation_prompt_confirmation_required",
                "This agent task may contain sensitive information. Open it in Threads to review and start it; Operations did not launch it.",
            ))
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
        effort: None,
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

/// Explicitly rebinds a thread to another account of the same provider. Future provider
/// requests use the new account; past messages are unchanged and the provider resume id is
/// cleared (resume ids are account-scoped), so the next turn starts a fresh provider session.
/// Refused while a turn is running, starting or awaiting approval. Emits
/// `thread.account_changed` and returns the updated summary.
#[tauri::command(async)]
pub fn thread_rebind_account(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
    provider_account_id: String,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?;
    // The cached plan truth only: a rebind never refreshes or signs in (that happens at launch).
    let codex_plan = |account_id: &str| {
        state
            .provider_runtime
            .as_ref()
            .and_then(|authority| authority.codex_cloud_config(account_id).ok())
    };
    rebind_thread_account(
        app.core()?,
        runtime,
        &thread_id,
        &provider_account_id,
        codex_plan,
    )
    .map_err(|error| error.log_and_convert("thread_rebind_account"))
}

/// Validates what the thread runtime can't see, then rebinds. Order (mirrored by the memory
/// transport): archived thread; account id, existence, provider and removal; the current
/// account is a no-op; sign-in state (`not_authenticated` refused, `unknown` allowed because
/// launch re-checks); a cached Codex organization plan; then the runtime's busy checks.
fn rebind_thread_account(
    core: &Arc<Core>,
    runtime: &ThreadRuntime,
    thread_id: &str,
    account_id: &str,
    codex_plan: impl Fn(&str) -> Option<CloudConfigEligibility>,
) -> kalcode_core::Result<ThreadSummary> {
    let thread = runtime.get(thread_id)?;
    if thread.archived_at.is_some() {
        return Err(KalError::validation(
            "thread_archived",
            "This thread is archived.",
        ));
    }
    let account = AccountStore::new(core.clone()).get(account_id)?;
    let account = validate_creation_account(account, thread.provider_id.as_str())?;
    if thread.provider_account_id.as_deref() != Some(account.id.as_str()) {
        if account.authentication_state == AuthState::NotAuthenticated {
            return Err(KalError::new(
                ErrorCategory::Provider,
                "provider_account_not_authenticated",
                format!(
                    "{label} isn't signed in. Sign in to {label} in Providers, then switch.",
                    label = account.display_name
                ),
            ));
        }
        if account.provider_id.as_str() == ProviderId::CODEX
            && codex_plan(&account.id) == Some(CloudConfigEligibility::Eligible)
        {
            return Err(KalError::new(
                ErrorCategory::Provider,
                "provider_account_plan_unsupported",
                "This Codex organization plan isn't supported by managed profiles yet.",
            ));
        }
    }
    runtime.rebind_account(thread_id, &account.id)
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

/// Restores an archived thread to the open list (Dashboard, Threads). Idempotent.
#[tauri::command(async)]
pub fn thread_unarchive(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    state
        .runtime()?
        .unarchive(&thread_id)
        .map_err(|e| e.log_and_convert("thread_unarchive"))
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
            effort: None,
            permission_mode: PermissionMode::Approve,
            resume_session_id: None,
            secret_ref: None,
        }
    }

    fn agent_operation_spec() -> OperationSpec {
        OperationSpec {
            name: "Review changes".into(),
            workspace_id: kalcode_contracts::ids::new_id(),
            kind: OperationKind::Agent,
            command: None,
            prompt: Some("Review the current changes".into()),
            provider_id: Some(ProviderId::CODEX.into()),
            provider_account_id: None,
            model: None,
            effort: None,
            dependencies: Vec::new(),
            priority: 0,
            lane: kalcode_contracts::operations::OperationLane::Next,
            environment: kalcode_contracts::operations::OperationEnvironmentKind::Local,
            urls: Vec::new(),
            env_keys: Vec::new(),
        }
    }

    #[test]
    fn agent_operation_rejects_every_non_null_effort_without_fallback() {
        for effort in [String::new(), "high".into()] {
            let mut spec = agent_operation_spec();
            spec.effort = Some(effort);
            assert_eq!(
                validate_agent_operation(&spec)
                    .expect_err("unsupported effort")
                    .code,
                "operation_effort_unsupported"
            );
        }
    }

    #[test]
    fn agent_operation_requires_an_explicit_provider_and_prompt_only() {
        let mut spec = agent_operation_spec();
        spec.provider_id = Some("  ".into());
        assert_eq!(
            validate_agent_operation(&spec)
                .expect_err("provider required")
                .code,
            "operation_provider_required"
        );

        let mut spec = agent_operation_spec();
        spec.command = Some("cargo test".into());
        assert_eq!(
            validate_agent_operation(&spec)
                .expect_err("agent command rejected")
                .code,
            "operation_agent_command_invalid"
        );
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

    /// A provider adapter shaped like the managed ones: it launches with the selected account's
    /// sanitized environment and holds that account's shared profile lease for the session's
    /// lifetime. It records which profile home each launch would use.
    struct ProfileProbe {
        provider: &'static str,
        profiles: ManagedProfiles,
        launches: Mutex<Vec<(String, Option<String>, std::path::PathBuf)>>,
    }

    impl ProfileProbe {
        fn launches(&self) -> Vec<(String, Option<String>, std::path::PathBuf)> {
            self.launches
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }
    }

    /// Keeps the event sink like a real adapter: dropping it would read as the process exiting.
    struct ProbeSession(#[allow(dead_code)] Box<dyn AgentEventSink>);

    impl AgentSession for ProbeSession {
        fn provider_session_id(&self) -> Option<String> {
            None
        }
        fn send(&self, _input: kalcode_contracts::agent::AgentInput) -> Result<(), ProviderError> {
            Ok(())
        }
        fn interrupt(&self) -> Result<(), ProviderError> {
            Ok(())
        }
        fn terminate(&self) -> Result<(), ProviderError> {
            Ok(())
        }
        fn respond_to_approval(
            &self,
            _request_id: &str,
            _decision: kalcode_contracts::permissions::ApprovalDecision,
        ) -> Result<(), ProviderError> {
            Ok(())
        }
    }

    impl AgentProvider for ProfileProbe {
        fn id(&self) -> ProviderId {
            ProviderId::new(self.provider)
        }

        fn display_name(&self) -> &str {
            self.provider
        }

        fn detect(&self) -> ProviderDetection {
            ProviderDetection {
                provider_id: self.id(),
                display_name: self.provider.into(),
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
            match self.provider {
                ProviderId::CODEX => kalcode_providers::catalog::codex_capabilities(),
                _ => kalcode_providers::catalog::gemini_capabilities(),
            }
        }

        fn start_session(
            &self,
            config: SessionConfig,
            sink: Box<dyn AgentEventSink>,
        ) -> Result<Box<dyn AgentSession>, ProviderError> {
            let account = config
                .provider_account_id
                .clone()
                .ok_or(ProviderError::NotAuthenticated)?;
            let env =
                self.profiles
                    .launch_env(self.provider, &account, &DetectEnv::from_process())?;
            let variable = match self.provider {
                ProviderId::CODEX => "CODEX_HOME",
                _ => "GEMINI_CLI_HOME",
            };
            let home = env
                .get(std::ffi::OsStr::new(variable))
                .map(std::path::PathBuf::from)
                .ok_or_else(|| ProviderError::Start("no managed home".into()))?;
            let lease = self
                .profiles
                .acquire_session_lease(self.provider, &account)?;
            self.launches
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push((account, config.resume_session_id, home));
            Ok(kalcode_providers::managed::hold_session_lease(
                Box::new(ProbeSession(sink)),
                lease,
            ))
        }
    }

    struct OneWorkspace(kalcode_threads::ResolvedWorkspace);

    impl kalcode_threads::WorkspaceResolver for OneWorkspace {
        fn list(&self) -> kalcode_core::Result<Vec<kalcode_threads::ResolvedWorkspace>> {
            Ok(vec![self.0.clone()])
        }

        fn resolve(
            &self,
            workspace_id: &str,
        ) -> kalcode_core::Result<kalcode_threads::ResolvedWorkspace> {
            if workspace_id == self.0.id {
                Ok(self.0.clone())
            } else {
                Err(kalcode_threads::registry::workspace_not_found())
            }
        }
    }

    struct RebindFixture {
        accounts: AccountFixture,
        gemini: Arc<ProfileProbe>,
        codex: Arc<ProfileProbe>,
        runtime: ThreadRuntime,
    }

    impl RebindFixture {
        fn new() -> Self {
            let accounts = AccountFixture::new();
            let root = accounts._temp.path().join("repo");
            std::fs::create_dir_all(&root).expect("repo");
            let registry = Arc::new(ProviderRegistry::new());
            let probe = |provider| {
                Arc::new(ProfileProbe {
                    provider,
                    profiles: accounts.profiles.clone(),
                    launches: Mutex::new(Vec::new()),
                })
            };
            let (gemini, codex) = (probe(ProviderId::GEMINI_CLI), probe(ProviderId::CODEX));
            for inner in [&gemini, &codex] {
                let inner: Arc<dyn AgentProvider> = inner.clone();
                registry.register(Arc::new(AccountBoundProvider::new(
                    inner,
                    accounts.store.clone(),
                    accounts.profiles.clone(),
                    false,
                )));
            }
            let runtime = ThreadRuntime::new(
                accounts.core.clone(),
                registry,
                Arc::new(OneWorkspace(kalcode_threads::ResolvedWorkspace {
                    id: accounts.workspace_id.clone(),
                    name: "Fixture".into(),
                    root,
                })),
                Arc::new(kalcode_contracts::permissions::AskUnlessReadGate),
            )
            .expect("runtime");
            Self {
                accounts,
                gemini,
                codex,
                runtime,
            }
        }

        fn account(&self, provider: &str, label: &str, state: AuthState) -> ProviderAccount {
            let account = self
                .accounts
                .store
                .create(provider, label)
                .expect("account");
            self.accounts
                .store
                .mark_authentication(&account.id, state, None, None)
                .expect("auth state")
        }

        fn idle_thread(&self, provider: &str, account: &ProviderAccount) -> ThreadSummary {
            self.runtime
                .create_idle(kalcode_threads::CreateIdleThread {
                    provider_id: provider.into(),
                    provider_account_id: Some(account.id.clone()),
                    account_label: Some(account.display_name.clone()),
                    workspace_id: self.accounts.workspace_id.clone(),
                    model: None,
                    effort: None,
                    permission_mode: PermissionMode::Approve,
                    name: None,
                })
                .expect("idle thread")
        }

        fn rebind(
            &self,
            thread: &ThreadSummary,
            account_id: &str,
            plan: Option<CloudConfigEligibility>,
        ) -> kalcode_core::Result<ThreadSummary> {
            rebind_thread_account(
                &self.accounts.core,
                &self.runtime,
                &thread.id,
                account_id,
                |_| plan,
            )
        }

        fn in_use(&self, provider: &str, account: &ProviderAccount) -> bool {
            self.accounts
                .profiles
                .acquire_account_lifecycle_lease(provider, &account.id)
                .is_err()
        }
    }

    #[test]
    fn rebind_releases_the_old_profile_and_the_next_launch_uses_only_the_new_accounts_home() {
        let fixture = RebindFixture::new();
        let a = fixture.account(ProviderId::GEMINI_CLI, "Gemini A", AuthState::Authenticated);
        let b = fixture.account(ProviderId::GEMINI_CLI, "Gemini B", AuthState::Unknown);
        let thread = fixture.idle_thread(ProviderId::GEMINI_CLI, &a);
        assert_eq!(thread.status, ThreadStatus::Idle);
        assert!(
            fixture.in_use(ProviderId::GEMINI_CLI, &a),
            "the idle session holds A"
        );

        let rebound = fixture.rebind(&thread, &b.id, None).expect("rebind");
        assert_eq!(rebound.provider_account_id.as_deref(), Some(b.id.as_str()));
        assert_eq!(rebound.account_label.as_deref(), Some("Gemini B"));
        assert!(
            !fixture.in_use(ProviderId::GEMINI_CLI, &a),
            "ending the idle session released A's shared profile lease"
        );

        fixture.runtime.resume(&thread.id, None).expect("resume");
        let launches = fixture.gemini.launches();
        assert_eq!(launches.len(), 2);
        let (account, resume_id, home) = &launches[1];
        assert_eq!(account, &b.id);
        assert_eq!(resume_id, &None);
        let home = home.to_string_lossy();
        assert!(home.contains(&b.id) && !home.contains(&a.id), "{home}");
        assert!(fixture.in_use(ProviderId::GEMINI_CLI, &b));
        assert!(
            !fixture.in_use(ProviderId::GEMINI_CLI, &a),
            "nothing reads or holds the old profile after the rebind"
        );
    }

    #[test]
    fn rebind_refuses_unusable_targets_without_touching_the_thread() {
        let fixture = RebindFixture::new();
        let a = fixture.account(ProviderId::GEMINI_CLI, "Gemini A", AuthState::Authenticated);
        let signed_out = fixture.account(
            ProviderId::GEMINI_CLI,
            "Gemini B",
            AuthState::NotAuthenticated,
        );
        let removed = fixture.account(ProviderId::GEMINI_CLI, "Old", AuthState::Authenticated);
        fixture
            .accounts
            .store
            .archive(&fixture.accounts.profiles, &removed.id)
            .expect("archive");
        let work = fixture.account(ProviderId::CODEX, "Work", AuthState::Authenticated);
        let org = fixture.account(ProviderId::CODEX, "Org", AuthState::Authenticated);
        let thread = fixture.idle_thread(ProviderId::GEMINI_CLI, &a);

        for (account, code) in [
            (signed_out.id.as_str(), "provider_account_not_authenticated"),
            (removed.id.as_str(), "provider_account_archived"),
            (work.id.as_str(), "provider_account_mismatch"),
            (
                "0192f3c4-0000-7000-8000-000000000999",
                "provider_account_unknown",
            ),
            ("not-an-id", "provider_account_id_invalid"),
        ] {
            assert_eq!(
                fixture.rebind(&thread, account, None).expect_err(code).code,
                code
            );
        }
        let unchanged = fixture.runtime.get(&thread.id).expect("thread");
        assert_eq!(
            unchanged.provider_account_id.as_deref(),
            Some(a.id.as_str())
        );
        assert_eq!(unchanged.status, ThreadStatus::Idle, "session kept");
        assert!(fixture.in_use(ProviderId::GEMINI_CLI, &a));

        // The current account is a no-op success even when its sign-in state is stale.
        fixture
            .accounts
            .store
            .mark_authentication(&a.id, AuthState::NotAuthenticated, None, None)
            .expect("signed out");
        let same = fixture.rebind(&thread, &a.id, None).expect("same account");
        assert_eq!(same.status, ThreadStatus::Idle);

        // Codex: a cached organization plan is refused now, not on the next message; an
        // unverified plan is left to the launch-time refresh.
        let codex_thread = fixture.idle_thread(ProviderId::CODEX, &work);
        assert_eq!(
            fixture
                .rebind(
                    &codex_thread,
                    &org.id,
                    Some(CloudConfigEligibility::Eligible)
                )
                .expect_err("organization plan")
                .code,
            "provider_account_plan_unsupported"
        );
        fixture
            .rebind(&codex_thread, &org.id, None)
            .expect("unverified plan is checked at launch");
        assert_eq!(fixture.codex.launches().len(), 1);

        fixture.runtime.stop(&thread.id).expect("stop");
        fixture.runtime.archive(&thread.id).expect("archive");
        let archived = fixture.runtime.get(&thread.id).expect("archived thread");
        assert_eq!(
            fixture
                .rebind(&archived, &a.id, None)
                .expect_err("archived thread")
                .code,
            "thread_archived"
        );
    }

    #[test]
    fn thread_unarchive_is_granted_and_restores_an_archived_thread() {
        // The WebView can call it: declared for the build and granted to the main webview.
        assert!(crate::command_registry::COMMANDS.contains(&"thread_unarchive"));
        assert!(include_str!("../capabilities/main.json").contains("\"allow-thread-unarchive\""));

        let fixture = RebindFixture::new();
        let a = fixture.account(ProviderId::GEMINI_CLI, "Gemini A", AuthState::Authenticated);
        let b = fixture.account(ProviderId::GEMINI_CLI, "Gemini B", AuthState::Authenticated);
        let thread = fixture.idle_thread(ProviderId::GEMINI_CLI, &a);
        fixture.runtime.stop(&thread.id).expect("stop");
        fixture.runtime.archive(&thread.id).expect("archive");
        let open = |runtime: &ThreadRuntime| {
            runtime
                .list(None, false)
                .expect("list")
                .into_iter()
                .any(|t| t.id == thread.id)
        };
        assert!(!open(&fixture.runtime));
        let archived = fixture.runtime.get(&thread.id).expect("archived");
        assert_eq!(
            fixture
                .rebind(&archived, &b.id, None)
                .expect_err("archived thread")
                .code,
            "thread_archived"
        );

        let restored = fixture.runtime.unarchive(&thread.id).expect("unarchive");
        assert!(restored.archived_at.is_none());
        assert_eq!(restored.status, archived.status);
        assert_eq!(restored.provider_account_id.as_deref(), Some(a.id.as_str()));
        assert!(open(&fixture.runtime));
        // Restored threads behave like any open thread again.
        fixture
            .rebind(&restored, &b.id, None)
            .expect("rebind after restore");
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

    #[test]
    fn canonical_operation_pins_account_and_never_falls_back_after_removal() {
        let fixture = AccountFixture::new();
        let fallback = fixture
            .store
            .create("codex", "Fallback")
            .expect("fallback account");
        let selected = fixture
            .store
            .create("codex", "Selected")
            .expect("selected account");
        fixture
            .store
            .bind(
                "codex",
                ProviderAccountBindingKind::Workspace,
                &fixture.workspace_id,
                &selected.id,
            )
            .expect("selected workspace binding");

        let reviewed = resolved_create_request(
            &fixture.core,
            "codex".into(),
            None,
            fixture.workspace_id.clone(),
            Some("review-model".into()),
            PermissionMode::Approve,
            "review this exact prompt".into(),
            Some("Pinned operation".into()),
        )
        .expect("reviewed selection");
        let canonical = canonical_operation_spec(&agent_operation_spec(), &reviewed);
        assert_eq!(canonical.provider_id.as_deref(), Some("codex"));
        assert_eq!(canonical.model.as_deref(), Some("review-model"));
        assert_eq!(
            canonical.provider_account_id.as_deref(),
            Some(selected.id.as_str())
        );

        fixture
            .store
            .archive(&fixture.profiles, &selected.id)
            .expect("archive selected account");
        fixture
            .store
            .bind(
                "codex",
                ProviderAccountBindingKind::Workspace,
                &fixture.workspace_id,
                &fallback.id,
            )
            .expect("replacement workspace default");

        let launch = |account_id| {
            resolved_create_request(
                &fixture.core,
                "codex".into(),
                Some(account_id),
                fixture.workspace_id.clone(),
                canonical.model.clone(),
                PermissionMode::Approve,
                "review this exact prompt".into(),
                Some("Pinned operation".into()),
            )
        };
        assert_eq!(
            launch(selected.id)
                .expect_err("archived account cannot drift")
                .code,
            "provider_account_archived"
        );
        assert_eq!(
            launch("0192f3c4-0000-7000-8000-000000000999".into())
                .expect_err("missing account cannot drift")
                .code,
            "provider_account_unknown"
        );
    }
}
