//! IPC commands for workspaces, shells and terminals (Z1, `docs/CODE_MODE.md`).
//!
//! The WebView never supplies a path, an executable, a working directory or a shell string:
//! folders come from the native picker, shells are chosen by detected id, and every id is
//! validated natively. Terminal output streams over a per-view channel as raw bytes.
//!
//! Threading: commands that touch the database run off the main thread (`async`). Input,
//! resize, attach and detach touch no storage and stay synchronous, so they are handled in the
//! order the WebView sent them (typing never reorders, and a detach never overtakes the attach
//! it undoes). `terminal_write` only queues input; it never blocks on the shell.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use kalcode_core::workspaces::{
    AttachmentId, ShellOption, TerminalInfo, TerminalSize, Workspace, validate_id,
};
use kalcode_core::{IpcError, KalError};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State, Webview, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::AppState;
use crate::environment;

/// Which terminal each webview is attached to: (webview label, terminal id) → attachment.
/// One attachment per pair; a page (re)load drops all of that page's attachments.
#[derive(Default)]
pub struct TerminalViews(Mutex<HashMap<(String, String), AttachmentId>>);

impl TerminalViews {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String), AttachmentId>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Releases every terminal attachment held by `webview` (its page is reloading or closing).
pub fn drop_views(webview: &Webview) {
    let (Some(views), Some(state)) = (
        webview.try_state::<TerminalViews>(),
        webview.try_state::<AppState>(),
    ) else {
        return;
    };
    let label = webview.label().to_owned();
    let released: Vec<AttachmentId> = {
        let mut map = views.lock();
        let keys: Vec<_> = map.keys().filter(|(l, _)| *l == label).cloned().collect();
        keys.into_iter().filter_map(|k| map.remove(&k)).collect()
    };
    if let Some(core) = &state.core {
        for attachment in released {
            core.detach_terminal(attachment);
        }
    }
}

fn size(cols: u16, rows: u16) -> Result<TerminalSize, IpcError> {
    TerminalSize::new(cols, rows).map_err(|_| {
        KalError::validation(
            "invalid_size",
            "Terminal size must be between 2 and 1000 columns and rows.",
        )
        .to_ipc()
    })
}

fn blocking_failed(
    command: &'static str,
    error: impl std::error::Error + Send + Sync + 'static,
) -> IpcError {
    KalError::internal("task_failed", "KalCode couldn't complete that request.")
        .with_source(error)
        .log_and_convert(command)
}

// ---------- Workspaces ----------

#[tauri::command(async)]
pub fn workspace_list(state: State<'_, AppState>) -> Result<Vec<Workspace>, IpcError> {
    state
        .core()?
        .workspaces()
        .map_err(|e| e.log_and_convert("workspace_list"))
}

#[tauri::command(async)]
pub fn workspace_active(state: State<'_, AppState>) -> Result<Option<Workspace>, IpcError> {
    state
        .core()?
        .active_workspace()
        .map_err(|e| e.log_and_convert("workspace_active"))
}

/// Shows the native folder picker and opens the chosen folder as the active workspace.
/// Returns `None` when the user cancels. The path never comes from the WebView.
#[tauri::command]
pub async fn workspace_open_dialog(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<Workspace>, IpcError> {
    let core = state.core()?.clone();
    let folder: Option<PathBuf> = match environment::e2e_pick_folder() {
        // Test builds only: the E2E suite cannot click a native dialog.
        Some(path) => Some(path),
        None => {
            let dialog = window
                .dialog()
                .file()
                .set_parent(&window)
                .set_title("Open a project folder");
            let picked =
                tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
                    .await
                    .map_err(|e| blocking_failed("workspace_open_dialog", e))?;
            match picked {
                None => None,
                Some(path) => Some(path.into_path().map_err(|e| {
                    KalError::validation("unsupported_folder", "KalCode can't open that location.")
                        .with_source(e)
                        .log_and_convert("workspace_open_dialog")
                })?),
            }
        }
    };
    let Some(folder) = folder else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || core.open_workspace(&folder))
        .await
        .map_err(|e| blocking_failed("workspace_open_dialog", e))?
        .map(Some)
        .map_err(|e| e.log_and_convert("workspace_open_dialog"))
}

#[tauri::command(async)]
pub fn workspace_activate(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Workspace, IpcError> {
    state
        .core()?
        .activate_workspace(&workspace_id)
        .map_err(|e| e.log_and_convert("workspace_activate"))
}

/// Removes a workspace from KalCode's list. Its folder and files are never touched.
#[tauri::command(async)]
pub fn workspace_remove(state: State<'_, AppState>, workspace_id: String) -> Result<(), IpcError> {
    state
        .core()?
        .remove_workspace(&workspace_id)
        .map_err(|e| e.log_and_convert("workspace_remove"))
}

// ---------- Shells and terminals ----------

#[tauri::command]
pub fn shells_list(state: State<'_, AppState>) -> Result<Vec<ShellOption>, IpcError> {
    Ok(state.core()?.shells())
}

#[tauri::command(async)]
pub fn terminal_list(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<TerminalInfo>, IpcError> {
    state
        .core()?
        .terminals(&workspace_id)
        .map_err(|e| e.log_and_convert("terminal_list"))
}

#[tauri::command(async)]
pub fn terminals_running(state: State<'_, AppState>) -> Result<Vec<TerminalInfo>, IpcError> {
    state
        .core()?
        .running_terminals()
        .map_err(|e| e.log_and_convert("terminals_running"))
}

/// Opens a new tab running a detected shell (by id; `None` = default) in the workspace folder.
#[tauri::command(async)]
pub fn terminal_create(
    state: State<'_, AppState>,
    workspace_id: String,
    shell_id: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, IpcError> {
    let size = size(cols, rows)?;
    state
        .core()?
        .create_terminal(&workspace_id, shell_id.as_deref(), size)
        .map_err(|e| e.log_and_convert("terminal_create"))
}

#[tauri::command(async)]
pub fn terminal_restart(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, IpcError> {
    let size = size(cols, rows)?;
    state
        .core()?
        .restart_terminal(&terminal_id, size)
        .map_err(|e| e.log_and_convert("terminal_restart"))
}

/// Closes a tab, ending its shell and the programs started in it.
#[tauri::command(async)]
pub fn terminal_close(state: State<'_, AppState>, terminal_id: String) -> Result<(), IpcError> {
    state
        .core()?
        .close_terminal(&terminal_id)
        .map_err(|e| e.log_and_convert("terminal_close"))
}

/// Queues keyboard/paste input (UTF-8 text from xterm.js). At most 64 KB per call.
#[tauri::command]
pub fn terminal_write(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .write_terminal(&terminal_id, data.as_bytes())
        .map_err(|e| e.to_ipc())
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), IpcError> {
    let size = size(cols, rows)?;
    state
        .core()?
        .resize_terminal(&terminal_id, size)
        .map_err(|e| e.log_and_convert("terminal_resize"))
}

/// Streams a terminal's output to the calling view as raw bytes (an `ArrayBuffer` in JS):
/// the first message is the scrollback replay (possibly empty), then live output. Returns
/// `false` when the terminal has no session to show (it ended before this launch). A view
/// attaching again to the same terminal replaces its previous attachment.
#[tauri::command]
pub fn terminal_attach(
    webview: Webview,
    state: State<'_, AppState>,
    views: State<'_, TerminalViews>,
    terminal_id: String,
    on_output: Channel<InvokeResponseBody>,
) -> Result<bool, IpcError> {
    let core = state.core()?;
    validate_id(&terminal_id).map_err(|e| e.to_ipc())?;
    let key = (webview.label().to_owned(), terminal_id.clone());
    if let Some(previous) = views.lock().remove(&key) {
        core.detach_terminal(previous);
    }
    let attachment = core
        .attach_terminal(&terminal_id, move |bytes| {
            on_output
                .send(InvokeResponseBody::Raw(bytes.to_vec()))
                .is_ok()
        })
        .map_err(|e| e.log_and_convert("terminal_attach"))?;
    match attachment {
        Some(attachment) => {
            views.lock().insert(key, attachment);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Stops streaming a terminal to the calling view. Returns whether it was attached.
#[tauri::command]
pub fn terminal_detach(
    webview: Webview,
    state: State<'_, AppState>,
    views: State<'_, TerminalViews>,
    terminal_id: String,
) -> Result<bool, IpcError> {
    validate_id(&terminal_id).map_err(|e| e.to_ipc())?;
    let removed = views
        .lock()
        .remove(&(webview.label().to_owned(), terminal_id));
    Ok(match removed {
        Some(attachment) => state.core()?.detach_terminal(attachment),
        None => false,
    })
}

/// Remembers the tab in front for a workspace, restored on the next launch.
#[tauri::command(async)]
pub fn terminal_set_active(
    state: State<'_, AppState>,
    workspace_id: String,
    terminal_id: String,
) -> Result<(), IpcError> {
    state
        .core()?
        .set_active_terminal(&workspace_id, &terminal_id)
        .map_err(|e| e.log_and_convert("terminal_set_active"))
}
