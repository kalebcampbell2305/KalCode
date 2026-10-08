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
    AgentEvent, AgentEventSink, AgentProvider, AgentSession, AuthState, LaunchOrigin,
    ProviderCapabilities, ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::context::PromptReview;
use kalcode_contracts::operations::{OperationKind, OperationSpec};
use kalcode_contracts::permissions::{
    DEFAULT_CODING_PERMISSION_MODE, PermissionGate, PermissionMode,
};
use kalcode_contracts::provider_accounts::{ProviderAccount, ProviderAccountScopes};
use kalcode_contracts::threads::{ThreadMessage, ThreadStatus, ThreadSummary};
use kalcode_core::{Core, ErrorCategory, IpcError, KalError};
use kalcode_permissions::{PermissionService, PermissionSettings, ThreadModeStore};
use kalcode_providers::accounts::AccountStore;
use kalcode_providers::health::observe::ObservedProvider;
use kalcode_providers::managed::ManagedProfiles;
use kalcode_providers::model::{AdapterState, ProviderStatus};
use kalcode_providers::{ClaudeCodeProvider, CodexProvider, DetectEnv, GeminiProvider};
use kalcode_threads::{
    CoreWorkspaces, CreateIdleThread, CreateThread, ProviderErrorObserver, ProviderRegistry,
    StreamId, ThreadOptions, ThreadRuntime, ToolCallRecord,
};
use tauri::ipc::Channel;
use tauri::{State, Webview};

use crate::AppState;
use crate::provider_auth_commands::ProviderRuntimeAuthority;
use crate::provider_commands::detect_once_and_record;
use crate::provider_pane_commands::ProviderPanesState;
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
    memory: Arc<OnceLock<Arc<crate::unified_memory_commands::MemoryService>>>,
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

/// One reviewed Operations pane admission. Grouping the authority, identity, provider spec and
/// worktree policy keeps the start and prepare paths on one contract as orchestration grows.
pub(crate) struct OperationPaneRequest<'a> {
    pub(crate) core: &'a Arc<Core>,
    pub(crate) git: &'a kalcode_git::GitCore,
    pub(crate) operation_id: &'a str,
    pub(crate) spec: &'a OperationSpec,
    pub(crate) origin: LaunchOrigin,
    pub(crate) isolate: bool,
    pub(crate) start_revision: Option<&'a str>,
    /// An Agent Handoff Chain step joins its chain's one shared worktree instead of its own.
    pub(crate) shared_worktree: Option<SharedWorktree<'a>>,
}

/// A KalCode-managed worktree owned by a relation (a chain), not by any single thread, so no
/// pane's archive or release can remove it while later steps still use it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SharedWorktree<'a> {
    pub(crate) owner_ref: &'a str,
    pub(crate) branch: &'a str,
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

struct AccountProviderErrorObserver {
    accounts: AccountStore,
}

impl ProviderErrorObserver for AccountProviderErrorObserver {
    fn observe(
        &self,
        provider_id: &ProviderId,
        account_id: &str,
        code: &str,
    ) -> kalcode_core::Result<()> {
        if provider_id.as_str() != ProviderId::CLAUDE_CODE
            || !kalcode_providers::health::is_auth_code(code)
        {
            return Ok(());
        }
        // Revalidate the immutable provider/account association at the persistence boundary.
        // The thread worker still holds its generation lock and the live session's shared profile
        // lease here, so archive/sign-in/sign-out cannot overtake this update.
        self.accounts
            .get_active_for_provider(account_id, provider_id)?;
        self.accounts.mark_authentication(
            account_id,
            AuthState::NotAuthenticated,
            None,
            Some(code),
        )?;
        Ok(())
    }
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
            ProviderId::CURSOR => None,
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
    // Pane and headless routes are both coding agents the person asked for, so both get the one
    // user-requested admission policy (AGENTS.md Resource Governor rule); the router's
    // interactive flag does not select a different policy.
    let guard = |provider: Arc<dyn AgentProvider>, _interactive: bool| -> Arc<dyn AgentProvider> {
        let observed = ObservedProvider::wrap(provider, health);
        let governed = ResourceAdmissionProvider::wrap(observed, resources.clone());
        Arc::new(AccountBoundProvider::managed(
            governed,
            runtime.clone(),
            crate::environment::TEST_HOOKS_ENABLED,
        ))
    };
    // Persist the terminal identity before account/resource guards can refuse or defer it.
    // Both branches retain exactly the same guards; a deferred agent never retries headless.
    let adapter: Arc<dyn AgentProvider> = match id.as_str() {
        // Z7-W4: the per-thread runtime router when provider panes are enabled.
        ProviderId::CLAUDE_CODE => routes.route_claude(headless, guard),
        ProviderId::CODEX => routes.route_cli(ProviderId::CODEX, headless, guard),
        ProviderId::GEMINI_CLI => routes.route_cli(ProviderId::GEMINI_CLI, headless, guard),
        ProviderId::CURSOR => routes.route_cli(ProviderId::CURSOR, headless, guard),
        _ => return None,
    };
    Some(adapter)
}

fn sync_cached_provider_statuses<F>(
    providers: &ProviderRegistry,
    statuses: Vec<ProviderStatus>,
    usable: &[ProviderId],
    mut make_provider: F,
) where
    F: FnMut(&ProviderStatus) -> Option<Arc<dyn AgentProvider>>,
{
    for status in statuses {
        if status.adapter != AdapterState::Implemented {
            continue;
        }
        if usable.contains(&status.id) {
            if providers.get(&status.id).is_none()
                && let Some(provider) = make_provider(&status)
            {
                providers.register(provider);
                tracing::info!(
                    event = "threads.provider_registered",
                    provider_id = status.id.as_str()
                );
            }
        } else if providers.unregister(&status.id) {
            tracing::info!(
                event = "threads.provider_unregistered",
                provider_id = status.id.as_str()
            );
        }
    }
}

fn ensure_cached_provider_registry<D, S>(never_detected: bool, detect: D, sync: S)
where
    D: FnOnce(),
    S: FnOnce(),
{
    if never_detected {
        detect();
    }
    sync();
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
            if let Some(provider_runtime) = &provider_runtime
                && let Err(error) =
                    runtime.set_provider_error_observer(Arc::new(AccountProviderErrorObserver {
                        accounts: provider_runtime.account_store(),
                    }))
            {
                tracing::error!(
                    event = "threads.provider_error_observer_start_failed",
                    error_code = error.code
                );
            }
            modes.bind(runtime);
        }
        let state = Self {
            memory: Arc::new(OnceLock::new()),
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
        sync_cached_provider_statuses(&self.providers, self.detection.list(), &usable, |status| {
            let runtime = self.provider_runtime.as_ref()?;
            let provider = adapter(
                status,
                runtime.clone(),
                &self.routes,
                self.health.as_ref(),
                self.resources.clone(),
            )?;
            Some(Arc::new(crate::unified_memory_commands::MemoryProvider {
                inner: provider,
                memory: self.memory.clone(),
            }))
        });
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
        ensure_cached_provider_registry(
            never_detected,
            || {
                detect_once_and_record(core, &self.detection);
            },
            || {
                // Detection and the thread runtime have separate process-local registries.
                // Startup can finish before the cached provider check does, so every consumer
                // must project the latest cached truth even when it did not run detection itself.
                self.sync_providers();
            },
        );
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
    /// Operations uses the saved startable permission preference. Fresh settings use bounded Auto;
    /// modes that need an attached confirmation or profile conservatively use Approve.
    /// `origin` is who asked for this start: the person's Run now is `User` and is admitted like
    /// any agent they start; the scheduler's own starts are `Background` and yield to CPU load.
    pub(crate) fn start_operation(
        &self,
        launch: OperationPaneRequest<'_>,
    ) -> kalcode_core::Result<ThreadSummary> {
        let OperationPaneRequest {
            core,
            git,
            operation_id,
            spec,
            origin,
            isolate,
            start_revision,
            shared_worktree,
        } = launch;
        let request = self.reviewed_operation_request(core, spec)?;
        let runtime = self.operation_runtime()?;
        if isolate {
            let root = crate::git_commands::workspace_root_in(core, &request.workspace_id)?;
            return self
                .routes
                .create_operation_pane(runtime, operation_id, |id| {
                    create_operation_in_worktree(
                        core,
                        git,
                        runtime,
                        &root,
                        id,
                        request,
                        spec.prompt.is_some(),
                        origin,
                        start_revision,
                        shared_worktree,
                    )
                });
        }
        self.routes
            .create_operation_pane(runtime, operation_id, |id| {
                if spec.prompt.is_some() {
                    runtime.create_reviewed_for_operation_with_origin(id, request, None, origin)
                } else {
                    runtime.create_idle_with_id_for_origin(
                        id,
                        CreateIdleThread {
                            provider_id: request.provider_id,
                            provider_account_id: request.provider_account_id,
                            account_label: request.account_label,
                            workspace_id: request.workspace_id,
                            model: request.model,
                            effort: request.effort,
                            permission_mode: request.permission_mode,
                            name: request.name,
                        },
                        origin,
                    )
                }
            })
    }

    /// Starts a Squad member's real provider pane without sending its task. The same canonical
    /// thread is later admitted by Operations after its dependencies succeed.
    pub(crate) fn prepare_operation(
        &self,
        launch: OperationPaneRequest<'_>,
    ) -> kalcode_core::Result<ThreadSummary> {
        let OperationPaneRequest {
            core,
            git,
            operation_id,
            spec,
            origin,
            isolate,
            start_revision,
            shared_worktree,
        } = launch;
        let request = self.reviewed_operation_request(core, spec)?;
        let runtime = self.operation_runtime()?;
        match runtime.get(operation_id) {
            Ok(existing) => {
                if !operation_thread_request_matches(&existing, &request, operation_id) {
                    return Err(KalError::internal(
                        "operation_thread_identity_mismatch",
                        "This Squad member's provider pane no longer matches its reviewed configuration.",
                    ));
                }
                if matches!(
                    existing.status,
                    ThreadStatus::Paused
                        | ThreadStatus::Completed
                        | ThreadStatus::Failed
                        | ThreadStatus::Interrupted
                        | ThreadStatus::Offline
                ) {
                    runtime.resume(operation_id, None)?;
                }
                return runtime.wait_for_dependency(operation_id, "Waiting for dependencies");
            }
            Err(error) if error.code == "thread_not_found" => {}
            Err(error) => return Err(error),
        }

        let idle_request = CreateIdleThread {
            provider_id: request.provider_id.clone(),
            provider_account_id: request.provider_account_id.clone(),
            account_label: request.account_label.clone(),
            workspace_id: request.workspace_id.clone(),
            model: request.model.clone(),
            effort: request.effort.clone(),
            permission_mode: request.permission_mode,
            name: request.name.clone(),
        };
        if isolate {
            let root = crate::git_commands::workspace_root_in(core, &request.workspace_id)?;
            return self
                .routes
                .create_operation_pane(runtime, operation_id, |id| {
                    create_operation_in_worktree(
                        core,
                        git,
                        runtime,
                        &root,
                        id,
                        request,
                        false,
                        origin,
                        start_revision,
                        shared_worktree,
                    )?;
                    runtime.wait_for_dependency(id, "Waiting for dependencies")
                });
        }
        self.routes
            .create_operation_pane(runtime, operation_id, |id| {
                runtime.create_idle_with_id_for_origin(id, idle_request, origin)?;
                runtime.wait_for_dependency(id, "Waiting for dependencies")
            })
    }

    fn reviewed_operation_request(
        &self,
        core: &Arc<Core>,
        spec: &OperationSpec,
    ) -> kalcode_core::Result<CreateThread> {
        self.ensure_providers(Some(core));
        let runtime = self.operation_runtime()?;
        let permission_mode = match self.permissions.as_ref() {
            Some(service) => service
                .settings()
                .map(|settings| settings.startable_default_mode())
                .unwrap_or(PermissionMode::Approve),
            None => DEFAULT_CODING_PERMISSION_MODE,
        };
        let request = operation_request(core, runtime, spec, permission_mode)?;
        validate_operation_account_authenticated(core, &request)?;
        if spec.prompt.is_some() {
            review_operation_prompt(runtime, &request)?;
        }
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

    pub fn bind_memory(&self, memory: Arc<crate::unified_memory_commands::MemoryService>) {
        let _ = self.memory.set(memory);
    }

    pub fn memory(&self) -> Option<&Arc<crate::unified_memory_commands::MemoryService>> {
        self.memory.get()
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

fn validate_agent_operation(spec: &OperationSpec) -> kalcode_core::Result<(&str, Option<&str>)> {
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
        .filter(|prompt| !prompt.trim().is_empty());
    Ok((provider_id, prompt))
}

fn operation_request(
    core: &Arc<Core>,
    runtime: &ThreadRuntime,
    spec: &OperationSpec,
    permission_mode: PermissionMode,
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
    let mut request = resolved_create_request(
        core,
        provider_id.0,
        spec.provider_account_id.clone(),
        spec.workspace_id.clone(),
        model,
        permission_mode,
        prompt.unwrap_or_default().to_owned(),
        Some(spec.name.clone()),
    )?;
    request.effort = operation_effort(&request.provider_id, spec.effort.as_deref())?;
    Ok(request)
}

fn operation_effort(
    provider_id: &str,
    effort: Option<&str>,
) -> kalcode_core::Result<Option<String>> {
    kalcode_providers::interactive::normalize_effort(provider_id, effort)
        .map_err(|message| KalError::validation("invalid_effort", message))
}

fn canonical_operation_spec(spec: &OperationSpec, request: &CreateThread) -> OperationSpec {
    let mut canonical = spec.clone();
    canonical.provider_id = Some(request.provider_id.clone());
    canonical.provider_account_id = request.provider_account_id.clone();
    canonical.model = request.model.clone();
    canonical.effort = request.effort.clone();
    canonical
}

fn operation_thread_request_matches(
    thread: &ThreadSummary,
    request: &CreateThread,
    operation_id: &str,
) -> bool {
    thread.id == operation_id
        && thread.provider_id.as_str() == request.provider_id
        && thread.provider_account_id == request.provider_account_id
        && thread.workspace_id == request.workspace_id
        && thread.model == request.model
        && thread.effort == request.effort
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
    // Bypass starts without a confirmation (owner directive 2026-10-03: no approvals).
    let _ = (permission_mode, confirm_bypass);
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

fn validate_operation_account_authenticated(
    core: &Arc<Core>,
    request: &CreateThread,
) -> kalcode_core::Result<()> {
    let Some(account_id) = request.provider_account_id.as_deref() else {
        return Ok(());
    };
    let account = AccountStore::new(core.clone()).get(account_id)?;
    if account.authentication_state == AuthState::NotAuthenticated {
        Err(KalError::new(
            ErrorCategory::Authentication,
            "provider_account_not_authenticated",
            "That provider account needs to be reconnected before this agent can start.",
        ))
    } else {
        Ok(())
    }
}

#[tauri::command(async)]
pub fn thread_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    workspace_id: Option<String>,
    include_archived: Option<bool>,
) -> Result<Vec<ThreadSummary>, IpcError> {
    _runtime_access.revalidate()?;
    state.ensure_providers(app.core.as_ref());
    let mut threads = state
        .runtime()?
        .list(workspace_id.as_deref(), include_archived.unwrap_or(false))
        .map_err(|e| e.log_and_convert("thread_list"))?;
    // Coding agents (provider panes) and chat threads share this list; say which is which.
    for thread in &mut threads {
        panes.stamp_runtime_kind(thread);
    }
    Ok(threads)
}

#[tauri::command(async)]
pub fn thread_get(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    thread_id: String,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    state.ensure_providers(app.core.as_ref());
    let mut thread = state
        .runtime()?
        .get(&thread_id)
        .map_err(|e| e.log_and_convert("thread_get"))?;
    panes.stamp_runtime_kind(&mut thread);
    Ok(thread)
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
    // New threads start without approvals (Bypass) unless the saved default is read-only Plan.
    if let Some(service) = state.permissions.as_ref() {
        let settings = service.settings().unwrap_or_default();
        apply_saved_permission_settings(&mut options, &settings);
    }
    Ok(options)
}

fn apply_saved_permission_settings(options: &mut ThreadOptions, settings: &PermissionSettings) {
    let default = settings.startable_default_mode();
    if !options.permission_modes.contains(&default) {
        options.permission_modes.push(default);
    }
    options.default_permission_mode = default;
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
    // Agent Fleet: `true` runs the thread in its own Git worktree and branch.
    isolate: Option<bool>,
    git: crate::runtime_coordinator::RuntimeState<crate::git_commands::GitState>,
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
    if isolate == Some(true) {
        let root = crate::git_commands::workspace_root(&app, &request.workspace_id)
            .map_err(|e| e.log_and_convert("thread_create_worktree"))?;
        return create_thread_in_worktree(
            app.core()?,
            &git.0,
            state.runtime()?,
            &root,
            request,
            prompt_review_id.as_deref(),
        )
        .map_err(|e| e.log_and_convert("thread_create"));
    }
    state
        .runtime()?
        .create_reviewed(request, prompt_review_id.as_deref())
        .map_err(|e| e.log_and_convert("thread_create"))
}

fn worktree_unavailable() -> KalError {
    KalError::new(
        ErrorCategory::Git,
        "worktree_unavailable",
        "This workspace isn't a Git repository, so the thread can't get its own worktree.",
    )
}

/// The branch of a thread's own worktree: `kal/<slug of the name, or "agent">-<8 hex>`. The
/// suffix is the end of the thread id, its random part (a v7 id starts with a timestamp that
/// threads created in the same minute share).
fn thread_branch_name(name: Option<&str>, thread_id: &str) -> String {
    let mut slug = String::new();
    for c in name.unwrap_or_default().chars() {
        if slug.len() >= 32 {
            break;
        }
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() { "agent" } else { slug };
    let hex: String = thread_id.chars().filter(char::is_ascii_hexdigit).collect();
    let suffix = &hex[hex.len().saturating_sub(8)..];
    format!("kal/{slug}-{suffix}")
}

pub(crate) fn operation_branch_name(name: Option<&str>, operation_id: &str) -> String {
    thread_branch_name(name, operation_id)
}

/// Creates a thread that runs in its own KalCode-managed Git worktree on a new branch from the
/// workspace's HEAD, so parallel agents never share a folder. The checkout happens only after
/// the runtime admitted the prompt and validated the provider, model and workspace; the worktree
/// is recorded in `git_worktrees` (purpose `thread`, owner = the thread id) before the thread, so
/// the returned summary carries its branch. If the thread can't be created, the worktree and
/// its still-empty branch are rolled back (the row is marked removed only when the folder really
/// was removed); a thread that was recorded (for example one whose provider then failed to
/// start) keeps its worktree.
pub(crate) fn create_thread_in_worktree(
    core: &Arc<Core>,
    git: &kalcode_git::GitCore,
    runtime: &ThreadRuntime,
    root: &kalcode_git::WorkspaceRoot,
    request: CreateThread,
    review_id: Option<&str>,
) -> kalcode_core::Result<ThreadSummary> {
    use kalcode_git::store as git_store;
    use kalcode_git::types::WorktreePurpose;
    use kalcode_git::worktree;

    let exe = git.git()?;
    let repo = git.repo(root)?.ok_or_else(worktree_unavailable)?;
    let thread_id = kalcode_contracts::ids::new_id();
    let branch = thread_branch_name(request.name.as_deref(), &thread_id);
    let made = std::cell::RefCell::new(None);
    let recorded = std::cell::RefCell::new(None);
    let created = runtime.create_reviewed_in(&thread_id, request, review_id, || {
        let new = worktree::create_managed(
            exe,
            &repo,
            git.worktrees_root(),
            &branch,
            None,
            WorktreePurpose::Thread,
            Some(thread_id.clone()),
        )?;
        *made.borrow_mut() = Some(new.clone());
        let (row, _) =
            core.write_with_events(|tx| Ok((git_store::insert_worktree(tx, &new)?, Vec::new())))?;
        tracing::info!(event = "thread.worktree_created", thread_id = %thread_id, worktree_id = %row.id);
        *recorded.borrow_mut() = Some(row.id);
        thread_folder(&repo, &new.path)
    });
    match created {
        Ok(summary) => Ok(summary),
        Err(error) => {
            if let Some(new) = made.into_inner()
                && runtime.get(&thread_id).is_err()
            {
                roll_back_thread_worktree(core, exe, &repo, &new, recorded.into_inner().as_deref());
            }
            Err(error)
        }
    }
}

/// Creates one Operations-owned coding agent in its own managed worktree while preserving the
/// reserved Operation/thread id. The membership relation decides isolation; the canonical
/// thread worktree store remains the sole folder/branch authority and survives restart.
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_operation_in_worktree(
    core: &Arc<Core>,
    git: &kalcode_git::GitCore,
    runtime: &ThreadRuntime,
    root: &kalcode_git::WorkspaceRoot,
    operation_id: &str,
    request: CreateThread,
    has_prompt: bool,
    origin: LaunchOrigin,
    start_revision: Option<&str>,
    shared: Option<SharedWorktree<'_>>,
) -> kalcode_core::Result<ThreadSummary> {
    use kalcode_git::store as git_store;
    use kalcode_git::types::WorktreePurpose;
    use kalcode_git::worktree;

    let exe = git.git()?;
    let repo = git.repo(root)?.ok_or_else(worktree_unavailable)?;
    let owner = shared.map_or(operation_id, |shared| shared.owner_ref);
    let branch = shared.map_or_else(
        || thread_branch_name(request.name.as_deref(), operation_id),
        |shared| shared.branch.to_owned(),
    );
    // A shared tree was created at the first step's revision; later steps join it as it is.
    let reuse_revision = if shared.is_some() {
        None
    } else {
        start_revision
    };
    let made = std::cell::RefCell::new(None);
    let recorded = std::cell::RefCell::new(None);
    let prepare = || {
        use kalcode_git::types::WorktreeStatus;

        if let Some((row, old_path)) =
            core.read(|conn| git_store::latest_thread_worktree(conn, owner))?
        {
            if row.workspace_id != root.id()
                || row.branch != branch
                || row.purpose != WorktreePurpose::Thread
                || row.owner_ref.as_deref() != Some(owner)
                || reuse_revision.is_some_and(|revision| row.base_commit != revision)
            {
                return Err(KalError::internal(
                    "operation_worktree_identity_mismatch",
                    "This Squad member's saved worktree does not match its reviewed launch.",
                ));
            }
            if row.status == WorktreeStatus::Active && old_path.is_dir() {
                return thread_folder(&repo, &old_path);
            }
            if old_path.exists() {
                return Err(KalError::internal(
                    "operation_worktree_recovery_required",
                    "This Squad member's saved worktree has conflicting recovery state. Inspect it before retrying.",
                ));
            }
            worktree::forget_missing(exe, &repo, &old_path)?;
            let new = worktree::attach_managed(
                exe,
                &repo,
                git.worktrees_root(),
                &branch,
                WorktreePurpose::Thread,
                Some(owner.to_owned()),
            )?;
            let (new_row, _) = core.write_with_events(|tx| {
                if row.status == WorktreeStatus::Active {
                    git_store::set_worktree_status(tx, &row.id, WorktreeStatus::Removed)?;
                }
                Ok((git_store::insert_worktree(tx, &new)?, Vec::new()))
            })?;
            *made.borrow_mut() = Some(new.clone());
            *recorded.borrow_mut() = Some(new_row.id);
            return thread_folder(&repo, &new.path);
        }

        // A crash can occur after `git worktree add` but before its SQLite row. Recover only the
        // exact deterministic branch inside KalCode's managed worktree root, with the reviewed
        // base commit, then establish the missing canonical row before creating the thread.
        let expected_root = git.worktrees_root().join(root.id());
        let mut discovered = worktree::list(exe, &repo)?
            .into_iter()
            .filter(|item| item.branch.as_deref() == Some(branch.as_str()))
            .collect::<Vec<_>>();
        if discovered.len() > 1 {
            return Err(KalError::internal(
                "operation_worktree_recovery_ambiguous",
                "More than one worktree matches this Squad member's branch. Inspect them before retrying.",
            ));
        }
        let new = if let Some(found) = discovered.pop() {
            let managed_root = std::fs::canonicalize(&expected_root).map_err(|error| {
                KalError::new(
                    ErrorCategory::Filesystem,
                    "operation_worktree_recovery_unavailable",
                    "KalCode couldn't verify the recovered worktree folder.",
                )
                .with_source(error)
            })?;
            let recovered_path = std::fs::canonicalize(&found.path).map_err(|error| {
                KalError::new(
                    ErrorCategory::Filesystem,
                    "operation_worktree_recovery_unavailable",
                    "KalCode couldn't verify the recovered worktree folder.",
                )
                .with_source(error)
            })?;
            let id = recovered_path
                .file_name()
                .and_then(std::ffi::OsStr::to_str)
                .filter(|id| kalcode_contracts::ids::is_valid_id(id))
                .ok_or_else(|| {
                    KalError::internal(
                        "operation_worktree_recovery_untrusted",
                        "The recovered worktree is not a KalCode-managed folder.",
                    )
                })?;
            let head = found.head.ok_or_else(|| {
                KalError::internal(
                    "operation_worktree_recovery_unverified",
                    "The recovered worktree revision could not be verified.",
                )
            })?;
            if !recovered_path.starts_with(&managed_root)
                || start_revision.is_some_and(|revision| revision != head)
            {
                return Err(KalError::internal(
                    "operation_worktree_recovery_untrusted",
                    "The recovered worktree did not match this Squad member's reviewed revision.",
                ));
            }
            worktree::NewWorktree {
                id: id.to_owned(),
                workspace_id: root.id().to_owned(),
                path: recovered_path,
                branch: branch.clone(),
                base_commit: head,
                purpose: WorktreePurpose::Thread,
                owner_ref: Some(owner.to_owned()),
            }
        } else {
            match worktree::attach_managed(
                exe,
                &repo,
                git.worktrees_root(),
                &branch,
                WorktreePurpose::Thread,
                Some(owner.to_owned()),
            ) {
                Ok(attached) => {
                    if start_revision.is_some_and(|revision| revision != attached.base_commit) {
                        let _ = worktree::remove(
                            exe,
                            &repo,
                            &attached.path,
                            worktree::RemoveMode::Safe,
                        );
                        return Err(KalError::internal(
                            "operation_worktree_recovery_untrusted",
                            "The recovered branch did not match this Squad member's reviewed revision.",
                        ));
                    }
                    attached
                }
                Err(error) if error.code == "branch_missing" => worktree::create_managed(
                    exe,
                    &repo,
                    git.worktrees_root(),
                    &branch,
                    start_revision,
                    WorktreePurpose::Thread,
                    Some(owner.to_owned()),
                )?,
                Err(error) => return Err(error),
            }
        };
        *made.borrow_mut() = Some(new.clone());
        let (row, _) =
            core.write_with_events(|tx| Ok((git_store::insert_worktree(tx, &new)?, Vec::new())))?;
        tracing::info!(
            event = "operation.worktree_created",
            operation_id,
            worktree_id = %row.id
        );
        *recorded.borrow_mut() = Some(row.id);
        thread_folder(&repo, &new.path)
    };
    let created = if has_prompt {
        runtime.create_reviewed_in_with_origin(operation_id, request, None, origin, prepare)
    } else {
        let cwd = prepare()?;
        runtime.create_idle_with_id_in_directory_for_origin(
            operation_id,
            CreateIdleThread {
                provider_id: request.provider_id,
                provider_account_id: request.provider_account_id,
                account_label: request.account_label,
                workspace_id: request.workspace_id,
                model: request.model,
                effort: request.effort,
                permission_mode: request.permission_mode,
                name: request.name,
            },
            cwd,
            origin,
        )
    };
    match created {
        Ok(summary) => Ok(summary),
        Err(error) => {
            if let Some(new) = made.into_inner()
                && runtime.get(operation_id).is_err()
            {
                roll_back_thread_worktree(core, exe, &repo, &new, recorded.into_inner().as_deref());
            }
            Err(error)
        }
    }
}

/// Undoes a new thread worktree whose thread was never created. The row (when recorded) becomes
/// `removed` only if the folder was removed, otherwise `abandoned`, so it is never mistaken for
/// a live binding nor claimed gone while its folder still exists.
fn roll_back_thread_worktree(
    core: &Core,
    git: &kalcode_git::Git,
    repo: &kalcode_git::repo::Repo,
    new: &kalcode_git::worktree::NewWorktree,
    row_id: Option<&str>,
) {
    use kalcode_git::types::WorktreeStatus;
    use kalcode_git::worktree::{self, RemoveMode};

    let status = match worktree::remove(git, repo, &new.path, RemoveMode::Safe) {
        Ok(()) => {
            if let Err(error) =
                worktree::discard_new_branch(git, repo, &new.branch, &new.base_commit)
            {
                tracing::warn!(event = "thread.worktree_branch_kept", error = %error.diagnostic());
            }
            WorktreeStatus::Removed
        }
        Err(error) => {
            tracing::warn!(event = "thread.worktree_rollback_failed", error = %error.diagnostic());
            WorktreeStatus::Abandoned
        }
    };
    if let Some(id) = row_id
        && let Err(error) = core.write_with_events(|tx| {
            kalcode_git::store::set_worktree_status(tx, id, status)?;
            Ok(((), Vec::new()))
        })
    {
        tracing::warn!(event = "thread.worktree_rollback_failed", error = %error.diagnostic());
    }
}

/// The folder a thread runs in inside its worktree: the worktree itself, or for a workspace that
/// is a subfolder of a larger repository, the same subfolder of the worktree. Canonical.
fn thread_folder(
    repo: &kalcode_git::repo::Repo,
    worktree: &std::path::Path,
) -> kalcode_core::Result<std::path::PathBuf> {
    let folder = repo
        .prefix()
        .split('/')
        .filter(|part| !part.is_empty())
        .fold(worktree.to_path_buf(), |path, part| path.join(part));
    std::fs::create_dir_all(&folder).map_err(|e| {
        KalError::new(
            ErrorCategory::Filesystem,
            "worktree_folder_unavailable",
            "KalCode couldn't create the worktree folder.",
        )
        .with_source(e)
    })?;
    kalcode_core::workspaces::canonical_folder(&folder)
}

/// Agent Fleet's [`kalcode_threads::ThreadWorktrees`]: brings back an isolated thread's worktree
/// from its branch, and frees the folder of an archived one.
pub(crate) struct DesktopThreadWorktrees {
    core: Arc<Core>,
    git: Arc<kalcode_git::GitCore>,
}

impl DesktopThreadWorktrees {
    pub(crate) fn new(core: Arc<Core>, git: Arc<kalcode_git::GitCore>) -> Self {
        Self { core, git }
    }

    fn repo(
        &self,
        workspace_id: &str,
    ) -> kalcode_core::Result<(&kalcode_git::Git, kalcode_git::repo::Repo)> {
        let root = crate::git_commands::workspace_root_in(&self.core, workspace_id)?;
        let exe = self.git.git()?;
        let repo = self.git.repo(&root)?.ok_or_else(worktree_unavailable)?;
        Ok((exe, repo))
    }
}

impl kalcode_threads::ThreadWorktrees for DesktopThreadWorktrees {
    fn reattach(&self, thread_id: &str) -> kalcode_core::Result<std::path::PathBuf> {
        use kalcode_git::store as git_store;
        use kalcode_git::types::{WorktreePurpose, WorktreeStatus};
        use kalcode_git::worktree::{self, RemoveMode};

        let (row, old_path) = self
            .core
            .read(|conn| git_store::latest_thread_worktree(conn, thread_id))?
            .ok_or_else(|| {
                KalError::validation("worktree_unknown", "That worktree no longer exists.")
            })?;
        let (exe, repo) = self.repo(&row.workspace_id)?;
        if row.status == WorktreeStatus::Active && old_path.is_dir() {
            return thread_folder(&repo, &old_path);
        }
        // The folder is gone: check the branch (with everything committed on it) out again.
        worktree::forget_missing(exe, &repo, &old_path)?;
        let new = worktree::attach_managed(
            exe,
            &repo,
            self.git.worktrees_root(),
            &row.branch,
            WorktreePurpose::Thread,
            Some(thread_id.to_owned()),
        )?;
        let recorded = self.core.write_with_events(|tx| {
            if row.status == WorktreeStatus::Active {
                git_store::set_worktree_status(tx, &row.id, WorktreeStatus::Removed)?;
            }
            Ok((git_store::insert_worktree(tx, &new)?, Vec::new()))
        });
        match recorded {
            Ok((new_row, _)) => {
                tracing::info!(event = "thread.worktree_reattached", thread_id, worktree_id = %new_row.id);
                thread_folder(&repo, &new.path)
            }
            Err(error) => {
                let _ = worktree::remove(exe, &repo, &new.path, RemoveMode::Safe);
                Err(error)
            }
        }
    }

    fn release(&self, thread_id: &str) {
        use kalcode_git::store as git_store;
        use kalcode_git::types::WorktreeStatus;
        use kalcode_git::worktree::{self, RemoveMode};

        let released = (|| -> kalcode_core::Result<bool> {
            let Some((row, path)) = self
                .core
                .read(|conn| git_store::active_thread_worktree(conn, thread_id))?
            else {
                return Ok(false);
            };
            if !path.exists() {
                // Nothing to free; a later resume re-attaches the branch.
                return Ok(false);
            }
            let (exe, repo) = self.repo(&row.workspace_id)?;
            // Refuses while anything is uncommitted: then the folder (and work) stays.
            worktree::remove(exe, &repo, &path, RemoveMode::Safe)?;
            self.git.forget_workspace(&row.id);
            self.core.write_with_events(|tx| {
                git_store::set_worktree_status(tx, &row.id, WorktreeStatus::Removed)?;
                Ok(((), Vec::new()))
            })?;
            Ok(true)
        })();
        match released {
            Ok(true) => tracing::info!(event = "thread.worktree_released", thread_id),
            Ok(false) => {}
            Err(error) => {
                tracing::info!(
                    event = "thread.worktree_kept",
                    thread_id,
                    error_code = error.code
                );
            }
        }
    }
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
#[allow(clippy::too_many_arguments)]
pub fn thread_resume(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    thread_id: String,
    text: Option<String>,
    prompt_review_id: Option<String>,
    allow_pending_input: Option<bool>,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    validate_optional_prompt_review(text.as_deref(), prompt_review_id.as_deref())?;
    state.ensure_providers(app.core.as_ref());
    let mut thread = state
        .runtime()?
        .resume_reviewed_with_options(
            &thread_id,
            text.as_deref(),
            prompt_review_id.as_deref(),
            allow_pending_input.unwrap_or(true),
        )
        .map_err(|e| e.log_and_convert("thread_resume"))?;
    // Same canonical summary as `thread_get`: a resumed pane stays an interactive coding agent.
    panes.stamp_runtime_kind(&mut thread);
    Ok(thread)
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
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    thread_id: String,
    provider_account_id: String,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?;
    if panes
        .handoff_info(&thread_id)
        .is_some_and(|info| info.running)
    {
        return Err(KalError::validation(
            "thread_rebind_busy",
            "Stop the coding agent before changing its account.",
        )
        .log_and_convert("thread_rebind_account"));
    }
    rebind_thread_account(app.core()?, runtime, &thread_id, &provider_account_id)
        .map_err(|error| error.log_and_convert("thread_rebind_account"))
}

/// Validates what the thread runtime can't see, then rebinds. Order (mirrored by the memory
/// transport): archived thread; account id, existence, provider and removal; the current
/// account is a no-op; sign-in state (`not_authenticated` refused, `unknown` allowed because
/// launch re-checks); then the runtime's busy checks. Every Codex plan can be selected (native
/// provider parity).
fn rebind_thread_account(
    core: &Arc<Core>,
    runtime: &ThreadRuntime,
    thread_id: &str,
    account_id: &str,
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
    if thread.provider_account_id.as_deref() != Some(account.id.as_str())
        && account.authentication_state == AuthState::NotAuthenticated
    {
        return Err(KalError::new(
            ErrorCategory::Provider,
            "provider_account_not_authenticated",
            format!(
                "{label} isn't signed in. Sign in to {label} in Providers, then switch.",
                label = account.display_name
            ),
        ));
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

/// Start Anyway: the person's explicit override for a coding agent the Resource Governor is
/// holding (genuine hard pressure or an explicit Custom limit). Grants this thread a one-launch
/// override, then re-checks its held launch or turn at once, or resumes a launch whose wait ran
/// out. Provider-agnostic.
#[tauri::command(async)]
pub fn thread_start_anyway(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    thread_id: String,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    if !kalcode_contracts::ids::is_valid_id(&thread_id) {
        return Err(
            KalError::validation("invalid_thread", "That thread id isn't valid.")
                .log_and_convert("thread_start_anyway"),
        );
    }
    let runtime = state.runtime()?;
    state.resources.grant_start_anyway(&thread_id);
    runtime
        .retry_held_launch(&thread_id)
        .map_err(|e| e.log_and_convert("thread_start_anyway"))
}

#[tauri::command(async)]
pub fn thread_duplicate(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    thread_id: String,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?;
    let mut source = runtime
        .get(&thread_id)
        .map_err(|e| e.log_and_convert("thread_duplicate"))?;
    panes.stamp_runtime_kind(&mut source);
    if source.runtime_kind == Some(kalcode_contracts::threads::ThreadRuntimeKind::InteractivePty) {
        return Err(KalError::validation(
            "thread_is_coding_agent",
            "Duplicate coding agents from their Code pane.",
        )
        .log_and_convert("thread_duplicate"));
    }
    runtime
        .duplicate(&thread_id)
        .map_err(|e| e.log_and_convert("thread_duplicate"))
}

#[tauri::command(async)]
pub fn thread_move(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    thread_id: String,
    workspace_id: String,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime()?;
    let mut source = runtime
        .get(&thread_id)
        .map_err(|e| e.log_and_convert("thread_move"))?;
    panes.stamp_runtime_kind(&mut source);
    if source.runtime_kind == Some(kalcode_contracts::threads::ThreadRuntimeKind::InteractivePty) {
        return Err(KalError::validation(
            "thread_is_coding_agent",
            "Coding agents remain in the workspace of their Code pane.",
        )
        .log_and_convert("thread_move"));
    }
    runtime
        .move_to_workspace(&thread_id, &workspace_id)
        .map_err(|e| e.log_and_convert("thread_move"))
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

    struct CapabilitySpy {
        id: ProviderId,
        display_name: String,
        detection: ProviderDetection,
        capabilities: ProviderCapabilities,
    }

    impl CapabilitySpy {
        fn from_status(status: &ProviderStatus) -> Self {
            Self {
                id: status.id.clone(),
                display_name: status.display_name.clone(),
                detection: status.detection.clone().expect("cached detection"),
                capabilities: status.capabilities.clone(),
            }
        }
    }

    impl AgentProvider for CapabilitySpy {
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
            _config: SessionConfig,
            _sink: Box<dyn AgentEventSink>,
        ) -> Result<Box<dyn AgentSession>, ProviderError> {
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
            launch_origin: Default::default(),
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
    fn agent_operation_effort_is_normalized_per_provider_without_fallback() {
        // Operations carries the selected effort (Squads and ordinary agent tasks alike); the
        // provider adapter is the sole authority on which values exist. Nothing falls back.
        let mut spec = agent_operation_spec();
        spec.effort = Some("high".into());
        validate_agent_operation(&spec).expect("effort is an accepted agent field");
        assert_eq!(
            operation_effort(ProviderId::CODEX, Some("high")).expect("codex effort"),
            Some("high".into())
        );
        for provider_default in ["", "default"] {
            assert_eq!(
                operation_effort(ProviderId::CODEX, Some(provider_default))
                    .expect("provider default"),
                None
            );
        }
        assert_eq!(
            operation_effort(ProviderId::CODEX, Some("turbo"))
                .expect_err("unknown effort")
                .code,
            "invalid_effort"
        );
        assert_eq!(
            operation_effort(ProviderId::GEMINI_CLI, Some("high"))
                .expect_err("provider without effort levels")
                .code,
            "invalid_effort"
        );
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
        core: Arc<Core>,
        store: AccountStore,
        profiles: ManagedProfiles,
        workspace_id: String,
        // Last: fields drop in declaration order, so Core closes kalcode.lock and the db first.
        // Dropped earlier, the TempDir silently survives on Windows.
        _temp: tempfile::TempDir,
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
            std::fs::create_dir_all(temp_root.join("workspace"))
                .expect("workspace fixture directory");
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
    fn cached_provider_capabilities_are_synced_before_recovery_summaries() {
        let fixture = AccountFixture::new();
        let providers = Arc::new(ProviderRegistry::new());
        let runtime = ThreadRuntime::new(
            fixture.core.clone(),
            providers.clone(),
            Arc::new(CoreWorkspaces::new(fixture.core.clone())),
            Arc::new(kalcode_contracts::permissions::AskUnlessReadGate),
        )
        .expect("runtime");

        let mut resumable_status = kalcode_providers::catalog::statuses()
            .into_iter()
            .find(|status| status.capabilities.resume)
            .expect("catalog provider with resume support");
        resumable_status.detection = Some(ProviderDetection {
            provider_id: resumable_status.id.clone(),
            display_name: resumable_status.display_name.clone(),
            state: DetectionState::Installed,
            display_path: None,
            version: None,
            minimum_version: None,
            auth: AuthState::Authenticated,
            message: None,
            checked_at: "cached".into(),
        });
        let mut no_resume_status = resumable_status.clone();
        no_resume_status.id = ProviderId::new("no-resume-fixture");
        no_resume_status.display_name = "No resume fixture".into();
        no_resume_status.capabilities.resume = false;
        no_resume_status.detection = Some(ProviderDetection {
            provider_id: no_resume_status.id.clone(),
            display_name: no_resume_status.display_name.clone(),
            ..no_resume_status
                .detection
                .clone()
                .expect("cached detection")
        });

        let resumable_id = kalcode_contracts::ids::new_id();
        let missing_session_id = kalcode_contracts::ids::new_id();
        let unsupported_id = kalcode_contracts::ids::new_id();
        let now = kalcode_core::time::now_rfc3339();
        let cwd = fixture._temp.path().join("workspace").display().to_string();
        fixture
            .core
            .transact(|tx| {
                for (id, status, session_id) in [
                    (&resumable_id, &resumable_status, Some("provider-session")),
                    (&missing_session_id, &resumable_status, None),
                    (&unsupported_id, &no_resume_status, Some("provider-session")),
                ] {
                    kalcode_threads::store::insert_thread(
                        tx,
                        &kalcode_threads::store::NewThreadRow {
                            id,
                            name: "Recovery fixture",
                            provider_id: &status.id,
                            provider_name: &status.display_name,
                            model: None,
                            effort: None,
                            provider_account_id: None,
                            account_label: None,
                            workspace_id: &fixture.workspace_id,
                            workspace_name: "Fixture",
                            cwd: &cwd,
                            permission_mode: PermissionMode::Approve,
                            now: &now,
                        },
                    )?;
                    kalcode_threads::store::set_status(
                        tx,
                        id,
                        ThreadStatus::Interrupted,
                        Some(kalcode_threads::runtime::SHUTDOWN_ACTIVITY),
                        &now,
                    )?;
                    if let Some(session_id) = session_id {
                        kalcode_threads::store::set_provider_session(tx, id, session_id, None)?;
                    }
                }
                Ok(((), Vec::new()))
            })
            .expect("durable recovery rows");

        assert!(
            !runtime.get(&resumable_id).expect("cold summary").resumable,
            "a cold process-local registry cannot claim resume before cached capabilities sync"
        );
        let statuses = vec![resumable_status.clone(), no_resume_status.clone()];
        let usable = statuses
            .iter()
            .map(|status| status.id.clone())
            .collect::<Vec<_>>();
        sync_cached_provider_statuses(&providers, statuses, &usable, |status| {
            Some(Arc::new(CapabilitySpy::from_status(status)))
        });

        assert!(
            runtime
                .get(&resumable_id)
                .expect("synced summary")
                .resumable
        );
        assert!(
            !runtime
                .get(&missing_session_id)
                .expect("missing session summary")
                .resumable
        );
        assert!(
            !runtime
                .get(&unsupported_id)
                .expect("unsupported summary")
                .resumable
        );
        runtime.shutdown();
    }

    #[test]
    fn provider_registry_sync_always_runs_after_optional_detection() {
        let detections = std::cell::Cell::new(0);
        let syncs = std::cell::Cell::new(0);
        ensure_cached_provider_registry(
            false,
            || detections.set(detections.get() + 1),
            || syncs.set(syncs.get() + 1),
        );
        assert_eq!(detections.get(), 0, "cached status must skip detection");
        assert_eq!(syncs.get(), 1, "cached status must still sync");

        ensure_cached_provider_registry(
            true,
            || detections.set(detections.get() + 1),
            || syncs.set(syncs.get() + 1),
        );
        assert_eq!(detections.get(), 1, "empty status must run detection once");
        assert_eq!(syncs.get(), 2, "fresh detection must sync before summaries");
    }

    #[test]
    fn account_error_observer_expires_only_the_selected_claude_account() {
        let fixture = AccountFixture::new();
        let selected = fixture
            .store
            .create(ProviderId::CLAUDE_CODE, "Claude A")
            .expect("selected account");
        let other = fixture
            .store
            .create(ProviderId::CLAUDE_CODE, "Claude B")
            .expect("other account");
        let observer = AccountProviderErrorObserver {
            accounts: fixture.store.clone(),
        };
        for account in [&selected, &other] {
            fixture
                .store
                .mark_authentication(&account.id, AuthState::Authenticated, None, None)
                .expect("authenticate fixture account");
        }

        for code in [
            "api_authentication_failed",
            "api_oauth_org_not_allowed",
            "provider_authentication_failed",
            "provider_oauth_org_not_allowed",
        ] {
            fixture
                .store
                .mark_authentication(&selected.id, AuthState::Authenticated, None, None)
                .expect("reset selected account");
            observer
                .observe(
                    &ProviderId::new(ProviderId::CLAUDE_CODE),
                    &selected.id,
                    code,
                )
                .expect("structured auth failure");
            let expired = fixture.store.get(&selected.id).expect("selected account");
            assert_eq!(expired.authentication_state, AuthState::NotAuthenticated);
            assert_eq!(expired.last_error_code.as_deref(), Some(code));
            assert_eq!(
                fixture
                    .store
                    .get(&other.id)
                    .expect("other account")
                    .authentication_state,
                AuthState::Authenticated
            );
        }
    }

    #[test]
    fn account_error_observer_ignores_transient_and_cross_provider_errors() {
        let fixture = AccountFixture::new();
        let account = fixture
            .store
            .create(ProviderId::CLAUDE_CODE, "Claude A")
            .expect("account");
        fixture
            .store
            .mark_authentication(&account.id, AuthState::Authenticated, None, None)
            .expect("authenticated account");
        let observer = AccountProviderErrorObserver {
            accounts: fixture.store.clone(),
        };

        for (provider, code) in [
            (ProviderId::CLAUDE_CODE, "api_rate_limit"),
            (ProviderId::CLAUDE_CODE, "provider_billing_error"),
            (ProviderId::CLAUDE_CODE, "api_cloud_credential_error"),
            (ProviderId::CLAUDE_CODE, "process_exited"),
            (ProviderId::CODEX, "api_authentication_failed"),
        ] {
            observer
                .observe(&ProviderId::new(provider), &account.id, code)
                .expect("ignored error");
            assert_eq!(
                fixture
                    .store
                    .get(&account.id)
                    .expect("unchanged account")
                    .authentication_state,
                AuthState::Authenticated,
                "{provider}/{code} must not infer expiry"
            );
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
    fn direct_creation_preserves_native_sign_in_while_operations_require_a_connected_account() {
        let fixture = AccountFixture::new();
        let account = fixture.store.create("codex", "Codex").expect("account");
        assert!(
            fixture
                .resolve("codex", Some(&account.id), None)
                .expect("unknown auth preserves native launch parity")
                .is_some()
        );
        fixture
            .store
            .mark_authentication(&account.id, AuthState::NotAuthenticated, None, None)
            .expect("mark signed out");
        let resolved = fixture
            .resolve("codex", Some(&account.id), None)
            .expect("direct native pane can present provider sign-in")
            .expect("resolved account");
        assert_eq!(resolved.authentication_state, AuthState::NotAuthenticated);
        let operation_request = CreateThread {
            provider_id: "codex".into(),
            provider_account_id: Some(account.id.clone()),
            account_label: Some(account.display_name.clone()),
            workspace_id: fixture.workspace_id.clone(),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Approve,
            prompt: "work".into(),
            name: None,
        };
        assert_eq!(
            validate_operation_account_authenticated(&fixture.core, &operation_request)
                .expect_err("orchestrated launch requires reconnect")
                .code,
            "provider_account_not_authenticated"
        );
        fixture
            .store
            .mark_authentication(&account.id, AuthState::Authenticated, None, None)
            .expect("reconnect");
        assert!(
            validate_operation_account_authenticated(&fixture.core, &operation_request).is_ok()
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
        ) -> kalcode_core::Result<ThreadSummary> {
            rebind_thread_account(&self.accounts.core, &self.runtime, &thread.id, account_id)
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

        let rebound = fixture.rebind(&thread, &b.id).expect("rebind");
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
            assert_eq!(fixture.rebind(&thread, account).expect_err(code).code, code);
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
        let same = fixture.rebind(&thread, &a.id).expect("same account");
        assert_eq!(same.status, ThreadStatus::Idle);

        // Codex: an organization plan switches like any other (native provider parity).
        let codex_thread = fixture.idle_thread(ProviderId::CODEX, &work);
        fixture
            .rebind(&codex_thread, &org.id)
            .expect("organization plans switch like any other");
        assert_eq!(fixture.codex.launches().len(), 1);

        fixture.runtime.stop(&thread.id).expect("stop");
        fixture.runtime.archive(&thread.id).expect("archive");
        let archived = fixture.runtime.get(&thread.id).expect("archived thread");
        assert_eq!(
            fixture
                .rebind(&archived, &a.id)
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
                .rebind(&archived, &b.id)
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
            .rebind(&restored, &b.id)
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

        // Owner directive 2026-10-03: Bypass starts without a separate confirmation.
        validate_create_controls(PermissionMode::Bypass, None, None)
            .expect("bypass without confirmation");
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

    #[test]
    fn operation_agents_preserve_the_selected_startable_permission_mode() {
        let fixture = AccountFixture::new();
        let account = fixture.store.create("codex", "Work").expect("account");
        fixture
            .store
            .mark_authentication(&account.id, AuthState::Authenticated, None, None)
            .expect("authenticated account");
        let providers = Arc::new(ProviderRegistry::new());
        providers.register(Arc::new(StartSpy::default()));
        let runtime = ThreadRuntime::new(
            fixture.core.clone(),
            providers,
            Arc::new(CoreWorkspaces::new(fixture.core.clone())),
            Arc::new(kalcode_contracts::permissions::AskUnlessReadGate),
        )
        .expect("runtime");
        let mut spec = agent_operation_spec();
        spec.workspace_id = fixture.workspace_id.clone();
        for mode in [
            PermissionMode::Plan,
            PermissionMode::Approve,
            PermissionMode::Auto,
            DEFAULT_CODING_PERMISSION_MODE,
        ] {
            let request =
                operation_request(&fixture.core, &runtime, &spec, mode).expect("operation request");
            assert_eq!(request.permission_mode, mode);
        }
        assert_eq!(DEFAULT_CODING_PERMISSION_MODE, PermissionMode::Bypass);
        runtime.shutdown();
    }

    #[test]
    fn thread_options_start_in_bypass_unless_plan_and_never_infer_custom() {
        // Owner directive 2026-10-03: no approvals; only read-only Plan is preserved.
        let mut options = ThreadOptions {
            providers: Vec::new(),
            workspaces: Vec::new(),
            permission_modes: vec![
                PermissionMode::Plan,
                PermissionMode::Approve,
                PermissionMode::Auto,
                PermissionMode::Bypass,
            ],
            default_permission_mode: PermissionMode::Bypass,
        };
        apply_saved_permission_settings(
            &mut options,
            &PermissionSettings {
                default_mode: PermissionMode::Plan,
                default_profile_id: None,
            },
        );
        assert_eq!(options.default_permission_mode, PermissionMode::Plan);
        for mode in [
            PermissionMode::Approve,
            PermissionMode::Auto,
            PermissionMode::Bypass,
            PermissionMode::Custom,
        ] {
            apply_saved_permission_settings(
                &mut options,
                &PermissionSettings {
                    default_mode: mode,
                    default_profile_id: None,
                },
            );
            assert_eq!(
                options.default_permission_mode,
                PermissionMode::Bypass,
                "{mode:?}"
            );
            assert!(!options.permission_modes.contains(&PermissionMode::Custom));
        }
    }

    // ---------------------------------------------------------------- Agent Fleet worktrees

    fn git_output(dir: &std::path::Path, args: &[&str]) -> std::process::Output {
        let mut command = std::process::Command::new("git");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            command.creation_flags(0x0800_0000);
        }
        command
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("spawn git")
    }

    fn plain_git(dir: &std::path::Path, args: &[&str]) {
        let out = git_output(dir, args);
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    struct FleetFixture {
        accounts: AccountFixture,
        spy: Arc<StartSpy>,
        runtime: ThreadRuntime,
        git: Arc<kalcode_git::GitCore>,
        root: kalcode_git::WorkspaceRoot,
    }

    impl FleetFixture {
        fn new(repository: bool) -> Self {
            let accounts = AccountFixture::new();
            let folder = accounts._temp.path().join("workspace");
            std::fs::create_dir_all(&folder).expect("workspace folder");
            if repository {
                plain_git(&folder, &["init", "-q", "-b", "main"]);
                for (key, value) in [
                    ("user.name", "Test User"),
                    ("user.email", "test@example.invalid"),
                    ("commit.gpgSign", "false"),
                    ("core.autocrlf", "false"),
                ] {
                    plain_git(&folder, &["config", key, value]);
                }
                std::fs::write(folder.join("README.md"), "hello\n").expect("readme");
                plain_git(&folder, &["add", "-A"]);
                plain_git(&folder, &["commit", "-q", "--no-verify", "-m", "initial"]);
            }
            let root = kalcode_git::WorkspaceRoot::new(&accounts.workspace_id, &folder)
                .expect("workspace root");
            let spy = Arc::new(StartSpy::default());
            let registry = Arc::new(ProviderRegistry::new());
            registry.register(spy.clone());
            let runtime = ThreadRuntime::new(
                accounts.core.clone(),
                registry,
                Arc::new(OneWorkspace(kalcode_threads::ResolvedWorkspace {
                    id: accounts.workspace_id.clone(),
                    name: "Fixture".into(),
                    root: root.path().to_path_buf(),
                })),
                Arc::new(kalcode_contracts::permissions::AskUnlessReadGate),
            )
            .expect("runtime");
            let git = Arc::new(kalcode_git::GitCore::new(
                &accounts._temp.path().join("data"),
            ));
            runtime.set_thread_worktrees(Arc::new(DesktopThreadWorktrees::new(
                accounts.core.clone(),
                git.clone(),
            )));
            Self {
                accounts,
                spy,
                runtime,
                git,
                root,
            }
        }

        fn request(&self, name: Option<&str>, model: Option<&str>) -> CreateThread {
            CreateThread {
                provider_id: ProviderId::CODEX.into(),
                provider_account_id: None,
                account_label: None,
                workspace_id: self.accounts.workspace_id.clone(),
                model: model.map(str::to_owned),
                effort: None,
                permission_mode: PermissionMode::Approve,
                prompt: "fix the login bug".into(),
                name: name.map(str::to_owned),
            }
        }

        fn create(&self, request: CreateThread) -> kalcode_core::Result<ThreadSummary> {
            create_thread_in_worktree(
                &self.accounts.core,
                &self.git,
                &self.runtime,
                &self.root,
                request,
                None,
            )
        }

        fn worktrees(&self) -> Vec<kalcode_git::types::Worktree> {
            self.accounts
                .core
                .read(|conn| {
                    kalcode_git::store::list_worktrees(conn, &self.accounts.workspace_id, true)
                })
                .expect("worktrees")
        }

        fn states(&self, thread_id: &str) -> Vec<kalcode_contracts::threads::ThreadWorktreeState> {
            let (row, path) = self
                .accounts
                .core
                .read(|conn| kalcode_git::store::active_thread_worktree(conn, thread_id))
                .expect("lookup")
                .expect("bound");
            crate::git_commands::thread_worktree_states_for(
                &self.git,
                vec![(thread_id.to_owned(), row, path, self.root.clone())],
            )
        }
    }

    #[test]
    fn thread_branch_names_are_safe_slugs_with_the_ids_random_tail() {
        let id = "0192f3c4-0000-7000-8000-00000000abcd";
        assert_eq!(
            thread_branch_name(Some("Fix the Login bug!"), id),
            "kal/fix-the-login-bug-0000abcd"
        );
        assert_eq!(thread_branch_name(None, id), "kal/agent-0000abcd");
        assert_eq!(
            thread_branch_name(Some("  \u{2728} "), id),
            "kal/agent-0000abcd"
        );
        let long = thread_branch_name(Some(&"x".repeat(100)), id);
        assert_eq!(long, format!("kal/{}-0000abcd", "x".repeat(32)));
        for name in [Some("../.lock"), Some("-a"), Some("a//b@{"), None] {
            kalcode_git::repo::validate_branch_name(&thread_branch_name(name, id))
                .expect("valid branch");
        }
    }

    #[test]
    fn isolated_thread_runs_in_its_own_worktree_and_reports_its_branch() {
        let fixture = FleetFixture::new(true);
        let thread = fixture
            .create(fixture.request(Some("Fix login"), None))
            .expect("isolated thread");
        let branch = thread.branch.clone().expect("branch");
        assert!(branch.starts_with("kal/fix-login-"), "{branch}");
        let worktree_id = thread.worktree_id.clone().expect("worktree id");
        let rows = fixture.worktrees();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, worktree_id);
        assert_eq!(rows[0].owner_ref.as_deref(), Some(thread.id.as_str()));
        assert_eq!(rows[0].branch, branch);
        let path = fixture
            .accounts
            .core
            .read(|conn| kalcode_git::store::worktree_path(conn, &worktree_id))
            .expect("path");
        let starts = fixture.spy.starts();
        assert_eq!(starts.len(), 1);
        let cwd = std::path::PathBuf::from(&starts[0].working_directory);
        assert_eq!(
            cwd,
            kalcode_core::workspaces::canonical_folder(&path).expect("canonical")
        );
        assert!(cwd.join("README.md").exists());
        assert_ne!(cwd, fixture.root.path());
        // The summary every surface reads carries the binding too.
        let listed = fixture.runtime.get(&thread.id).expect("get");
        assert_eq!(listed.worktree_id.as_deref(), Some(worktree_id.as_str()));

        // Git facts for the Fleet: level with main, clean, merges cleanly.
        let states = fixture.states(&thread.id);
        assert_eq!(states.len(), 1);
        let state = &states[0];
        assert_eq!(state.worktree_id, worktree_id);
        assert_eq!(state.base_branch.as_deref(), Some("main"));
        assert_eq!((state.ahead, state.behind), (Some(0), Some(0)));
        assert_eq!((state.changed, state.untracked), (0, 0));
        assert_eq!(state.conflicts, Some(false));
        std::fs::write(cwd.join("new.txt"), "agent").expect("write");
        assert_eq!(fixture.states(&thread.id)[0].untracked, 1);
    }

    #[test]
    fn prepared_operation_adopts_its_canonical_worktree_after_a_pre_thread_crash() {
        use kalcode_git::types::WorktreePurpose;

        let fixture = FleetFixture::new(true);
        let operation_id = kalcode_contracts::ids::new_id();
        let request = fixture.request(Some("Crash recovery"), None);
        let branch = operation_branch_name(request.name.as_deref(), &operation_id);
        let head =
            String::from_utf8(git_output(fixture.root.path(), &["rev-parse", "HEAD"]).stdout)
                .expect("head utf8")
                .trim()
                .to_owned();
        let repo = fixture
            .git
            .repo(&fixture.root)
            .expect("repo lookup")
            .expect("repository");
        let new = kalcode_git::worktree::create_managed(
            fixture.git.git().expect("git"),
            &repo,
            fixture.git.worktrees_root(),
            &branch,
            Some(&head),
            WorktreePurpose::Thread,
            Some(operation_id.clone()),
        )
        .expect("pre-crash worktree");
        let saved = fixture
            .accounts
            .core
            .write_with_events(|tx| {
                Ok((kalcode_git::store::insert_worktree(tx, &new)?, Vec::new()))
            })
            .expect("canonical worktree row")
            .0;
        assert!(
            fixture.runtime.get(&operation_id).is_err(),
            "the crash fixture has no thread yet"
        );

        let thread = create_operation_in_worktree(
            &fixture.accounts.core,
            &fixture.git,
            &fixture.runtime,
            &fixture.root,
            &operation_id,
            request,
            false,
            LaunchOrigin::User,
            Some(&head),
            None,
        )
        .expect("resume prepared operation");

        assert_eq!(thread.id, operation_id);
        assert_eq!(thread.worktree_id.as_deref(), Some(saved.id.as_str()));
        assert_eq!(fixture.worktrees().len(), 1, "no duplicate worktree row");
        let starts = fixture.spy.starts();
        assert_eq!(starts.len(), 1);
        assert_eq!(
            kalcode_core::workspaces::canonical_folder(std::path::Path::new(
                &starts[0].working_directory
            ))
            .expect("started cwd"),
            kalcode_core::workspaces::canonical_folder(&new.path).expect("saved worktree cwd")
        );
    }

    #[test]
    fn failed_isolated_creation_leaves_no_worktree_row_or_branch_behind() {
        let fixture = FleetFixture::new(true);
        // A request the runtime refuses never reaches the checkout.
        let mut request = fixture.request(Some("Broken"), None);
        request.provider_id = ProviderId::GEMINI_CLI.into();
        let error = fixture.create(request).expect_err("unknown provider");
        assert_eq!(error.code, "provider_unavailable");
        assert!(
            fixture.worktrees().is_empty(),
            "no checkout for a refused request"
        );
        assert_eq!(
            git_output(fixture.root.path(), &["worktree", "list"])
                .stdout
                .iter()
                .filter(|b| **b == b'\n')
                .count(),
            1
        );
        assert!(fixture.spy.starts().is_empty());
        assert!(
            fixture
                .runtime
                .list(None, true)
                .expect("threads")
                .is_empty()
        );
    }

    #[test]
    fn rollback_marks_the_row_removed_only_when_the_folder_is_gone() {
        use kalcode_git::types::{WorktreePurpose, WorktreeStatus};
        let fixture = FleetFixture::new(true);
        let exe = fixture.git.git().expect("git");
        let repo = fixture
            .git
            .repo(&fixture.root)
            .expect("repo")
            .expect("repo");
        let make = |branch: &str| {
            let new = kalcode_git::worktree::create_managed(
                exe,
                &repo,
                fixture.git.worktrees_root(),
                branch,
                None,
                WorktreePurpose::Thread,
                Some(kalcode_contracts::ids::new_id()),
            )
            .expect("worktree");
            let row = fixture
                .accounts
                .core
                .write_with_events(|tx| {
                    Ok((kalcode_git::store::insert_worktree(tx, &new)?, Vec::new()))
                })
                .expect("row")
                .0;
            (new, row)
        };
        let status = |id: &str| {
            fixture
                .accounts
                .core
                .read(|conn| kalcode_git::store::get_worktree(conn, id))
                .expect("row")
                .status
        };
        let (clean, clean_row) = make("kal/clean-1");
        roll_back_thread_worktree(
            &fixture.accounts.core,
            exe,
            &repo,
            &clean,
            Some(&clean_row.id),
        );
        assert_eq!(status(&clean_row.id), WorktreeStatus::Removed);
        assert!(!clean.path.exists());
        assert!(
            !git_output(
                fixture.root.path(),
                &["rev-parse", "--verify", "--quiet", "refs/heads/kal/clean-1"]
            )
            .status
            .success()
        );
        let (dirty, dirty_row) = make("kal/dirty-1");
        std::fs::write(dirty.path.join("work.txt"), "unsaved").expect("write");
        roll_back_thread_worktree(
            &fixture.accounts.core,
            exe,
            &repo,
            &dirty,
            Some(&dirty_row.id),
        );
        assert_eq!(status(&dirty_row.id), WorktreeStatus::Abandoned);
        assert!(dirty.path.join("work.txt").exists(), "nothing is lost");
    }

    #[test]
    fn a_lost_worktree_is_reattached_from_its_branch_and_never_the_main_folder() {
        let fixture = FleetFixture::new(true);
        let thread = fixture
            .create(fixture.request(Some("Lost"), None))
            .expect("isolated thread");
        let branch = thread.branch.clone().expect("branch");
        let first = std::path::PathBuf::from(&fixture.spy.starts()[0].working_directory);
        // The agent committed work, then the folder was deleted by hand.
        std::fs::write(first.join("agent.txt"), "committed\n").expect("write");
        plain_git(&first, &["add", "-A"]);
        plain_git(&first, &["commit", "-q", "--no-verify", "-m", "agent"]);
        std::fs::remove_dir_all(&first).expect("delete worktree folder");

        let resumed = fixture
            .runtime
            .resume(&thread.id, Some("go on"))
            .expect("resume");
        let starts = fixture.spy.starts();
        assert_eq!(starts.len(), 2);
        let second = std::path::PathBuf::from(&starts[1].working_directory);
        assert_ne!(second, first);
        assert_ne!(second, fixture.root.path(), "never the main folder");
        assert_eq!(
            std::fs::read_to_string(second.join("agent.txt")).expect("work is back"),
            "committed\n"
        );
        assert_eq!(resumed.branch.as_deref(), Some(branch.as_str()));
        assert_ne!(resumed.worktree_id, thread.worktree_id);
        let rows = fixture.worktrees();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.iter()
                .filter(|r| r.status == kalcode_git::types::WorktreeStatus::Active)
                .count(),
            1
        );

        // Without its branch there is nothing safe to run in: refused, no launch.
        std::fs::remove_dir_all(&second).expect("delete again");
        plain_git(fixture.root.path(), &["worktree", "prune"]);
        plain_git(fixture.root.path(), &["branch", "-D", &branch]);
        let error = fixture
            .runtime
            .resume(&thread.id, Some("again"))
            .expect_err("no branch");
        assert_eq!(error.code, "thread_folder_unavailable");
        assert_eq!(fixture.spy.starts().len(), 2);
    }

    #[test]
    fn archiving_frees_a_clean_worktree_and_resume_brings_it_back() {
        use kalcode_git::types::WorktreeStatus;
        let fixture = FleetFixture::new(true);
        let thread = fixture
            .create(fixture.request(Some("Archive me"), None))
            .expect("isolated thread");
        let branch = thread.branch.clone().expect("branch");
        let folder = std::path::PathBuf::from(&fixture.spy.starts()[0].working_directory);

        // Uncommitted work keeps the folder.
        std::fs::write(folder.join("draft.txt"), "unsaved").expect("write");
        let archived = fixture.runtime.archive(&thread.id).expect("archive");
        assert!(folder.join("draft.txt").exists());
        assert_eq!(archived.worktree_id, thread.worktree_id);
        fixture.runtime.unarchive(&thread.id).expect("unarchive");

        // A clean worktree is freed on archive; its branch stays.
        std::fs::remove_file(folder.join("draft.txt")).expect("clean");
        let archived = fixture.runtime.archive(&thread.id).expect("archive");
        assert!(!folder.exists(), "the folder is freed");
        assert_eq!(archived.worktree_id, None);
        assert_eq!(fixture.worktrees()[0].status, WorktreeStatus::Removed);
        assert!(
            git_output(
                fixture.root.path(),
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{branch}")
                ]
            )
            .status
            .success(),
            "the branch is kept"
        );

        fixture.runtime.unarchive(&thread.id).expect("unarchive");
        let resumed = fixture
            .runtime
            .resume(&thread.id, Some("continue"))
            .expect("resume");
        assert_eq!(resumed.branch.as_deref(), Some(branch.as_str()));
        let cwd = std::path::PathBuf::from(
            &fixture
                .spy
                .starts()
                .last()
                .expect("start")
                .working_directory,
        );
        assert_ne!(cwd, fixture.root.path());
        assert!(cwd.join("README.md").exists());
    }

    #[test]
    fn isolation_outside_git_is_refused_without_a_fallback() {
        let fixture = FleetFixture::new(false);
        let error = fixture
            .create(fixture.request(None, None))
            .expect_err("not a repository");
        assert_eq!(error.code, "worktree_unavailable");
        assert_eq!(
            error.message,
            "This workspace isn't a Git repository, so the thread can't get its own worktree."
        );
        assert!(fixture.spy.starts().is_empty());
        assert!(fixture.worktrees().is_empty());
    }

    #[test]
    fn thread_worktree_states_args_are_bounded_and_validated() {
        use crate::git_commands::{MAX_THREAD_WORKTREE_STATES, thread_ids_arg};
        let id = kalcode_contracts::ids::new_id();
        assert_eq!(
            thread_ids_arg(vec![id.clone(), id.clone()]).expect("dedupe"),
            std::slice::from_ref(&id)
        );
        assert!(thread_ids_arg(Vec::new()).expect("empty").is_empty());
        let max: Vec<String> = (0..MAX_THREAD_WORKTREE_STATES)
            .map(|_| kalcode_contracts::ids::new_id())
            .collect();
        assert_eq!(thread_ids_arg(max.clone()).expect("max").len(), max.len());
        let mut over = max;
        over.push(kalcode_contracts::ids::new_id());
        for bad in [
            over,
            vec!["../x".into()],
            vec!["not-a-uuid".into()],
            vec![String::new()],
        ] {
            assert_eq!(
                thread_ids_arg(bad).expect_err("invalid").code,
                "invalid_thread_ids"
            );
        }
        assert!(crate::command_registry::COMMANDS.contains(&"thread_worktree_states"));
        assert!(crate::command_registry::COMMANDS.contains(&"thread_worktree_commit"));
    }

    #[test]
    fn committing_an_agents_worktree_validates_refuses_and_records_the_commit() {
        use crate::git_commands::commit_thread_worktree;
        let fixture = FleetFixture::new(true);
        let commit = |thread_id: &str, message: &str| {
            commit_thread_worktree(
                &fixture.accounts.core,
                &fixture.git,
                &fixture.runtime,
                thread_id,
                message,
            )
        };
        let code = |result: kalcode_core::Result<
            kalcode_contracts::threads::ThreadWorktreeState,
        >| { result.expect_err("refused").code };

        // Argument validation comes first.
        assert_eq!(code(commit("not-an-id", "m")), "invalid_thread_id");
        let unknown = kalcode_contracts::ids::new_id();
        for bad in ["", "  \n ", "a\0b", "esc\u{1b}[0m", &"x".repeat(2_001)] {
            assert_eq!(code(commit(&unknown, bad)), "invalid_commit_message");
        }
        assert_eq!(code(commit(&unknown, "m")), "thread_not_found");

        // A thread running in the workspace folder has no worktree to commit.
        let shared = fixture
            .runtime
            .create(fixture.request(Some("Shared"), None))
            .expect("shared thread");
        assert_eq!(code(commit(&shared.id, "m")), "worktree_unknown");

        let thread = fixture
            .create(fixture.request(Some("Commit me"), None))
            .expect("isolated thread");
        let branch = thread.branch.clone().expect("branch");
        let folder = std::path::PathBuf::from(&fixture.spy.starts()[1].working_directory);
        assert_eq!(code(commit(&thread.id, "m")), "nothing_to_commit");

        // Never while the agent may still be changing files.
        std::fs::write(folder.join("feature.txt"), "agent work\n").expect("write");
        let set_status = |status: ThreadStatus| {
            fixture
                .accounts
                .core
                .write_with_events(|tx| {
                    kalcode_threads::store::set_status(tx, &thread.id, status, None, "t")?;
                    Ok(((), Vec::new()))
                })
                .expect("status");
        };
        for busy in [
            ThreadStatus::Thinking,
            ThreadStatus::WaitingForPermission,
            ThreadStatus::Paused,
        ] {
            set_status(busy);
            let error = commit(&thread.id, "m").expect_err("busy");
            assert_eq!(error.code, "thread_busy");
            assert_eq!(
                error.message,
                "Stop or wait for the agent before committing its work."
            );
        }
        set_status(ThreadStatus::Idle);

        let main_head = git_output(fixture.root.path(), &["rev-parse", "HEAD"]).stdout;
        let state = commit(&thread.id, "Add the feature").expect("commit");
        assert_eq!(state.branch, branch);
        assert_eq!((state.ahead, state.behind), (Some(1), Some(0)));
        assert_eq!((state.changed, state.untracked), (0, 0));
        assert_eq!(state.conflicts, Some(false));
        assert_eq!(
            git_output(fixture.root.path(), &["rev-parse", "HEAD"]).stdout,
            main_head,
            "the main checkout is untouched"
        );
        assert!(!fixture.root.path().join("feature.txt").exists());
        let events = fixture
            .accounts
            .core
            .recent_events(50, None)
            .expect("events");
        let recorded = events
            .iter()
            .find(|e| e.event.type_name() == "git.commit_created")
            .expect("git.commit_created");
        assert_eq!(
            recorded.correlation.thread_id.as_deref(),
            Some(thread.id.as_str())
        );
        assert_eq!(
            recorded.correlation.workspace_id.as_deref(),
            Some(fixture.accounts.workspace_id.as_str())
        );
        assert_eq!(code(commit(&thread.id, "again")), "nothing_to_commit");

        // A worktree folder that is gone.
        std::fs::remove_dir_all(&folder).expect("delete");
        assert_eq!(code(commit(&thread.id, "m")), "worktree_missing");
    }
}
