//! Provider pane IPC (campaign Z7-W4, docs/PROVIDER_PANES.md). Behind the `provider_panes`
//! feature flag: when it is not visible for this build's channel, no bridge endpoint is opened
//! and every command refuses.
//!
//! - `provider_pane_create`: a new thread whose provider runs interactively in a pane (Claude
//!   Code today). Everything else about the thread (stop, rename, archive, approvals) uses the
//!   existing thread and approval commands; there is one runtime and one status model.
//! - `provider_pane_attach` / `_ack` / `_detach`: the pane's PTY output, with Z1 flow control.
//! - `provider_pane_write` / `_resize`: the person's keystrokes and the view size.
//! - `provider_pane_info`: hook-channel state for the header and info panel.
//!
//! The WebView never supplies an executable, path, argument or environment: the provider,
//! helper, working directory and settings are all native-resolved.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use kalcode_contracts::agent::{AgentProvider, ProviderId};
use kalcode_contracts::app::FeatureId;
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::threads::{ThreadError, ThreadRuntimeKind, ThreadStatus, ThreadSummary};
use kalcode_core::{ErrorCategory, IpcError, KalError};
use kalcode_hook_bridge::Endpoint;
use kalcode_hook_bridge::server::{BridgeServer, BridgeShutdownError, ServerConfig};
use kalcode_permissions::PermissionService;
use kalcode_providers::DetectEnv;
use kalcode_providers::interactive::cli_pane::{InteractiveCliProvider, PaneCli};
use kalcode_providers::interactive::provider::{
    InteractiveClaudeProvider, InteractiveConfig, PaneRegistry, RuntimeRouter, mark_interactive,
    marked_interactive, marked_interactive_checked, unmark_interactive,
};
use kalcode_providers::interactive::session::PaneVoiceWriteError;
use kalcode_providers::interactive::session::SessionLimits;
use kalcode_providers::interactive::{
    ApprovalExpiry, DEFAULT_DECISION_ROUTING, DecisionRouting, HookChannelState, PaneInfo,
    TitleSink,
};
use kalcode_pty::{CoalesceConfig, OutputCoalescer};
use kalcode_threads::runtime::interrupted_by_application_exit;
use kalcode_threads::store::ThreadRow;
use kalcode_threads::{CreateIdleThread, ThreadRuntime};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State, Webview};

use crate::AppState;
use crate::provider_auth_commands::ProviderRuntimeAuthority;
use crate::thread_commands::ThreadsState;

/// Output a view may be behind before it is dropped (as for Z1 terminals).
const MAX_UNACKED_BYTES: usize = 4 * 1024 * 1024;
/// Attachments one webview may hold to one pane.
const MAX_VIEWS_PER_PANE: usize = 4;
const HOOK_HELPER: &str = if cfg!(windows) {
    "kalcode-hook.exe"
} else {
    "kalcode-hook"
};

/// Routes belong to one runtime epoch; a later login receives fresh providers and bridge.
#[derive(Clone, Default)]
pub struct PaneRoutes {
    claude: Option<Arc<InteractiveClaudeProvider>>,
    codex: Option<Arc<InteractiveCliProvider>>,
    gemini: Option<Arc<InteractiveCliProvider>>,
    cursor: Option<Arc<InteractiveCliProvider>>,
    sessions_dir: PathBuf,
}

impl PaneRoutes {
    /// Queue-owned coding agents keep their reserved ID and the same durable terminal marker
    /// as agents launched from Code, including a resource wait or a later retry.
    pub(crate) fn create_operation_pane(
        &self,
        runtime: &ThreadRuntime,
        operation_id: &str,
        create: impl FnOnce(&str) -> kalcode_core::Result<ThreadSummary>,
    ) -> kalcode_core::Result<ThreadSummary> {
        create_pane_thread_with_id(runtime, &self.sessions_dir, operation_id, create)
    }

    pub fn route_claude(
        &self,
        headless: Arc<dyn AgentProvider>,
        guard: impl Fn(Arc<dyn AgentProvider>, bool) -> Arc<dyn AgentProvider>,
    ) -> Arc<dyn AgentProvider> {
        let router = match self.claude.as_ref() {
            Some(interactive) => RuntimeRouter::new(headless, interactive.clone()),
            None => RuntimeRouter::without_interactive(headless, self.sessions_dir.clone()),
        };
        Arc::new(router.with_session_guards(guard))
    }

    /// Codex or Gemini CLI as the thread runtime should see it: the per-thread router when panes
    /// are enabled; unavailable terminals refuse while ordinary chat remains available.
    pub fn route_cli(
        &self,
        id: &str,
        headless: Arc<dyn AgentProvider>,
        guard: impl Fn(Arc<dyn AgentProvider>, bool) -> Arc<dyn AgentProvider>,
    ) -> Arc<dyn AgentProvider> {
        let interactive = match id {
            ProviderId::CODEX => self.codex.as_ref(),
            ProviderId::GEMINI_CLI => self.gemini.as_ref(),
            ProviderId::CURSOR => self.cursor.as_ref(),
            _ => None,
        };
        let router = match interactive {
            Some(interactive) => RuntimeRouter::for_provider(
                headless,
                interactive.clone(),
                interactive.sessions_dir(),
            ),
            None => RuntimeRouter::without_interactive(headless, self.sessions_dir.clone()),
        };
        Arc::new(router.with_session_guards(guard))
    }
}

/// Late-bound links to the engine and the runtime (both start after this state).
#[derive(Default)]
struct Glue {
    service: OnceLock<Weak<PermissionService>>,
    runtime: OnceLock<Weak<ThreadRuntime>>,
}

impl ApprovalExpiry for Glue {
    fn answered_in_provider(&self, thread_id: &str, action_id: &str) {
        if let Some(service) = self.service.get().and_then(Weak::upgrade)
            && let Err(error) = service.expire_answered_in_provider(thread_id, action_id)
        {
            tracing::warn!(event = "pane.expire_failed", error = %error.diagnostic());
        }
    }
}

impl TitleSink for Glue {
    fn terminal_prompt(&self, thread_id: &str, prompt: &str) {
        if kalcode_threads::naming::has_task_intent(prompt) {
            self.first_prompt(thread_id, prompt);
        }
    }

    fn first_prompt(&self, thread_id: &str, prompt: &str) {
        // The shared durable authority preserves manual names and stable task titles.
        let Some(runtime) = self.runtime.get().and_then(Weak::upgrade) else {
            return;
        };
        if let Err(error) = runtime.name_from_task(thread_id, prompt) {
            tracing::warn!(event = "pane.title_failed", error = %error.diagnostic());
        }
    }
}

struct View {
    label: String,
    thread_id: String,
    pty_attach: u64,
    unacked: Arc<AtomicUsize>,
    lagged: Arc<AtomicBool>,
}

/// Provider pane state for the shell.
pub struct ProviderPanesState {
    pub routes: PaneRoutes,
    enabled: bool,
    bridge: Option<Arc<BridgeServer>>,
    panes: Arc<PaneRegistry>,
    glue: Arc<Glue>,
    views: Mutex<HashMap<u64, View>>,
    next_view: AtomicU64,
    /// Why panes are unavailable (for the error shown when one is requested).
    unavailable: Option<&'static str>,
    /// `<data>/sessions`: pane markers survive restarts.
    sessions_dir: PathBuf,
    routing: DecisionRouting,
    /// Whether an Operations run owns a thread. Such panes are never offered to Smart Resume:
    /// Operations recovery owns them and never relaunches work automatically.
    operation_owned: Option<OperationOwner>,
}

type OperationOwner = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Reads ownership from the durable Operations ledger. Unreadable means owned: a pane is only
/// offered for automatic restore when it is provably not Operations work.
fn operation_owner(core: &Arc<kalcode_core::Core>) -> OperationOwner {
    let core = Arc::downgrade(core);
    Arc::new(move |thread_id: &str| {
        core.upgrade().is_none_or(|core| {
            kalcode_core::operations::owns_thread(&core.reader(), thread_id).unwrap_or(true)
        })
    })
}

/// `kalcode-hook` next to the KalCode executable. Debug and `e2e` builds may point at another
/// build of the helper with `KALCODE_E2E_HOOK_PROGRAM` (an absolute path).
fn hook_program() -> Option<PathBuf> {
    if crate::environment::TEST_HOOKS_ENABLED
        && let Some(path) = std::env::var_os("KALCODE_E2E_HOOK_PROGRAM").map(PathBuf::from)
        && path.is_absolute()
    {
        return Some(path);
    }
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(HOOK_HELPER))
}

/// A provider pane is unavailable unless its native hook helper is already installed. Checking
/// this at the pane-create boundary prevents writing a thread and interactive marker that can
/// never reach a PTY, while keeping the interactive provider route available to other callers.
fn hook_program_ready(path: &Path) -> bool {
    path.is_absolute() && path.is_file()
}

/// The decision routing for this build: the default (the engine decides), or, in debug and
/// `e2e` builds only, `KALCODE_E2E_HOOK_DECISIONS=engine|provider_prompt` (tests of both paths).
fn routing() -> DecisionRouting {
    if crate::environment::TEST_HOOKS_ENABLED {
        match std::env::var("KALCODE_E2E_HOOK_DECISIONS").as_deref() {
            Ok("engine") => return DecisionRouting::Engine,
            Ok("provider_prompt") => return DecisionRouting::ProviderPrompt,
            _ => {}
        }
    }
    DEFAULT_DECISION_ROUTING
}

impl ProviderPanesState {
    pub(crate) fn handoff_info(&self, thread_id: &str) -> Option<PaneInfo> {
        self.panes.info(thread_id)
    }

    pub(crate) fn deliver_handoff<F>(
        &self,
        thread_id: &str,
        expected_instance_id: &str,
        text: &str,
        before_write: F,
    ) -> Result<(), kalcode_providers::interactive::provider::HandoffDeliveryError>
    where
        F: FnOnce() -> Result<(), kalcode_providers::interactive::provider::HandoffDeliveryError>,
    {
        self.panes
            .deliver_handoff(thread_id, expected_instance_id, text, before_write)
    }

    pub(crate) fn handoff_readiness(
        &self,
        thread_id: &str,
        expected_instance_id: &str,
    ) -> Result<(), kalcode_providers::interactive::provider::HandoffDeliveryError> {
        self.panes
            .handoff_readiness(thread_id, expected_instance_id)
    }

    /// Returns whether `thread_id` belongs to an interactive provider pane in this runtime or
    /// was durably marked as one by an earlier runtime. Callers use this read-only preflight
    /// before claiming one-shot work that pane sessions cannot accept through the headless send
    /// path.
    pub(crate) fn is_interactive_thread(&self, thread_id: &str) -> Result<bool, KalError> {
        if self.panes.info(thread_id).is_some() {
            return Ok(true);
        }
        marked_interactive_checked(&self.sessions_dir, thread_id).map_err(|error| {
            KalError::new(
                ErrorCategory::Filesystem,
                "interactive_marker_unavailable",
                "KalCode couldn't verify whether this thread belongs to an interactive pane.",
            )
            .retryable()
            .with_source(error)
        })
    }

    /// Stamps how the thread's provider runs: `interactive_pty` for a provider pane (a coding
    /// agent in a Code terminal), `headless` for everything else. Agent surfaces (the Agents
    /// rail, Agent Fleet, KalVoice) use it to tell coding agents from chat threads.
    pub(crate) fn stamp_runtime_kind(&self, summary: &mut ThreadSummary) {
        let interactive = self.panes.info(&summary.id).is_some()
            || marked_interactive(&self.sessions_dir, &summary.id);
        if interactive {
            summary.can_move_workspace = Some(false);
        }
        summary.runtime_kind = Some(if interactive {
            ThreadRuntimeKind::InteractivePty
        } else {
            ThreadRuntimeKind::Headless
        });
        let recoverable = interactive
            && summary.archived_at.is_none()
            && interrupted_by_application_exit(summary.status, summary.current_activity.as_deref());
        summary.restart_recoverable = Some(
            recoverable
                && !self
                    .operation_owned
                    .as_ref()
                    .is_some_and(|owned| owned(&summary.id)),
        );
    }

    /// Starts the bridge when the feature is visible for this build, and registers the
    /// interactive provider for [`PaneRoutes::route_claude`]. Must run before threads start.
    pub fn start(
        app: &AppState,
        runtime: Option<ProviderRuntimeAuthority>,
        integrations: Option<Arc<crate::integration_bridge::IntegrationBridge>>,
    ) -> Self {
        let panes = Arc::new(PaneRegistry::new());
        let glue = Arc::new(Glue::default());
        let disabled = |reason| Self {
            routes: PaneRoutes {
                sessions_dir: app.paths.data_dir.join("sessions"),
                ..PaneRoutes::default()
            },
            enabled: false,
            bridge: None,
            panes: panes.clone(),
            glue: glue.clone(),
            views: Mutex::new(HashMap::new()),
            next_view: AtomicU64::new(1),
            unavailable: Some(reason),
            sessions_dir: app.paths.data_dir.join("sessions"),
            routing: DEFAULT_DECISION_ROUTING,
            operation_owned: app.core.as_ref().map(operation_owner),
        };
        let visible = app
            .info
            .flags
            .feature(FeatureId::ProviderPanes)
            .is_some_and(|flag| flag.visible);
        if !visible || app.core.is_none() {
            return disabled("Provider panes aren't available in this build yet.");
        }
        let Some(runtime) = runtime else {
            return disabled("Managed provider accounts aren't available. Restart KalCode.");
        };
        // Keep interactive routes registered even when the installed helper is temporarily
        // absent: KalVoice reaches the same provider router without this IPC command, and must
        // fail in the interactive adapter instead of silently falling back to headless. Pane
        // creation checks the file before writing any thread state; adapters recheck at start.
        let Some(hook_program) = hook_program() else {
            return disabled("KalCode's hook helper is missing. Reinstall KalCode.");
        };
        let bridge = Endpoint::generate(None)
            .and_then(|endpoint| BridgeServer::start(ServerConfig::new(endpoint)));
        let bridge = match bridge {
            Ok(bridge) => Arc::new(bridge),
            Err(error) => {
                // Includes a squatted pipe name (FILE_FLAG_FIRST_PIPE_INSTANCE): panes stay off.
                tracing::error!(event = "pane.bridge_failed", error = %error);
                return disabled("KalCode couldn't open its hook channel, so panes are off.");
            }
        };
        let routing = routing();
        let cli_config = InteractiveConfig {
            hook_program: hook_program.clone(),
            hook_prefix_args: Vec::new(),
            sessions_dir: app.paths.data_dir.join("sessions"),
            routing,
            limits: SessionLimits::default(),
        };
        let codex_runtime = runtime.clone();
        let mut codex_provider = InteractiveCliProvider::new(
            PaneCli::Codex,
            DetectEnv::from_process(),
            Some(bridge.clone()),
            cli_config.clone(),
            panes.clone(),
        )
        .with_managed_profiles(runtime.managed_profiles())
        .with_titles(glue.clone())
        .with_codex_cloud_config_resolver(move |account_id| {
            codex_runtime.codex_cloud_config(account_id)
        });
        if let Some(integrations) = integrations.clone() {
            codex_provider = codex_provider
                .with_integrations(Arc::new(move |config| integrations.connect(config)));
        }
        let codex = Some(Arc::new(codex_provider));
        let gemini = Some(Arc::new(
            InteractiveCliProvider::new(
                PaneCli::Gemini,
                DetectEnv::from_process(),
                None,
                cli_config.clone(),
                panes.clone(),
            )
            .with_managed_profiles(runtime.managed_profiles())
            .with_titles(glue.clone()),
        ));
        let cursor = Some(Arc::new(
            InteractiveCliProvider::new(
                PaneCli::Cursor,
                DetectEnv::from_process(),
                Some(bridge.clone()),
                cli_config,
                panes.clone(),
            )
            .with_managed_profiles(runtime.managed_profiles())
            .with_titles(glue.clone()),
        ));
        let mut provider = InteractiveClaudeProvider::new(
            DetectEnv::from_process(),
            bridge.clone(),
            InteractiveConfig {
                hook_program,
                hook_prefix_args: Vec::new(),
                sessions_dir: app.paths.data_dir.join("sessions"),
                routing,
                limits: SessionLimits::default(),
            },
            panes.clone(),
        )
        .with_managed_profiles(runtime.managed_profiles())
        .with_expiry(glue.clone())
        .with_titles(glue.clone());
        if let Some(integrations) = integrations {
            provider =
                provider.with_integrations(Arc::new(move |config| integrations.connect(config)));
        }
        let routes = PaneRoutes {
            claude: Some(Arc::new(provider)),
            codex,
            gemini,
            cursor,
            sessions_dir: app.paths.data_dir.join("sessions"),
        };
        tracing::info!(event = "pane.enabled", routing = ?routing);
        Self {
            routes,
            enabled: true,
            bridge: Some(bridge),
            panes,
            glue,
            views: Mutex::new(HashMap::new()),
            next_view: AtomicU64::new(1),
            unavailable: None,
            sessions_dir: app.paths.data_dir.join("sessions"),
            routing,
            operation_owned: app.core.as_ref().map(operation_owner),
        }
    }

    /// Links the engine (expiry) and the runtime (titles) once they exist.
    pub fn bind(
        &self,
        service: Option<&Arc<PermissionService>>,
        runtime: Option<&Arc<ThreadRuntime>>,
    ) {
        if let Some(service) = service {
            let _ = self.glue.service.set(Arc::downgrade(service));
        }
        if let Some(runtime) = runtime {
            let _ = self.glue.runtime.set(Arc::downgrade(runtime));
        }
    }

    fn require(&self) -> Result<(), IpcError> {
        if self.enabled {
            Ok(())
        } else {
            Err(KalError::validation(
                "provider_panes_unavailable",
                self.unavailable
                    .unwrap_or("Provider panes aren't available."),
            )
            .to_ipc())
        }
    }

    fn views(&self) -> std::sync::MutexGuard<'_, HashMap<u64, View>> {
        self.views
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Drops every attachment of a webview whose page (re)loaded.
    pub fn drop_views(&self, label: &str) {
        let released: Vec<View> = {
            let mut map = self.views();
            let ids: Vec<u64> = map
                .iter()
                .filter(|(_, v)| v.label == label)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter().filter_map(|id| map.remove(&id)).collect()
        };
        for view in released {
            self.panes.detach(&view.thread_id, view.pty_attach);
        }
    }

    /// Detaches every retained webview stream, then proves the hook listener has exited.
    pub fn shutdown_checked(&self) -> Result<(), BridgeShutdownError> {
        let views: Vec<View> = self.views().drain().map(|(_, view)| view).collect();
        for view in views {
            self.panes.detach(&view.thread_id, view.pty_attach);
        }
        self.bridge
            .as_ref()
            .map_or(Ok(()), |bridge| bridge.shutdown_checked())
    }

    /// Compatibility wrapper for callers that cannot surface shutdown failure yet.
    pub fn shutdown(&self) {
        if let Err(error) = self.shutdown_checked() {
            tracing::error!(event = "provider_panes.shutdown_incomplete", error = %error);
        }
    }
}

fn validate_thread_id(thread_id: &str) -> Result<(), IpcError> {
    if kalcode_contracts::ids::is_valid_id(thread_id) {
        Ok(())
    } else {
        Err(KalError::validation("invalid_thread", "That thread id isn't valid.").to_ipc())
    }
}

fn provider_error(error: kalcode_contracts::agent::ProviderError) -> IpcError {
    use kalcode_contracts::agent::ProviderError;
    // Backend errors may contain private paths or provider details. Only fixed,
    // user-safe copy crosses the IPC boundary.
    let message = match error {
        // The view can tell an ended pane from other failures (like `terminal_not_running`).
        ProviderError::SessionEnded => {
            return KalError::validation(
                "pane_not_running",
                "This agent's provider has ended. Resume the agent to start it again.",
            )
            .to_ipc();
        }
        ProviderError::NotInstalled => "The provider is not installed.",
        ProviderError::NotAuthenticated => "The provider is not signed in.",
        ProviderError::Unsupported => "The provider does not support this operation.",
        ProviderError::Start(_) => "The provider could not start. Try resuming the thread.",
        ProviderError::Io(_) => "KalCode could not communicate with this provider pane.",
        ProviderError::Protocol(_) => "The provider returned an unreadable response.",
        // Only genuine hard pressure or the person's own Custom limit holds a coding agent:
        // say which, and what they can do.
        ProviderError::ResourcesHeld(hold) => {
            let reason = hold.kind.phrase();
            let action = if hold.kind.freed_by_stopping_a_thread() {
                "Stop an agent you're not using, or choose Start Anyway."
            } else {
                "Run KalTidy to free resources, or choose Start Anyway."
            };
            let message = format!("This agent is waiting to start: {reason}. {action}");
            return KalError::validation(
                kalcode_contracts::threads::error_codes::WAITING_FOR_RESOURCES,
                message,
            )
            .to_ipc();
        }
        // KalCode's own fixed refusal copy (account in use, plan, version).
        ProviderError::Refused { message, .. } => {
            return KalError::validation("provider_launch_refused", message).to_ipc();
        }
    };
    KalError::validation("provider_pane_failed", message).to_ipc()
}

/// Thread creation retains a failed row so the person can repair the provider and resume it.
/// Creating a new pane still reports that recorded, user-safe startup failure to its caller;
/// only resource-held starts remain successful queued creations.
fn pane_create_failure(status: ThreadStatus, error: Option<&ThreadError>) -> Option<IpcError> {
    if status != ThreadStatus::Failed {
        return None;
    }
    Some(match error {
        Some(error) => IpcError {
            category: ErrorCategory::Provider,
            code: error.code.clone(),
            message: error.message.clone(),
            retryable: false,
        },
        None => KalError::new(
            ErrorCategory::Provider,
            "provider_pane_failed",
            "The provider could not start. Resume the agent to try again.",
        )
        .to_ipc(),
    })
}

struct PaneLaunchConfig {
    provider_id: String,
    provider_account_id: Option<String>,
    workspace_id: String,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: PermissionMode,
    name: Option<String>,
    cwd: Option<PathBuf>,
}

#[allow(clippy::too_many_arguments)]
fn pane_launch_config(
    provider_id: String,
    provider_account_id: Option<String>,
    workspace_id: String,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: PermissionMode,
    name: Option<String>,
    duplicate_source: Option<&ThreadRow>,
    context_source: Option<&ThreadRow>,
    switch_account_id: Option<&str>,
) -> PaneLaunchConfig {
    if let Some(source) = duplicate_source {
        return PaneLaunchConfig {
            provider_id: source.provider_id.to_string(),
            provider_account_id: switch_account_id
                .map(str::to_owned)
                .or_else(|| source.provider_account_id.clone()),
            workspace_id: source.workspace_id.clone(),
            model: source.model.clone(),
            effort: source.effort.clone(),
            permission_mode: source.permission_mode,
            name: None,
            cwd: Some(PathBuf::from(&source.cwd)),
        };
    }
    PaneLaunchConfig {
        provider_id,
        provider_account_id,
        workspace_id,
        model,
        effort,
        permission_mode,
        // A recovery fallback carries the task label into the new session. Every launch and
        // provider setting above remains the newly selected request's value.
        name: context_source.map(|source| source.name.clone()).or(name),
        cwd: context_source.map(|source| PathBuf::from(&source.cwd)),
    }
}

fn context_source_unavailable() -> IpcError {
    KalError::validation(
        "pane_context_source_unavailable",
        "That coding agent's workspace context is no longer available. Choose another agent.",
    )
    .to_ipc()
}

fn validate_pane_source_choice(
    duplicate_source_thread_id: Option<&str>,
    context_source_thread_id: Option<&str>,
) -> Result<(), IpcError> {
    if duplicate_source_thread_id.is_some() && context_source_thread_id.is_some() {
        return Err(KalError::validation(
            "pane_context_source_conflict",
            "Choose either Duplicate or Continue with context, not both.",
        )
        .to_ipc());
    }
    Ok(())
}

fn resolve_context_source(
    core: &kalcode_core::Core,
    panes: &ProviderPanesState,
    thread_id: Option<&str>,
    workspace_id: &str,
) -> Result<Option<ThreadRow>, IpcError> {
    let Some(thread_id) = thread_id else {
        return Ok(None);
    };
    validate_thread_id(thread_id)?;
    if !panes
        .is_interactive_thread(thread_id)
        .map_err(|error| error.log_and_convert("provider_pane_context_source"))?
    {
        return Err(context_source_unavailable());
    }
    let row = match core.read(|conn| kalcode_threads::store::get(conn, thread_id)) {
        Ok(row) => row,
        Err(error) if error.code == "thread_not_found" => {
            return Err(context_source_unavailable());
        }
        Err(error) => return Err(error.log_and_convert("provider_pane_context_source")),
    };
    if row.archived_at.is_some() || row.workspace_id != workspace_id {
        return Err(context_source_unavailable());
    }
    Ok(Some(row))
}

/// Creates a thread whose provider runs interactively in a pane. Plan, Approve and Auto only at
/// creation, as for `thread_create` (Bypass and Custom are set afterwards, with confirmation).
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn provider_pane_create(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    threads: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    provider_id: String,
    provider_account_id: Option<String>,
    workspace_id: String,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: PermissionMode,
    name: Option<String>,
    source_thread_id: Option<String>,
    context_source_thread_id: Option<String>,
    switch_account_id: Option<String>,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    panes.require()?;
    if !hook_program().is_some_and(|path| hook_program_ready(&path)) {
        return Err(KalError::validation(
            "provider_panes_unavailable",
            "KalCode's hook helper is missing. Reinstall KalCode.",
        )
        .to_ipc());
    }
    if ![
        ProviderId::CLAUDE_CODE,
        ProviderId::CODEX,
        ProviderId::GEMINI_CLI,
        ProviderId::CURSOR,
    ]
    .contains(&provider_id.as_str())
    {
        return Err(KalError::validation(
            "provider_pane_unsupported",
            "That provider can't run in a pane.",
        )
        .to_ipc());
    }
    validate_pane_source_choice(
        source_thread_id.as_deref(),
        context_source_thread_id.as_deref(),
    )?;
    // Only durable launch configuration crosses to the new runtime. Resolve it from the
    // source row, never the renderer's cached identity, conversation or provider session id.
    let source = source_thread_id
        .as_deref()
        .map(|id| {
            validate_thread_id(id)?;
            if !panes
                .is_interactive_thread(id)
                .map_err(|e| e.log_and_convert("provider_pane_duplicate_source"))?
            {
                return Err(KalError::validation(
                    "pane_duplicate_unavailable",
                    "Choose a coding agent to duplicate.",
                )
                .to_ipc());
            }
            let row = app
                .core()?
                .read(|conn| kalcode_threads::store::get(conn, id))
                .map_err(|e| e.log_and_convert("provider_pane_duplicate_source"))?;
            if row.archived_at.is_some() || row.permission_mode == PermissionMode::Custom {
                return Err(KalError::validation(
                    "pane_duplicate_unavailable",
                    "This agent cannot be duplicated with its current settings.",
                )
                .to_ipc());
            }
            Ok(row)
        })
        .transpose()?;
    let context_source = resolve_context_source(
        app.core()?,
        &panes,
        context_source_thread_id.as_deref(),
        &workspace_id,
    )?;
    if switch_account_id.is_some() && source.is_none() {
        return Err(KalError::validation(
            "pane_switch_source_required",
            "Choose a coding session before switching accounts.",
        )
        .to_ipc());
    }
    let config = pane_launch_config(
        provider_id,
        provider_account_id,
        workspace_id,
        model,
        effort,
        permission_mode,
        name,
        source.as_ref(),
        context_source.as_ref(),
        switch_account_id.as_deref(),
    );
    let account = crate::thread_commands::resolve_creation_account(
        app.core()?,
        &config.provider_id,
        &config.workspace_id,
        config.provider_account_id.as_deref(),
        None,
    )
    .map_err(|e| e.log_and_convert("provider_pane_create_account"))?;
    if switch_account_id.is_none()
        && source.as_ref().is_some_and(|source| {
            source.provider_account_id.as_deref()
                != account.as_ref().map(|account| account.id.as_str())
        })
    {
        return Err(KalError::validation(
            "pane_duplicate_account_changed",
            "Choose an account for the original agent before duplicating it.",
        )
        .to_ipc());
    }
    let effort = pane_effort(&config.provider_id, config.effort)?;
    threads.ensure_providers(app.core.as_ref());
    let runtime = threads.runtime()?;
    let mut thread = create_pane_thread(runtime, &panes.sessions_dir, |thread_id| {
        let request = CreateIdleThread {
            provider_id: config.provider_id,
            provider_account_id: account.as_ref().map(|account| account.id.clone()),
            account_label: account.map(|account| account.display_name),
            workspace_id: config.workspace_id,
            model: config.model,
            effort,
            permission_mode: config.permission_mode,
            name: config.name,
        };
        match config.cwd {
            Some(cwd) => runtime.create_idle_with_id_in_directory(thread_id, request, cwd),
            None => runtime.create_idle_with_id(thread_id, request),
        }
    })
    .map_err(|e| e.log_and_convert("provider_pane_create"))?;
    panes.stamp_runtime_kind(&mut thread);
    if let Some(error) =
        pane_creation_error(thread.status, thread.runtime_kind, thread.error.as_ref())
    {
        return Err(error);
    }
    Ok(thread)
}

/// Creates a provider-pane thread (a coding agent): `create` creates the thread with the id it
/// is given. The id is chosen and durably marked as a pane first, because the pane router sits
/// under the Resource Governor and the account binding: a launch they hold (max agents busy) or
/// refuse never reaches the router, and the runtime's later relaunch or a Resume must still start
/// a pane, not a headless provider. A marker whose thread was never created is removed.
pub(crate) fn create_pane_thread(
    runtime: &ThreadRuntime,
    sessions_dir: &Path,
    create: impl FnOnce(&str) -> kalcode_core::Result<ThreadSummary>,
) -> kalcode_core::Result<ThreadSummary> {
    let thread_id = kalcode_contracts::ids::new_id();
    create_pane_thread_with_id(runtime, sessions_dir, &thread_id, create)
}

fn create_pane_thread_with_id(
    runtime: &ThreadRuntime,
    sessions_dir: &Path,
    thread_id: &str,
    create: impl FnOnce(&str) -> kalcode_core::Result<ThreadSummary>,
) -> kalcode_core::Result<ThreadSummary> {
    mark_interactive(sessions_dir, thread_id).map_err(|error| {
        KalError::new(
            ErrorCategory::Filesystem,
            "interactive_marker_unavailable",
            "KalCode couldn't prepare the agent's session.",
        )
        .retryable()
        .with_source(error)
    })?;
    let created = RuntimeRouter::create_interactive(|| create(thread_id));
    if created.is_err()
        && matches!(runtime.get(thread_id), Err(error) if error.code == "thread_not_found")
    {
        unmark_interactive(sessions_dir, thread_id);
    }
    created
}

fn pane_creation_error(
    status: ThreadStatus,
    runtime_kind: Option<ThreadRuntimeKind>,
    error: Option<&ThreadError>,
) -> Option<IpcError> {
    if let Some(error) = pane_create_failure(status, error) {
        return Some(error);
    }
    (runtime_kind != Some(ThreadRuntimeKind::InteractivePty)).then(|| {
        KalError::validation(
            "provider_pane_failed",
            "KalCode couldn't create a coding terminal. Try again.",
        )
        .to_ipc()
    })
}

/// The provider-native effort a new pane starts with (`None`: the provider default). Gemini CLI
/// has no effort setting.
pub(crate) fn pane_effort(
    provider_id: &str,
    effort: Option<String>,
) -> Result<Option<String>, IpcError> {
    let Some(effort) = effort
        .map(|effort| effort.trim().to_ascii_lowercase())
        .filter(|effort| !effort.is_empty() && effort != "default")
    else {
        return Ok(None);
    };
    let supported = match provider_id {
        ProviderId::CLAUDE_CODE => kalcode_providers::claude::argv::valid_effort_name(&effort),
        ProviderId::CODEX => kalcode_providers::codex::argv::valid_effort_name(&effort),
        _ => false,
    };
    if supported {
        Ok(Some(effort))
    } else {
        Err(KalError::validation(
            "invalid_effort",
            "That provider doesn't support this effort level.",
        )
        .to_ipc())
    }
}

/// Streams a pane's output to the calling view (replay first, then live bytes). The view
/// acknowledges rendered bytes with `provider_pane_ack`.
#[tauri::command]
pub fn provider_pane_attach(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    thread_id: String,
    on_output: Channel<InvokeResponseBody>,
) -> Result<Option<u64>, IpcError> {
    _runtime_access.revalidate()?;
    panes.require()?;
    validate_thread_id(&thread_id)?;
    let label = webview.label().to_owned();
    let excess: Vec<View> = {
        let mut map = panes.views();
        let mut mine: Vec<u64> = map
            .iter()
            .filter(|(_, v)| v.label == label && v.thread_id == thread_id)
            .map(|(id, _)| *id)
            .collect();
        mine.sort_unstable();
        let over = (mine.len() + 1).saturating_sub(MAX_VIEWS_PER_PANE);
        mine.into_iter()
            .take(over)
            .filter_map(|id| map.remove(&id))
            .collect()
    };
    for view in excess {
        panes.panes.detach(&view.thread_id, view.pty_attach);
    }
    let unacked = Arc::new(AtomicUsize::new(0));
    let lagged = Arc::new(AtomicBool::new(false));
    let (sent, behind) = (unacked.clone(), lagged.clone());
    // Coalesced like shell terminals (`terminal_attach`): bursts become one message per interval.
    let output = OutputCoalescer::new(CoalesceConfig::default(), move |bytes| {
        on_output.send(InvokeResponseBody::Raw(bytes)).is_ok()
    });
    let Some(pty_attach) = panes.panes.attach(&thread_id, move |bytes| {
        if sent.fetch_add(bytes.len(), Ordering::SeqCst) + bytes.len() > MAX_UNACKED_BYTES {
            behind.store(true, Ordering::SeqCst);
            return false;
        }
        output.push(bytes)
    }) else {
        return Ok(None);
    };
    let id = panes.next_view.fetch_add(1, Ordering::Relaxed);
    panes.views().insert(
        id,
        View {
            label,
            thread_id,
            pty_attach,
            unacked,
            lagged,
        },
    );
    Ok(Some(id))
}

#[tauri::command]
// `fetch_update` is deprecated as `try_update` on newer stable toolchains, which older
// supported toolchains lack; keep one spelling that builds on both.
#[allow(deprecated)]
pub fn provider_pane_ack(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    attachment_id: u64,
    bytes: u32,
) -> bool {
    let map = panes.views();
    let Some(view) = map
        .get(&attachment_id)
        .filter(|v| v.label == webview.label())
    else {
        return false;
    };
    let bytes = usize::try_from(bytes).unwrap_or(usize::MAX);
    let _ = view
        .unacked
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            Some(n.saturating_sub(bytes))
        });
    !view.lagged.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn provider_pane_detach(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    attachment_id: u64,
) -> bool {
    let view = {
        let mut map = panes.views();
        let owned = map
            .get(&attachment_id)
            .is_some_and(|v| v.label == webview.label());
        if owned {
            map.remove(&attachment_id)
        } else {
            None
        }
    };
    view.is_some_and(|v| panes.panes.detach(&v.thread_id, v.pty_attach))
}

/// The person's keystrokes. Bounded like Z1 terminal writes.
///
/// Off the main thread: a write takes the pane's lifecycle lock (and, for voice, the registry
/// lock), which a handoff delivery can hold for its acknowledged write. The view keeps a pane's
/// writes in order by sending the next only after the previous one resolved.
#[tauri::command(async)]
pub fn provider_pane_write(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    thread_id: String,
    data: String,
    voice: Option<bool>,
    instance_id: Option<String>,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    panes.require()?;
    validate_thread_id(&thread_id)?;
    if voice.unwrap_or(false) {
        let instance_id = instance_id
            .as_deref()
            .ok_or_else(|| provider_voice_error(PaneVoiceWriteError::TargetChanged))?;
        panes
            .panes
            .write_voice(&thread_id, instance_id, data.as_bytes())
            .map_err(provider_voice_error)
    } else {
        panes
            .panes
            .write(&thread_id, data.as_bytes())
            .map_err(provider_error)
    }
}

fn provider_voice_error(error: PaneVoiceWriteError) -> IpcError {
    match error {
        PaneVoiceWriteError::SessionEnded => KalError::validation(
            "pane_not_running",
            "This agent's provider has ended. Resume the agent to start it again.",
        ),
        PaneVoiceWriteError::TargetChanged => KalError::validation(
            "provider_target_changed",
            "That provider pane restarted before voice input was delivered.",
        ),
        PaneVoiceWriteError::ProviderPrompt => KalError::validation(
            "provider_permission_prompt",
            "Answer the provider's current prompt before sending voice input.",
        ),
        PaneVoiceWriteError::Unverified => KalError::validation(
            "provider_input_unverified",
            "KalCode cannot yet confirm that this provider is ready for input.",
        ),
        PaneVoiceWriteError::Io => KalError::validation(
            "provider_pane_failed",
            "KalCode could not communicate with this provider pane.",
        ),
    }
    .to_ipc()
}

#[tauri::command]
pub fn provider_pane_resize(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    thread_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    panes.require()?;
    validate_thread_id(&thread_id)?;
    panes
        .panes
        .resize(&thread_id, cols, rows)
        .map_err(provider_error)
}

#[tauri::command(async)]
pub fn provider_pane_info(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    threads: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    thread_id: String,
) -> Result<Option<PaneInfo>, IpcError> {
    _runtime_access.revalidate()?;
    panes.require()?;
    validate_thread_id(&thread_id)?;
    if let Some(info) = panes.panes.info(&thread_id) {
        return Ok(Some(info));
    }
    if !panes
        .is_interactive_thread(&thread_id)
        .map_err(|error| error.log_and_convert("provider_pane_info_runtime"))?
    {
        return Ok(None);
    }
    // A marker without an in-memory pane usually belongs to an earlier app run, but can also
    // remain after a provider failed before spawning its first PTY. The canonical thread keeps
    // the truthful provider and failure state; the UI uses both it and this non-running info.
    let thread = threads
        .runtime()?
        .get(&thread_id)
        .map_err(|e| e.log_and_convert("provider_pane_info_thread"))?;
    Ok(Some(ended_marker_info(
        thread_id,
        thread.provider_id.as_str().to_owned(),
        panes.routing,
    )))
}

fn ended_marker_info(thread_id: String, provider_id: String, routing: DecisionRouting) -> PaneInfo {
    PaneInfo {
        thread_id,
        provider_id,
        instance_id: None,
        hook_channel: HookChannelState::Ended,
        decision_routing: routing,
        kalcode_answers_approvals: false,
        running: false,
        exit_code: None,
    }
}

/// Drops a reloaded page's pane views (called from the page-load hook).
pub fn drop_views(webview: &Webview) {
    if let Ok(state) = crate::runtime_coordinator::RuntimeState::<ProviderPanesState>::from_app(
        webview.app_handle(),
    ) {
        state.drop_views(webview.label());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_core(path: &Path) -> Arc<kalcode_core::Core> {
        Arc::new(
            kalcode_core::Core::open(kalcode_core::CoreConfig {
                paths: kalcode_core::Paths::new(path),
                app_version: "0.0.0-test".into(),
                channel: kalcode_core::flags::BuildChannel::Development,
            })
            .expect("core"),
        )
    }

    fn insert_source(
        core: &kalcode_core::Core,
        root: &Path,
        workspace_id: &str,
        mode: PermissionMode,
        archived: bool,
    ) -> ThreadRow {
        let id = kalcode_contracts::ids::new_id();
        let cwd = root.join(&id);
        std::fs::create_dir_all(&cwd).expect("source cwd");
        let provider_id = ProviderId::new(ProviderId::CLAUDE_CODE);
        let cwd = cwd.to_string_lossy().into_owned();
        core.write_with_events(|tx| {
            kalcode_threads::store::insert_thread(
                tx,
                &kalcode_threads::store::NewThreadRow {
                    id: &id,
                    name: "Repair checkout flow",
                    provider_id: &provider_id,
                    provider_name: "Claude Code",
                    model: Some("source-model"),
                    effort: Some("low"),
                    provider_account_id: None,
                    account_label: None,
                    workspace_id,
                    workspace_name: "Workspace",
                    cwd: &cwd,
                    permission_mode: mode,
                    now: "2026-10-05T00:00:00Z",
                },
            )?;
            kalcode_threads::store::set_permission_mode(
                tx,
                &id,
                mode,
                (mode == PermissionMode::Custom).then_some("source-custom-profile"),
            )?;
            kalcode_threads::store::set_provider_session(
                tx,
                &id,
                "source-provider-session",
                Some("source-model"),
            )?;
            if archived {
                tx.execute(
                    "UPDATE threads SET archived_at = '2026-10-05T00:01:00Z' WHERE id = ?1",
                    [&id],
                )?;
            }
            Ok(((), Vec::new()))
        })
        .expect("insert source");
        core.read(|conn| kalcode_threads::store::get(conn, &id))
            .expect("source row")
    }

    fn summary_fixture(id: String) -> ThreadSummary {
        ThreadSummary {
            can_move_workspace: Some(true),
            id,
            name: "Agent".into(),
            provider_id: ProviderId::new(ProviderId::CODEX),
            provider_name: "Codex".into(),
            model: None,
            effort: None,
            provider_account_id: None,
            account_label: None,
            workspace_id: kalcode_contracts::ids::new_id(),
            workspace_name: "Workspace".into(),
            permission_mode: PermissionMode::Approve,
            status: ThreadStatus::Interrupted,
            current_activity: Some(kalcode_threads::runtime::SHUTDOWN_ACTIVITY.into()),
            created_at: String::new(),
            last_activity_at: String::new(),
            pending_approvals: 0,
            unread_messages: 0,
            files_changed: Some(0),
            branch: None,
            error: None,
            archived_at: None,
            resumable: false,
            restart_recoverable: Some(false),
            resume_has_pending_input: false,
            permission_profile_id: None,
            runtime_kind: None,
            terminal_id: None,
            worktree_id: None,
        }
    }

    fn pane_state(sessions_dir: PathBuf) -> ProviderPanesState {
        ProviderPanesState {
            routes: PaneRoutes::default(),
            enabled: true,
            bridge: None,
            panes: Arc::new(PaneRegistry::new()),
            glue: Arc::new(Glue::default()),
            views: Mutex::new(HashMap::new()),
            next_view: AtomicU64::new(1),
            unavailable: None,
            sessions_dir,
            routing: DEFAULT_DECISION_ROUTING,
            operation_owned: None,
        }
    }

    #[test]
    fn pane_context_and_duplicate_sources_are_mutually_exclusive() {
        let error = validate_pane_source_choice(Some("duplicate"), Some("context"))
            .expect_err("source modes conflict");
        assert_eq!(error.code, "pane_context_source_conflict");
        validate_pane_source_choice(Some("duplicate"), None).expect("duplicate only");
        validate_pane_source_choice(None, Some("context")).expect("context only");
    }

    #[test]
    fn pane_context_source_must_be_durable_open_interactive_and_same_workspace() {
        let dir = tempfile::tempdir().expect("temp dir");
        let core = test_core(&dir.path().join("data"));
        let sessions = dir.path().join("sessions");
        let panes = pane_state(sessions.clone());
        let workspace_id = kalcode_contracts::ids::new_id();

        let missing = kalcode_contracts::ids::new_id();
        assert_eq!(
            resolve_context_source(&core, &panes, Some(&missing), &workspace_id)
                .expect_err("missing source")
                .code,
            "pane_context_source_unavailable"
        );

        let headless = insert_source(
            &core,
            dir.path(),
            &workspace_id,
            PermissionMode::Approve,
            false,
        );
        assert_eq!(
            resolve_context_source(&core, &panes, Some(&headless.id), &workspace_id)
                .expect_err("headless source")
                .code,
            "pane_context_source_unavailable"
        );

        let archived = insert_source(
            &core,
            dir.path(),
            &workspace_id,
            PermissionMode::Approve,
            true,
        );
        mark_interactive(&sessions, &archived.id).expect("mark archived pane");
        assert_eq!(
            resolve_context_source(&core, &panes, Some(&archived.id), &workspace_id)
                .expect_err("archived source")
                .code,
            "pane_context_source_unavailable"
        );

        let other_workspace = kalcode_contracts::ids::new_id();
        let cross_workspace = insert_source(
            &core,
            dir.path(),
            &other_workspace,
            PermissionMode::Approve,
            false,
        );
        mark_interactive(&sessions, &cross_workspace.id).expect("mark cross-workspace pane");
        assert_eq!(
            resolve_context_source(&core, &panes, Some(&cross_workspace.id), &workspace_id)
                .expect_err("cross-workspace source")
                .code,
            "pane_context_source_unavailable"
        );
    }

    #[test]
    fn pane_context_copies_only_name_and_cwd_into_explicit_fresh_settings() {
        let dir = tempfile::tempdir().expect("temp dir");
        let core = test_core(&dir.path().join("data"));
        let sessions = dir.path().join("sessions");
        let panes = pane_state(sessions.clone());
        let workspace_id = kalcode_contracts::ids::new_id();
        let source = insert_source(
            &core,
            dir.path(),
            &workspace_id,
            PermissionMode::Custom,
            false,
        );
        mark_interactive(&sessions, &source.id).expect("mark custom pane");
        let source = resolve_context_source(&core, &panes, Some(&source.id), &workspace_id)
            .expect("resolve context")
            .expect("context row");
        assert_eq!(source.permission_mode, PermissionMode::Custom);
        assert_eq!(
            source.permission_profile_id.as_deref(),
            Some("source-custom-profile")
        );
        assert_eq!(
            source.provider_session_id.as_deref(),
            Some("source-provider-session")
        );

        let config = pane_launch_config(
            ProviderId::CODEX.into(),
            Some("selected-account".into()),
            workspace_id.clone(),
            Some("selected-model".into()),
            Some("max".into()),
            PermissionMode::Auto,
            Some("ignored new name".into()),
            None,
            Some(&source),
            None,
        );
        assert_eq!(config.provider_id, ProviderId::CODEX);
        assert_eq!(
            config.provider_account_id.as_deref(),
            Some("selected-account")
        );
        assert_eq!(config.workspace_id, workspace_id);
        assert_eq!(config.model.as_deref(), Some("selected-model"));
        assert_eq!(config.effort.as_deref(), Some("max"));
        assert_eq!(config.permission_mode, PermissionMode::Auto);
        assert_eq!(config.name.as_deref(), Some("Repair checkout flow"));
        assert_eq!(config.cwd.as_deref(), Some(Path::new(&source.cwd)));
    }

    #[test]
    fn pane_creation_always_allocates_a_fresh_nonresumed_identity() {
        let dir = tempfile::tempdir().expect("temp dir");
        let core = test_core(&dir.path().join("data"));
        let runtime = ThreadRuntime::new(
            core,
            Arc::new(kalcode_threads::ProviderRegistry::new()),
            Arc::new(kalcode_threads::registry::NoWorkspaces),
            Arc::new(kalcode_contracts::permissions::AskUnlessReadGate),
        )
        .expect("runtime");
        let source_id = kalcode_contracts::ids::new_id();
        let created = create_pane_thread(&runtime, &dir.path().join("sessions"), |id| {
            assert_ne!(id, source_id);
            Ok(summary_fixture(id.to_owned()))
        })
        .expect("fresh pane");
        assert_ne!(created.id, source_id);
        assert!(!created.resumable);
        assert_eq!(created.terminal_id, None);
        assert_eq!(created.worktree_id, None);
    }

    #[test]
    fn operations_owned_panes_are_never_offered_for_automatic_restore() {
        let dir = tempfile::tempdir().expect("temp dir");
        let sessions = dir.path().join("sessions");
        let owned_id = kalcode_contracts::ids::new_id();
        let mut state = pane_state(sessions.clone());
        let owned = owned_id.clone();
        state.operation_owned = Some(Arc::new(move |thread_id: &str| thread_id == owned));

        // An Operations-owned pane (a Squad member or a queued agent run) that KalCode's exit
        // interrupted stays with Operations recovery, which never relaunches work automatically.
        let mut operation_pane = summary_fixture(owned_id);
        mark_interactive(&sessions, &operation_pane.id).expect("mark operation pane");
        state.stamp_runtime_kind(&mut operation_pane);
        assert_eq!(
            operation_pane.runtime_kind,
            Some(ThreadRuntimeKind::InteractivePty)
        );
        assert_eq!(operation_pane.restart_recoverable, Some(false));

        // An ordinary Code agent interrupted the same way is still offered to Smart Resume.
        let mut code_pane = summary_fixture(kalcode_contracts::ids::new_id());
        mark_interactive(&sessions, &code_pane.id).expect("mark code pane");
        state.stamp_runtime_kind(&mut code_pane);
        assert_eq!(code_pane.restart_recoverable, Some(true));
    }

    #[test]
    fn restart_recovery_is_only_stamped_for_application_interrupted_provider_panes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let sessions = dir.path().join("sessions");
        let state = pane_state(sessions.clone());

        let mut headless = summary_fixture(kalcode_contracts::ids::new_id());
        state.stamp_runtime_kind(&mut headless);
        assert_eq!(headless.runtime_kind, Some(ThreadRuntimeKind::Headless));
        assert_eq!(headless.restart_recoverable, Some(false));

        let mut pane = summary_fixture(kalcode_contracts::ids::new_id());
        mark_interactive(&sessions, &pane.id).expect("mark interactive pane");
        state.stamp_runtime_kind(&mut pane);
        assert_eq!(pane.runtime_kind, Some(ThreadRuntimeKind::InteractivePty));
        assert_eq!(
            pane.restart_recoverable,
            Some(true),
            "provider-native resumability is independently gated by the UI"
        );

        pane.current_activity = Some(kalcode_threads::runtime::RECOVERED_ACTIVITY.into());
        state.stamp_runtime_kind(&mut pane);
        assert_eq!(pane.restart_recoverable, Some(true));

        pane.current_activity = Some(kalcode_threads::runtime::STOPPED_ACTIVITY.into());
        state.stamp_runtime_kind(&mut pane);
        assert_eq!(pane.restart_recoverable, Some(false));

        pane.current_activity = Some(kalcode_threads::runtime::SHUTDOWN_ACTIVITY.into());
        pane.status = ThreadStatus::Failed;
        state.stamp_runtime_kind(&mut pane);
        assert_eq!(pane.restart_recoverable, Some(false));

        pane.status = ThreadStatus::Interrupted;
        pane.archived_at = Some("2026-10-05T00:00:00Z".into());
        state.stamp_runtime_kind(&mut pane);
        assert_eq!(pane.restart_recoverable, Some(false));
    }

    #[test]
    fn failed_launch_returns_its_error_but_a_queued_terminal_remains_valid() {
        let recorded = ThreadError {
            code: "provider_start_failed".into(),
            message: "The provider could not start. Try again.".into(),
        };
        let error = pane_creation_error(
            ThreadStatus::Failed,
            Some(ThreadRuntimeKind::InteractivePty),
            Some(&recorded),
        )
        .expect("failed start");
        assert_eq!(error.code, recorded.code);
        assert_eq!(error.message, recorded.message);
        assert!(
            pane_creation_error(
                ThreadStatus::WaitingForDependency,
                Some(ThreadRuntimeKind::InteractivePty),
                Some(&recorded)
            )
            .is_none()
        );
        assert!(
            pane_creation_error(ThreadStatus::Idle, Some(ThreadRuntimeKind::Headless), None)
                .is_some()
        );
        assert!(pane_creation_error(ThreadStatus::Idle, None, None).is_some());
    }

    #[test]
    fn restored_terminal_preserves_its_actual_provider() {
        for provider in [
            ProviderId::CLAUDE_CODE,
            ProviderId::CODEX,
            ProviderId::GEMINI_CLI,
        ] {
            let id = kalcode_contracts::ids::new_id();
            let info = ended_marker_info(id.clone(), provider.into(), DEFAULT_DECISION_ROUTING);
            assert_eq!(info.thread_id, id);
            assert_eq!(info.provider_id.as_str(), provider);
            assert_eq!(info.hook_channel, HookChannelState::Ended);
            assert!(!info.running);
        }
    }

    #[test]
    fn pane_errors_do_not_expose_backend_details() {
        use kalcode_contracts::agent::ProviderError;

        for error in [
            ProviderError::Io("credential=never-render".into()),
            ProviderError::Start("credential=never-render".into()),
            ProviderError::Protocol("credential=never-render".into()),
        ] {
            let ipc = provider_error(error);
            assert_eq!(ipc.code, "provider_pane_failed");
            assert!(!ipc.message.contains("never-render"));
        }
        let ended = provider_error(ProviderError::SessionEnded);
        assert_eq!(ended.code, "pane_not_running");
        assert!(ended.message.contains("Resume the agent"));

        assert_eq!(
            provider_voice_error(PaneVoiceWriteError::ProviderPrompt).code,
            "provider_permission_prompt"
        );
        assert_eq!(
            provider_voice_error(PaneVoiceWriteError::Unverified).code,
            "provider_input_unverified"
        );
        assert_eq!(
            provider_voice_error(PaneVoiceWriteError::SessionEnded).code,
            "pane_not_running"
        );
        assert_eq!(
            provider_voice_error(PaneVoiceWriteError::TargetChanged).code,
            "provider_target_changed"
        );
    }

    #[test]
    fn the_hook_helper_is_looked_up_beside_the_executable() {
        let path = hook_program().expect("path");
        assert!(path.is_absolute());
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some(HOOK_HELPER),
            "{}",
            path.display()
        );
    }

    #[test]
    fn pane_runtime_requires_a_real_hook_helper_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join(HOOK_HELPER);
        assert!(!hook_program_ready(&missing));

        std::fs::create_dir(&missing).expect("directory at helper path");
        assert!(!hook_program_ready(&missing));
        std::fs::remove_dir(&missing).expect("remove directory");

        std::fs::write(&missing, b"test helper").expect("helper file");
        assert!(hook_program_ready(&missing));
        assert!(!hook_program_ready(std::path::Path::new(HOOK_HELPER)));
    }

    #[test]
    fn failed_new_pane_returns_its_recorded_safe_error_but_a_queued_start_does_not() {
        let recorded = kalcode_contracts::threads::ThreadError {
            code: "provider_start_failed".into(),
            message: "Claude Code couldn't start. Resume this thread after reinstalling KalCode."
                .into(),
        };
        let failed = pane_create_failure(ThreadStatus::Failed, Some(&recorded))
            .expect("failed start must cross IPC as failure");
        assert_eq!(failed.category, ErrorCategory::Provider);
        assert_eq!(failed.code, recorded.code);
        assert_eq!(failed.message, recorded.message);

        assert!(
            pane_create_failure(ThreadStatus::WaitingForDependency, Some(&recorded)).is_none(),
            "a resource-held launch remains a successfully created, queued agent"
        );
    }

    #[test]
    fn marker_only_pane_info_preserves_the_canonical_provider() {
        let thread_id = kalcode_contracts::ids::new_id();
        let info = ended_marker_info(
            thread_id.clone(),
            ProviderId::CODEX.into(),
            DecisionRouting::ProviderPrompt,
        );
        assert_eq!(info.thread_id, thread_id);
        assert_eq!(info.provider_id, ProviderId::CODEX);
        assert_eq!(info.hook_channel, HookChannelState::Ended);
        assert!(!info.running);
    }

    #[test]
    fn ordinary_panes_preserve_provider_native_permissions() {
        assert_eq!(DEFAULT_DECISION_ROUTING, DecisionRouting::ProviderPrompt);
    }
}
