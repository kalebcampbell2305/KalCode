//! Thread IPC commands (campaign Z3; names and shapes per docs/CONTRACTS.md, plus
//! `thread_options` and `thread_tool_calls`, which the Threads surface needs).
//!
//! Every input is validated natively by the thread runtime (`kalcode_threads::validate`):
//! ids with `is_valid_id`, names/prompts/models by length and character set, permission modes
//! by enum. The WebView never supplies a path, executable or shell string — a thread's working
//! directory comes from the workspace resolver.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use kalcode_contracts::agent::AgentEvent;
use kalcode_contracts::permissions::{AskUnlessReadGate, PermissionMode};
use kalcode_contracts::threads::{ThreadMessage, ThreadSummary};
use kalcode_core::{Core, IpcError, KalError};
use kalcode_threads::{
    CreateThread, NoWorkspaces, ProviderRegistry, StreamId, ThreadOptions, ThreadRuntime,
    ToolCallRecord, WorkspaceResolver,
};
use tauri::ipc::Channel;
use tauri::{State, Webview};

/// Thread runtime state for the shell. `runtime` is `None` when the core failed to start.
pub struct ThreadsState {
    runtime: Option<Arc<ThreadRuntime>>,
    /// One live stream per webview; a new `thread_stream` call replaces the previous one.
    streams: Mutex<HashMap<String, StreamId>>,
}

impl ThreadsState {
    /// Starts the thread runtime over `core`.
    ///
    /// Integration seams (see docs/AGENT_RUNTIME.md §Integration): providers come from Z2's
    /// adapters, workspaces from Z1's resolver, decisions from Z4's permission engine. Until
    /// those land there are no providers and no workspaces (so no thread can be created), and
    /// the conservative development gate asks before anything but a read.
    pub fn start(core: Option<&Arc<Core>>) -> Self {
        // INTEGRATION (Z2): register provider adapters here, e.g.
        // `providers.register(Arc::new(ClaudeCodeProvider::new(..)))`.
        let providers = Arc::new(ProviderRegistry::new());
        // INTEGRATION (Z1): replace with Z1's resolver over its workspace store.
        let workspaces: Arc<dyn WorkspaceResolver> = Arc::new(NoWorkspaces);
        let runtime = core.and_then(|core| {
            match ThreadRuntime::new(
                core.clone(),
                providers,
                workspaces,
                // INTEGRATION (Z4): replace with the permission engine.
                Arc::new(AskUnlessReadGate),
            ) {
                Ok(runtime) => Some(Arc::new(runtime)),
                Err(error) => {
                    tracing::error!(event = "threads.start_failed", error_code = error.code, error = %error.diagnostic());
                    None
                }
            }
        });
        Self {
            runtime,
            streams: Mutex::new(HashMap::new()),
        }
    }

    fn runtime(&self) -> Result<&Arc<ThreadRuntime>, IpcError> {
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
pub fn thread_options(state: State<'_, ThreadsState>) -> Result<ThreadOptions, IpcError> {
    state
        .runtime()?
        .options()
        .map_err(|e| e.log_and_convert("thread_options"))
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn thread_create(
    state: State<'_, ThreadsState>,
    provider_id: String,
    workspace_id: String,
    model: Option<String>,
    permission_mode: PermissionMode,
    prompt: String,
    name: Option<String>,
) -> Result<ThreadSummary, IpcError> {
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
    state: State<'_, ThreadsState>,
    thread_id: String,
    text: Option<String>,
) -> Result<ThreadSummary, IpcError> {
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
