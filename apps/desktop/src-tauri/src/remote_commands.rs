//! Settings › Remote: turn KalCode Remote on or off, pair a device, remove one. Administered
//! only from the main window; the window re-reads `remote_status` on `remote-changed`.

use kalcode_core::{IpcError, KalError};
use tauri::WebviewWindow;

use crate::remote::{RemoteState, RemoteStatus};
use crate::runtime_coordinator::RuntimeState;

fn require_main(window: &WebviewWindow) -> Result<(), IpcError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(KalError::validation(
            "remote_window_not_allowed",
            "KalCode Remote can only be managed from the main KalCode window.",
        )
        .to_ipc())
    }
}

#[tauri::command(async)]
pub fn remote_status(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: RuntimeState<RemoteState>,
) -> Result<RemoteStatus, IpcError> {
    _runtime_access.revalidate()?;
    require_main(&window)?;
    state.revalidate()?;
    Ok(state.status())
}

#[tauri::command(async)]
pub fn remote_set_enabled(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: RuntimeState<RemoteState>,
    enabled: bool,
) -> Result<RemoteStatus, IpcError> {
    _runtime_access.revalidate()?;
    require_main(&window)?;
    state.revalidate()?;
    state.set_enabled(enabled)
}

#[tauri::command(async)]
pub fn remote_pair_start(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: RuntimeState<RemoteState>,
) -> Result<RemoteStatus, IpcError> {
    _runtime_access.revalidate()?;
    require_main(&window)?;
    state.revalidate()?;
    state.pair_start()
}

#[tauri::command(async)]
pub fn remote_pair_cancel(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: RuntimeState<RemoteState>,
) -> Result<RemoteStatus, IpcError> {
    _runtime_access.revalidate()?;
    require_main(&window)?;
    state.revalidate()?;
    Ok(state.pair_cancel())
}

#[tauri::command(async)]
pub fn remote_device_revoke(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    state: RuntimeState<RemoteState>,
    device_id: String,
) -> Result<RemoteStatus, IpcError> {
    _runtime_access.revalidate()?;
    require_main(&window)?;
    state.revalidate()?;
    state.revoke(&device_id)
}
