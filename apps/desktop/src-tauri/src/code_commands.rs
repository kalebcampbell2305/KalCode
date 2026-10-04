//! IPC commands for workspaces, shells and terminals (Z1, `docs/CODE_MODE.md`).
//!
//! The WebView never supplies a path, an executable, a working directory or a shell string:
//! folders come from the native picker, shells are chosen by detected id, and every id is
//! validated natively. Terminal output streams over a per-view channel as raw bytes.
//!
//! Threading: commands that touch the database run off the main thread (`async`). Input,
//! resize, attach, ack and detach touch no storage and stay synchronous. `terminal_write` only
//! queues input; it never blocks on the shell. Views detach by the attachment id they were
//! given, so a detach can never remove a newer attachment, whatever order requests arrive in.
//!
//! Flow control: a view acknowledges the output bytes it has rendered (`terminal_ack`). A view
//! that falls more than `MAX_UNACKED_BYTES` behind stops receiving output, and its next ack
//! returns `false` so it can re-attach and resync from the scrollback. Native memory held for a
//! slow or unresponsive view is therefore bounded.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use kalcode_core::plans::Limited;
use kalcode_core::workspaces::{
    AttachmentId, ShellOption, TerminalInfo, TerminalSize, Workspace, validate_id,
};
use kalcode_core::{IpcError, KalError};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State, Webview, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::AppState;
use crate::account::runtime::AccountRuntime;
use crate::environment;

/// Output a view may be behind (sent but not yet acknowledged) before it is dropped.
const MAX_UNACKED_BYTES: usize = 4 * 1024 * 1024;
/// Attachments one webview may hold to one terminal (one per view; a few more while a view
/// re-attaches). The oldest is released beyond this.
const MAX_VIEWS_PER_TERMINAL: usize = 4;

struct View {
    label: String,
    terminal_id: String,
    unacked: Arc<AtomicUsize>,
    lagged: Arc<AtomicBool>,
}

/// Terminal attachments by id, each owned by the webview that made it. A page (re)load drops
/// all of that page's attachments.
#[derive(Default)]
pub struct TerminalViews(Mutex<HashMap<AttachmentId, View>>);

impl TerminalViews {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<AttachmentId, View>> {
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
        let ids: Vec<AttachmentId> = map
            .iter()
            .filter(|(_, v)| v.label == label)
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter()
            .filter(|id| map.remove(id).is_some())
            .collect()
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
pub fn workspace_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
) -> Result<Vec<Workspace>, IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .workspaces()
        .map_err(|e| e.log_and_convert("workspace_list"))
}

#[tauri::command(async)]
pub fn workspace_active(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
) -> Result<Option<Workspace>, IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .active_workspace()
        .map_err(|e| e.log_and_convert("workspace_active"))
}

/// Shows the native folder picker and opens the chosen folder as the active workspace.
/// Returns `None` when the user cancels. The path never comes from the WebView.
#[tauri::command]
pub async fn workspace_open_dialog(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: State<'_, AppState>,
    account: State<'_, Arc<AccountRuntime>>,
) -> Result<Option<Workspace>, IpcError> {
    _runtime_access.revalidate()?;
    let core = state.core()?.clone();
    let account = account.inner().clone();
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
    tauri::async_runtime::spawn_blocking(move || {
        _runtime_access.revalidate_core()?;
        // Reopening an existing workspace is never refused; only a new one counts.
        let limit = account.snapshot().plan_limit(Limited::Workspaces);
        core.open_workspace_limited(&folder, limit)
    })
    .await
    .map_err(|e| blocking_failed("workspace_open_dialog", e))?
    .map(Some)
    .map_err(|e| e.log_and_convert("workspace_open_dialog"))
}

#[tauri::command(async)]
pub fn workspace_activate(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Workspace, IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .activate_workspace(&workspace_id)
        .map_err(|e| e.log_and_convert("workspace_activate"))
}

/// Removes a workspace from KalCode's list. Its folder and files are never touched.
#[tauri::command(async)]
pub fn workspace_remove(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    threads: crate::runtime_coordinator::RuntimeState<crate::thread_commands::ThreadsState>,
    workspace_id: String,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    threads.refuse_if_threads_open(&workspace_id)?;
    state
        .core()?
        .remove_workspace(&workspace_id)
        .map_err(|e| e.log_and_convert("workspace_remove"))
}

// ---------- Shells and terminals ----------

#[tauri::command]
pub fn shells_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
) -> Result<Vec<ShellOption>, IpcError> {
    _runtime_access.revalidate()?;
    Ok(state.core()?.shells())
}

#[tauri::command(async)]
pub fn terminal_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<TerminalInfo>, IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .terminals(&workspace_id)
        .map_err(|e| e.log_and_convert("terminal_list"))
}

#[tauri::command(async)]
pub fn terminals_running(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
) -> Result<Vec<TerminalInfo>, IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .running_terminals()
        .map_err(|e| e.log_and_convert("terminals_running"))
}

/// Opens a new tab running a detected shell (by id; `None` = default) in the workspace folder.
#[tauri::command(async)]
pub fn terminal_create(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    account: State<'_, Arc<AccountRuntime>>,
    workspace_id: String,
    shell_id: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, IpcError> {
    _runtime_access.revalidate()?;
    let size = size(cols, rows)?;
    let limit = account.snapshot().terminal_limit();
    state
        .core()?
        .create_terminal(&workspace_id, shell_id.as_deref(), size, limit)
        .map_err(|e| e.log_and_convert("terminal_create"))
}

/// Fresh shell, with the source context resolved natively and normal plan admission.
#[tauri::command(async)]
pub fn terminal_duplicate(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    account: State<'_, Arc<AccountRuntime>>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .duplicate_terminal(
            &terminal_id,
            size(cols, rows)?,
            account.snapshot().terminal_limit(),
        )
        .map_err(|e| e.log_and_convert("terminal_duplicate"))
}

#[tauri::command(async)]
pub fn terminal_restart(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, IpcError> {
    _runtime_access.revalidate()?;
    let size = size(cols, rows)?;
    state
        .core()?
        .restart_terminal(&terminal_id, size)
        .map_err(|e| e.log_and_convert("terminal_restart"))
}

/// Renames a terminal while preserving its process and output.
#[tauri::command(async)]
pub fn terminal_rename(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    terminal_id: String,
    title: String,
) -> Result<TerminalInfo, IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .rename_terminal(&terminal_id, &title)
        .map_err(|e| e.log_and_convert("terminal_rename"))
}

/// Stops a shell without discarding its tab or output.
#[tauri::command(async)]
pub fn terminal_stop(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<TerminalInfo, IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .stop_terminal(&terminal_id)
        .map_err(|e| e.log_and_convert("terminal_stop"))
}

/// Closes a tab, ending its shell and the programs started in it.
#[tauri::command(async)]
pub fn terminal_close(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .close_terminal(&terminal_id)
        .map_err(|e| e.log_and_convert("terminal_close"))?;
    let data_dir = state.paths.data_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) =
            crate::terminal_image_commands::remove_terminal_images(&data_dir, &terminal_id)
        {
            error.log_and_convert("terminal_image_cleanup");
        }
    });
    Ok(())
}

/// Queues keyboard/paste input (UTF-8 text from xterm.js). At most 64 KB per call.
#[tauri::command]
pub fn terminal_write(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
    expected_generation: Option<u64>,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .write_terminal_for_generation(&terminal_id, data.as_bytes(), expected_generation)
        .map_err(|e| e.to_ipc())
}

#[tauri::command]
pub fn terminal_resize(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    let size = size(cols, rows)?;
    state
        .core()?
        .resize_terminal(&terminal_id, size)
        .map_err(|e| e.log_and_convert("terminal_resize"))
}

/// Streams a terminal's output to the calling view as raw bytes (an `ArrayBuffer` in JS):
/// the first message is the scrollback replay (possibly empty), then live output. Returns the
/// attachment id, or `null` when the terminal has no session to show (it ended before this
/// launch). The view acknowledges rendered bytes with `terminal_ack` and detaches by id.
#[tauri::command]
pub fn terminal_attach(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    state: State<'_, AppState>,
    views: State<'_, TerminalViews>,
    terminal_id: String,
    on_output: Channel<InvokeResponseBody>,
) -> Result<Option<AttachmentId>, IpcError> {
    _runtime_access.revalidate()?;
    let core = state.core()?;
    validate_id(&terminal_id).map_err(|e| e.to_ipc())?;
    let label = webview.label().to_owned();

    // Bound attachments per (webview, terminal): release the oldest beyond the limit.
    let excess: Vec<AttachmentId> = {
        let mut map = views.lock();
        let mut mine: Vec<AttachmentId> = map
            .iter()
            .filter(|(_, v)| v.label == label && v.terminal_id == terminal_id)
            .map(|(id, _)| *id)
            .collect();
        mine.sort_unstable();
        let over = (mine.len() + 1).saturating_sub(MAX_VIEWS_PER_TERMINAL);
        mine.into_iter()
            .take(over)
            .filter(|id| map.remove(id).is_some())
            .collect()
    };
    for id in excess {
        core.detach_terminal(id);
    }

    let unacked = Arc::new(AtomicUsize::new(0));
    let lagged = Arc::new(AtomicBool::new(false));
    let (sent, behind) = (unacked.clone(), lagged.clone());
    let attachment = core
        .attach_terminal(&terminal_id, move |bytes| {
            if sent.fetch_add(bytes.len(), Ordering::SeqCst) + bytes.len() > MAX_UNACKED_BYTES {
                behind.store(true, Ordering::SeqCst);
                return false; // stop streaming; the view resyncs on its next ack
            }
            on_output
                .send(InvokeResponseBody::Raw(bytes.to_vec()))
                .is_ok()
        })
        .map_err(|e| e.log_and_convert("terminal_attach"))?;
    if let Some(id) = attachment {
        views.lock().insert(
            id,
            View {
                label,
                terminal_id,
                unacked,
                lagged,
            },
        );
    }
    Ok(attachment)
}

/// Acknowledges `bytes` of output rendered by the calling view. Returns `false` when the view
/// no longer receives output (it fell too far behind, or was released) and must re-attach.
#[tauri::command]
pub fn terminal_ack(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    views: State<'_, TerminalViews>,
    attachment_id: AttachmentId,
    bytes: u32,
) -> bool {
    let map = views.lock();
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

/// Stops streaming to one of the calling view's attachments. Returns whether it existed.
#[tauri::command]
pub fn terminal_detach(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    webview: Webview,
    state: State<'_, AppState>,
    views: State<'_, TerminalViews>,
    attachment_id: AttachmentId,
) -> Result<bool, IpcError> {
    _runtime_access.revalidate()?;
    let removed = {
        let mut map = views.lock();
        // A webview may only release its own attachments.
        let owned = map
            .get(&attachment_id)
            .is_some_and(|v| v.label == webview.label());
        owned && map.remove(&attachment_id).is_some()
    };
    Ok(removed && state.core()?.detach_terminal(attachment_id))
}

/// Remembers the tab in front for a workspace, restored on the next launch.
#[tauri::command(async)]
pub fn terminal_set_active(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    workspace_id: String,
    terminal_id: String,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .set_active_terminal(&workspace_id, &terminal_id)
        .map_err(|e| e.log_and_convert("terminal_set_active"))
}
