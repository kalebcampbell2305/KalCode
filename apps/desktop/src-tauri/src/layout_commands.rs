//! IPC commands for the pane layout store (Z7-W1, `crates/workspace-ui`).
//!
//! Layouts are UI state: the WebView sends a versioned `PaneLayout` tree and native validates
//! it (structure, limits and every content id) before anything is written. Saving a layout
//! never starts, stops or changes a process and emits no events. Workspace ids are checked
//! against Z1's workspaces through `Core`, never with SQL of our own. All commands run off the
//! main thread.

use kalcode_contracts::workspace_ui::PaneLayout;
use kalcode_core::workspaces::validate_id;
use kalcode_core::{IpcError, KalError};
use kalcode_workspace_ui::store;
use kalcode_workspace_ui::{SavedLayoutPreset, WorkspaceLayout};
use tauri::State;

use crate::AppState;

/// The layout saved for a workspace, or `None` when it has none (or it no longer validates).
#[tauri::command(async)]
pub fn layout_get(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Option<WorkspaceLayout>, IpcError> {
    _runtime_access.revalidate()?;
    validate_id(&workspace_id).map_err(|e| e.log_and_convert("layout_get"))?;
    state
        .core()?
        .read(|conn| store::get_layout(conn, &workspace_id))
        .map_err(|e| e.log_and_convert("layout_get"))
}

/// Validates and saves a workspace's layout. Unknown workspaces are refused.
#[tauri::command(async)]
pub fn layout_save(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    workspace_id: String,
    layout: PaneLayout,
) -> Result<WorkspaceLayout, IpcError> {
    _runtime_access.revalidate()?;
    let core = state.core()?;
    validate_id(&workspace_id).map_err(|e| e.log_and_convert("layout_save"))?;
    let known = core
        .workspaces()
        .map_err(|e| e.log_and_convert("layout_save"))?
        .iter()
        .any(|w| w.id == workspace_id);
    if !known {
        return Err(KalError::validation(
            "workspace_not_found",
            "That workspace no longer exists.",
        )
        .log_and_convert("layout_save"));
    }
    core.transact(|tx| Ok((store::save_layout(tx, &workspace_id, &layout)?, Vec::new())))
        .map(|(saved, _)| saved)
        .map_err(|e| e.log_and_convert("layout_save"))
}

/// The user's saved layout presets (shapes only).
#[tauri::command(async)]
pub fn layout_presets(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
) -> Result<Vec<SavedLayoutPreset>, IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .read(store::list_presets)
        .map_err(|e| e.log_and_convert("layout_presets"))
}

/// Saves a layout's shape as a named preset.
#[tauri::command(async)]
pub fn layout_preset_save(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    name: String,
    layout: PaneLayout,
) -> Result<SavedLayoutPreset, IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .transact(|tx| Ok((store::save_preset(tx, &name, &layout)?, Vec::new())))
        .map(|(saved, _)| saved)
        .map_err(|e| e.log_and_convert("layout_preset_save"))
}

/// Deletes a saved preset.
#[tauri::command(async)]
pub fn layout_preset_delete(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    preset_id: String,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    state
        .core()?
        .transact(|tx| Ok((store::delete_preset(tx, &preset_id)?, Vec::new())))
        .map(|((), _)| ())
        .map_err(|e| e.log_and_convert("layout_preset_delete"))
}
