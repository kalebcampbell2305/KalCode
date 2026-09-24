//! KalCode desktop shell. A thin layer over `kalcode_core::Core`: it resolves platform paths,
//! starts logging, exposes the allow-listed IPC commands, and manages the window lifecycle.

mod commands;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use kalcode_core::flags::BuildChannel;
use kalcode_core::logging::{self, LogGuard};
use kalcode_core::{AppInfo, Core, CoreConfig, IpcError, KalError, Paths};
use tauri::{Manager, RunEvent};

/// Shared state for command handlers. `core` is `None` when startup failed; the UI then shows
/// `startup_error` with recovery options instead of a broken shell.
pub struct AppState {
    pub core: Option<Arc<Core>>,
    pub startup_error: Option<IpcError>,
    pub info: AppInfo,
    pub paths: Paths,
    _log_guard: Option<LogGuard>,
}

impl AppState {
    pub fn core(&self) -> Result<&Arc<Core>, IpcError> {
        self.core.as_ref().ok_or_else(|| {
            self.startup_error.clone().unwrap_or_else(|| {
                KalError::internal("core_unavailable", "KalCode's runtime is not available.")
                    .to_ipc()
            })
        })
    }
}

fn resolve_data_dir(app: &tauri::App) -> Result<PathBuf, KalError> {
    if let Some(dir) = std::env::var_os("KALCODE_DATA_DIR").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    app.path().app_data_dir().map_err(|e| {
        KalError::new(
            kalcode_core::ErrorCategory::Filesystem,
            "data_dir_unavailable",
            "KalCode couldn't locate its data folder.",
        )
        .with_source(e)
    })
}

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        tracing::error!(event = "app.panic", location = %location, message = %logging::redact(&payload));
        default_hook(info);
    }));
}

fn start(app: &tauri::App) -> AppState {
    let channel = BuildChannel::current();
    let version = app.package_info().version.to_string();
    let info = AppInfo::current(&version, channel);

    let data_dir = match resolve_data_dir(app) {
        Ok(dir) => dir,
        Err(error) => {
            let fallback = std::env::temp_dir().join("KalCode");
            return AppState {
                core: None,
                startup_error: Some(error.to_ipc()),
                info,
                paths: Paths::new(fallback),
                _log_guard: None,
            };
        }
    };
    let paths = Paths::new(&data_dir);

    let log_guard = match logging::init(&paths.logs, cfg!(debug_assertions)) {
        Ok(guard) => Some(guard),
        Err(error) => {
            eprintln!("KalCode logging unavailable: {}", error.diagnostic());
            None
        }
    };
    install_panic_hook();

    let config = CoreConfig {
        paths: paths.clone(),
        app_version: version,
        channel,
    };
    match Core::open(config) {
        Ok(core) => AppState {
            core: Some(Arc::new(core)),
            startup_error: None,
            info,
            paths,
            _log_guard: log_guard,
        },
        Err(error) => {
            tracing::error!(event = "app.startup_failed", error_code = error.code, error = %error.diagnostic());
            AppState {
                core: None,
                startup_error: Some(error.to_ipc()),
                info,
                paths,
                _log_guard: log_guard,
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch focuses the existing window instead of opening another runtime
            // against the same database.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = start(app);
            app.manage(state);

            // Safety net: the frontend shows the window after its first themed paint
            // (`window_ready`). If that never happens, show it anyway so the user is never
            // left with an invisible app.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(4));
                    if !window.is_visible().unwrap_or(true) {
                        tracing::warn!(event = "window.shown_by_fallback");
                        let _ = window.show();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::boot,
            commands::window_ready,
            commands::settings_get,
            commands::settings_update,
            commands::events_recent,
            commands::events_subscribe,
            commands::events_unsubscribe,
            commands::diagnostics_get,
            commands::diagnostics_open_log_dir,
            commands::diagnostics_open_data_dir,
            commands::secure_store_check,
        ])
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("KalCode failed to start: {error}");
            std::process::exit(1);
        }
    };

    app.run(|handle, event| {
        if let RunEvent::Exit = event
            && let Some(core) = handle.try_state::<AppState>().and_then(|s| s.core.clone())
        {
            core.shutdown();
        }
    });
}
