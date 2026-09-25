//! Thread IPC commands (campaign Z3; names and shapes per docs/CONTRACTS.md, plus
//! `thread_options` and `thread_tool_calls`, which the Threads surface needs).
//!
//! Every input is validated natively by the thread runtime (`kalcode_threads::validate`):
//! ids with `is_valid_id`, names/prompts/models by length and character set, permission modes
//! by enum. The WebView never supplies a path, executable or shell string — a thread's working
//! directory comes from the workspace resolver.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use kalcode_contracts::agent::{AgentEvent, AgentProvider, ProviderId};
use kalcode_contracts::permissions::{PermissionGate, PermissionMode};
use kalcode_contracts::threads::{ThreadMessage, ThreadStatus, ThreadSummary};
use kalcode_core::{Core, IpcError, KalError};
use kalcode_permissions::{PermissionService, ThreadModeStore};
use kalcode_providers::model::AdapterState;
use kalcode_providers::{ClaudeCodeProvider, DetectEnv};
use kalcode_threads::{
    CoreWorkspaces, CreateThread, ProviderRegistry, StreamId, ThreadOptions, ThreadRuntime,
    ToolCallRecord,
};
use tauri::ipc::Channel;
use tauri::{State, Webview};

use crate::AppState;
use crate::provider_commands::detect_and_record;

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
    runtime: Option<Arc<ThreadRuntime>>,
    permissions: Option<Arc<PermissionService>>,
    /// Adapters offered to threads: exactly the providers detection reports usable.
    providers: Arc<ProviderRegistry>,
    detection: Arc<Detection>,
    /// One live stream per webview; a new `thread_stream` call replaces the previous one.
    streams: Mutex<HashMap<String, StreamId>>,
}

/// The native adapter for a provider, when KalCode has one. Codex and Gemini CLI are detected
/// but have no adapter yet, so they are never offered to threads.
fn adapter(id: &ProviderId) -> Option<Arc<dyn AgentProvider>> {
    match id.as_str() {
        // Z7-W4: the per-thread runtime router when provider panes are enabled.
        ProviderId::CLAUDE_CODE => Some(crate::provider_pane_commands::route_claude(Arc::new(
            ClaudeCodeProvider::new(DetectEnv::from_process()),
        ))),
        _ => None,
    }
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
    pub fn start(
        core: Option<&Arc<Core>>,
        detection: Arc<Detection>,
        permissions: Option<Arc<PermissionService>>,
        modes: &ThreadModes,
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
            runtime,
            permissions,
            providers,
            detection,
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
                    && let Some(provider) = adapter(&status.id)
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

    /// Ends every running session on exit; threads become `interrupted`, resumable.
    pub fn shutdown(&self) {
        if let Some(runtime) = &self.runtime {
            runtime.shutdown();
        }
    }
}

fn required(value: Option<String>, code: &'static str, message: &str) -> Result<String, IpcError> {
    value.ok_or_else(|| KalError::validation(code, message).to_ipc())
}

#[tauri::command(async)]
pub fn thread_list(
    state: State<'_, ThreadsState>,
    workspace_id: Option<String>,
    include_archived: Option<bool>,
) -> Result<Vec<ThreadSummary>, IpcError> {
    state
        .runtime()?
        .list(workspace_id.as_deref(), include_archived.unwrap_or(false))
        .map_err(|e| e.log_and_convert("thread_list"))
}

#[tauri::command(async)]
pub fn thread_get(
    state: State<'_, ThreadsState>,
    thread_id: String,
) -> Result<ThreadSummary, IpcError> {
    state
        .runtime()?
        .get(&thread_id)
        .map_err(|e| e.log_and_convert("thread_get"))
}

#[tauri::command(async)]
pub fn thread_messages(
    state: State<'_, ThreadsState>,
    thread_id: String,
    limit: u32,
    before: Option<String>,
) -> Result<Vec<ThreadMessage>, IpcError> {
    state
        .runtime()?
        .messages(&thread_id, limit, before.as_deref())
        .map_err(|e| e.log_and_convert("thread_messages"))
}

#[tauri::command(async)]
pub fn thread_tool_calls(
    state: State<'_, ThreadsState>,
    thread_id: String,
    limit: u32,
) -> Result<Vec<ToolCallRecord>, IpcError> {
    state
        .runtime()?
        .tool_calls(&thread_id, limit)
        .map_err(|e| e.log_and_convert("thread_tool_calls"))
}

#[tauri::command(async)]
pub fn thread_options(
    app: State<'_, AppState>,
    state: State<'_, ThreadsState>,
) -> Result<ThreadOptions, IpcError> {
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
pub fn thread_create(
    app: State<'_, AppState>,
    state: State<'_, ThreadsState>,
    provider_id: String,
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
) -> Result<ThreadSummary, IpcError> {
    if profile_id
        .as_deref()
        .is_some_and(|id| !kalcode_contracts::ids::is_valid_id(id))
    {
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
    state.ensure_providers(app.core.as_ref());
    state
        .runtime()?
        .create(CreateThread {
            provider_id,
            workspace_id,
            model,
            permission_mode,
            prompt,
            name,
        })
        .map_err(|e| e.log_and_convert("thread_create"))
}

#[tauri::command(async)]
pub fn thread_send(
    state: State<'_, ThreadsState>,
    thread_id: String,
    text: Option<String>,
) -> Result<ThreadSummary, IpcError> {
    let text = required(text, "invalid_prompt", "Write a message first.")?;
    state
        .runtime()?
        .send(&thread_id, &text)
        .map_err(|e| e.log_and_convert("thread_send"))
}

#[tauri::command(async)]
pub fn thread_interrupt(
    state: State<'_, ThreadsState>,
    thread_id: String,
) -> Result<ThreadSummary, IpcError> {
    state
        .runtime()?
        .interrupt(&thread_id)
        .map_err(|e| e.log_and_convert("thread_interrupt"))
}

#[tauri::command(async)]
pub fn thread_resume(
    app: State<'_, AppState>,
    state: State<'_, ThreadsState>,
    thread_id: String,
    text: Option<String>,
) -> Result<ThreadSummary, IpcError> {
    state.ensure_providers(app.core.as_ref());
    state
        .runtime()?
        .resume(&thread_id, text.as_deref())
        .map_err(|e| e.log_and_convert("thread_resume"))
}

#[tauri::command(async)]
pub fn thread_stop(
    state: State<'_, ThreadsState>,
    thread_id: String,
) -> Result<ThreadSummary, IpcError> {
    state
        .runtime()?
        .stop(&thread_id)
        .map_err(|e| e.log_and_convert("thread_stop"))
}

#[tauri::command(async)]
pub fn thread_rename(
    state: State<'_, ThreadsState>,
    thread_id: String,
    name: Option<String>,
) -> Result<ThreadSummary, IpcError> {
    let name = required(name, "invalid_name", "Give the thread a name.")?;
    state
        .runtime()?
        .rename(&thread_id, &name)
        .map_err(|e| e.log_and_convert("thread_rename"))
}

#[tauri::command(async)]
pub fn thread_archive(
    state: State<'_, ThreadsState>,
    thread_id: String,
) -> Result<ThreadSummary, IpcError> {
    state
        .runtime()?
        .archive(&thread_id)
        .map_err(|e| e.log_and_convert("thread_archive"))
}

/// Streams a thread's live message deltas to the calling webview. Each webview holds one
/// stream: subscribing to another thread replaces it, and a page (re)load drops it.
#[tauri::command(async)]
pub fn thread_stream(
    webview: Webview,
    state: State<'_, ThreadsState>,
    thread_id: String,
    on_event: Channel<AgentEvent>,
) -> Result<StreamId, IpcError> {
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
