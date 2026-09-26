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
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use kalcode_contracts::agent::{AgentProvider, ProviderId};
use kalcode_contracts::app::FeatureId;
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::threads::ThreadSummary;
use kalcode_core::{ErrorCategory, IpcError, KalError};
use kalcode_hook_bridge::Endpoint;
use kalcode_hook_bridge::server::{BridgeServer, BridgeShutdownError, ServerConfig};
use kalcode_permissions::PermissionService;
use kalcode_providers::DetectEnv;
use kalcode_providers::interactive::cli_pane::{InteractiveCliProvider, PaneCli};
use kalcode_providers::interactive::provider::{
    InteractiveClaudeProvider, InteractiveConfig, PaneRegistry, RuntimeRouter, marked_interactive,
    marked_interactive_checked,
};
use kalcode_providers::interactive::session::SessionLimits;
use kalcode_providers::interactive::{
    ApprovalExpiry, DEFAULT_DECISION_ROUTING, DecisionRouting, HookChannelState, PaneInfo,
    TitleSink,
};
use kalcode_threads::{CreateIdleThread, ThreadRuntime, naming};
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
}

impl PaneRoutes {
    pub fn route_claude(&self, headless: Arc<dyn AgentProvider>) -> Arc<dyn AgentProvider> {
        match self.claude.as_ref() {
            Some(interactive) => Arc::new(RuntimeRouter::new(headless, interactive.clone())),
            None => headless,
        }
    }

    /// Codex or Gemini CLI as the thread runtime should see it: the per-thread router when panes
    /// are enabled, otherwise the headless adapter unchanged.
    pub fn route_cli(&self, id: &str, headless: Arc<dyn AgentProvider>) -> Arc<dyn AgentProvider> {
        let interactive = match id {
            ProviderId::CODEX => self.codex.as_ref(),
            ProviderId::GEMINI_CLI => self.gemini.as_ref(),
            _ => None,
        };
        match interactive {
            Some(interactive) => Arc::new(RuntimeRouter::for_provider(
                headless,
                interactive.clone(),
                interactive.sessions_dir(),
            )),
            None => headless,
        }
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
    fn first_prompt(&self, thread_id: &str, prompt: &str) {
        // Only an untitled thread is named; the prompt itself is neither stored nor logged.
        let Some(runtime) = self.runtime.get().and_then(Weak::upgrade) else {
            return;
        };
        if runtime
            .get(thread_id)
            .is_ok_and(|t| t.name == naming::FALLBACK_NAME)
            && let Err(error) = runtime.rename(thread_id, &naming::name_from_prompt(prompt))
        {
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

    /// Starts the bridge when the feature is visible for this build, and registers the
    /// interactive provider for [`PaneRoutes::route_claude`]. Must run before threads start.
    pub fn start(app: &AppState, runtime: Option<ProviderRuntimeAuthority>) -> Self {
        let panes = Arc::new(PaneRegistry::new());
        let glue = Arc::new(Glue::default());
        let disabled = |reason| Self {
            routes: PaneRoutes::default(),
            enabled: false,
            bridge: None,
            panes: panes.clone(),
            glue: glue.clone(),
            views: Mutex::new(HashMap::new()),
            next_view: AtomicU64::new(1),
            unavailable: Some(reason),
            sessions_dir: app.paths.data_dir.join("sessions"),
            routing: DEFAULT_DECISION_ROUTING,
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
        let codex = Some(Arc::new(
            InteractiveCliProvider::new(
                PaneCli::Codex,
                DetectEnv::from_process(),
                Some(bridge.clone()),
                cli_config.clone(),
                panes.clone(),
            )
            .with_managed_profiles(runtime.managed_profiles())
            .with_codex_cloud_config_resolver(move |account_id| {
                codex_runtime.codex_cloud_config(account_id)
            }),
        ));
        let gemini = Some(Arc::new(
            InteractiveCliProvider::new(
                PaneCli::Gemini,
                DetectEnv::from_process(),
                None,
                cli_config,
                panes.clone(),
            )
            .with_managed_profiles(runtime.managed_profiles()),
        ));
        let provider = InteractiveClaudeProvider::new(
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
        let routes = PaneRoutes {
            claude: Some(Arc::new(provider)),
            codex,
            gemini,
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
    match error {
        // The view can tell an ended pane from other failures (like `terminal_not_running`).
        ProviderError::SessionEnded => KalError::validation(
            "pane_not_running",
            "This pane's provider has ended. Resume the thread to start it again.",
        )
        .to_ipc(),
        other => KalError::validation("provider_pane_failed", other.to_string()).to_ipc(),
    }
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
    permission_mode: PermissionMode,
    name: Option<String>,
) -> Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
    panes.require()?;
    if ![
        ProviderId::CLAUDE_CODE,
        ProviderId::CODEX,
        ProviderId::GEMINI_CLI,
    ]
    .contains(&provider_id.as_str())
    {
        return Err(KalError::validation(
            "provider_pane_unsupported",
            "That provider can't run in a pane.",
        )
        .to_ipc());
    }
    let account = crate::thread_commands::resolve_creation_account(
        app.core()?,
        &provider_id,
        &workspace_id,
        provider_account_id.as_deref(),
        None,
    )
    .map_err(|e| e.log_and_convert("provider_pane_create_account"))?;
    threads.ensure_providers(app.core.as_ref());
    let runtime = threads.runtime()?;
    RuntimeRouter::create_interactive(|| {
        runtime.create_idle(CreateIdleThread {
            provider_id,
            provider_account_id: account.as_ref().map(|account| account.id.clone()),
            account_label: account.map(|account| account.display_name),
            workspace_id,
            model,
            permission_mode,
            name,
        })
    })
    .map_err(|e| e.log_and_convert("provider_pane_create"))
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
    let Some(pty_attach) = panes.panes.attach(&thread_id, move |bytes| {
        if sent.fetch_add(bytes.len(), Ordering::SeqCst) + bytes.len() > MAX_UNACKED_BYTES {
            behind.store(true, Ordering::SeqCst);
            return false;
        }
        on_output
            .send(InvokeResponseBody::Raw(bytes.to_vec()))
            .is_ok()
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
#[tauri::command]
pub fn provider_pane_write(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    thread_id: String,
    data: String,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    panes.require()?;
    validate_thread_id(&thread_id)?;
    panes
        .panes
        .write(&thread_id, data.as_bytes())
        .map_err(provider_error)
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

#[tauri::command]
pub fn provider_pane_info(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    thread_id: String,
) -> Result<Option<PaneInfo>, IpcError> {
    _runtime_access.revalidate()?;
    panes.require()?;
    validate_thread_id(&thread_id)?;
    if let Some(info) = panes.panes.info(&thread_id) {
        return Ok(Some(info));
    }
    // A pane thread from an earlier run (its process ended with that run): it resumes in a pane.
    Ok(
        marked_interactive(&panes.sessions_dir, &thread_id).then(|| PaneInfo {
            thread_id: thread_id.clone(),
            provider_id: ProviderId::CLAUDE_CODE.into(),
            hook_channel: HookChannelState::Ended,
            decision_routing: panes.routing,
            kalcode_answers_approvals: false,
            running: false,
            exit_code: None,
        }),
    )
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
    fn ordinary_panes_preserve_provider_native_permissions() {
        assert_eq!(DEFAULT_DECISION_ROUTING, DecisionRouting::ProviderPrompt);
    }
}
