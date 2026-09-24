//! IPC commands. Each handler validates input natively and returns `IpcError` on failure —
//! internal error details are logged, never sent to the WebView.

use kalcode_core::events::{EventEnvelope, SubscriptionId};
use kalcode_core::settings::{Settings, SettingsPatch};
use kalcode_core::time::now_rfc3339;
use kalcode_core::{BootState, Diagnostics, ErrorCategory, IpcError, KalError, SecureStoreCheck};
use kalcode_secure_store::{OsSecretStore, SecretStore, SecretStoreError};
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::AppState;

#[tauri::command]
pub fn boot(state: State<'_, AppState>) -> BootState {
    BootState {
        info: state.info.clone(),
        startup_error: state.startup_error.clone(),
    }
}

/// Called by the frontend after its first themed paint; shows the window without a flash.
#[tauri::command]
pub fn window_ready(window: WebviewWindow) -> Result<(), IpcError> {
    if window.label() != "main" {
        return Err(KalError::validation("unknown_window", "Unknown window.").to_ipc());
    }
    window
        .show()
        .and_then(|()| window.set_focus())
        .map_err(|e| {
            KalError::internal("window_show_failed", "KalCode couldn't show its window.")
                .with_source(e)
                .log_and_convert("window_ready")
        })
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Result<Settings, IpcError> {
    state
        .core()?
        .settings()
        .map_err(|e| e.log_and_convert("settings_get"))
}

#[tauri::command]
pub fn settings_update(
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> Result<Settings, IpcError> {
    state
        .core()?
        .update_settings(&patch)
        .map_err(|e| e.log_and_convert("settings_update"))
}

#[tauri::command]
pub fn events_recent(
    state: State<'_, AppState>,
    limit: u32,
    before_seq: Option<i64>,
) -> Result<Vec<EventEnvelope>, IpcError> {
    if before_seq.is_some_and(|seq| seq < 1) {
        return Err(
            KalError::validation("invalid_cursor", "The history cursor is invalid.").to_ipc(),
        );
    }
    state
        .core()?
        .recent_events(limit, before_seq)
        .map_err(|e| e.log_and_convert("events_recent"))
}

#[tauri::command]
pub fn events_subscribe(
    state: State<'_, AppState>,
    on_event: Channel<EventEnvelope>,
) -> Result<SubscriptionId, IpcError> {
    let core = state.core()?;
    Ok(core.subscribe(move |event| on_event.send(event.clone()).is_ok()))
}

#[tauri::command]
pub fn events_unsubscribe(
    state: State<'_, AppState>,
    id: SubscriptionId,
) -> Result<bool, IpcError> {
    Ok(state.core()?.unsubscribe(id))
}

#[tauri::command]
pub fn diagnostics_get(state: State<'_, AppState>) -> Result<Diagnostics, IpcError> {
    state
        .core()?
        .diagnostics()
        .map_err(|e| e.log_and_convert("diagnostics_get"))
}

fn open_native_dir(
    window: &WebviewWindow,
    dir: &std::path::Path,
    command: &'static str,
) -> Result<(), IpcError> {
    std::fs::create_dir_all(dir).map_err(|e| {
        KalError::new(
            ErrorCategory::Filesystem,
            "folder_unavailable",
            "KalCode couldn't open that folder.",
        )
        .with_source(e)
        .log_and_convert(command)
    })?;
    window
        .opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| {
            KalError::new(
                ErrorCategory::Filesystem,
                "open_folder_failed",
                "Your system couldn't open that folder.",
            )
            .with_source(e)
            .log_and_convert(command)
        })
}

/// Opens KalCode's log folder. The path is resolved natively; the WebView cannot choose it.
#[tauri::command]
pub fn diagnostics_open_log_dir(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    open_native_dir(&window, &state.paths.logs, "diagnostics_open_log_dir")
}

/// Opens KalCode's data folder (used by the startup-error screen).
#[tauri::command]
pub fn diagnostics_open_data_dir(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    open_native_dir(&window, &state.paths.data_dir, "diagnostics_open_data_dir")
}

/// Writes, reads back and deletes a random probe credential in the OS credential store.
#[tauri::command]
pub async fn secure_store_check(state: State<'_, AppState>) -> Result<SecureStoreCheck, IpcError> {
    let core = state.core()?.clone();
    let outcome = tauri::async_runtime::spawn_blocking(|| {
        let store = OsSecretStore::new();
        (store.backend(), kalcode_secure_store::probe(&store))
    })
    .await
    .map_err(|e| {
        KalError::internal(
            "check_interrupted",
            "The credential store check was interrupted.",
        )
        .with_source(e)
        .log_and_convert("secure_store_check")
    })?;

    let (backend, result) = outcome;
    let message = match &result {
        Ok(()) => None,
        Err(SecretStoreError::Unavailable(_)) => Some("Your system credential store isn't available. KalCode can't save provider credentials securely until it is.".to_owned()),
        Err(SecretStoreError::Access(_)) => Some("Your system credential store refused access. Check that it's unlocked, then run the check again.".to_owned()),
        Err(SecretStoreError::Mismatch | SecretStoreError::InvalidKey) => Some("The credential store returned unexpected data. Run the check again; if it keeps failing, export diagnostics.".to_owned()),
    };
    if let Err(error) = &result {
        tracing::warn!(event = "secure_store.check_failed", backend, error = %error);
    }
    core.record_secure_store_check(result.is_ok(), backend)
        .map_err(|e| e.log_and_convert("secure_store_check"))?;
    Ok(SecureStoreCheck {
        ok: result.is_ok(),
        backend: backend.to_owned(),
        checked_at: now_rfc3339(),
        message,
    })
}
