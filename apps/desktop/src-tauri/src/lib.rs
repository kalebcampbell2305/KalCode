//! KalCode desktop shell. A thin layer over `kalcode_core::Core`: it resolves platform paths,
//! starts logging, exposes the allow-listed IPC commands, and manages the window lifecycle.

mod code_commands;
mod commands;
pub mod environment;

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use environment::DataDirOverride;
use kalcode_core::events::SubscriptionId;
use kalcode_core::flags::BuildChannel;
use kalcode_core::logging::{self, LogGuard};
use kalcode_core::{AppInfo, Core, CoreConfig, ErrorCategory, IpcError, KalError, Paths};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent};

/// Shared state for command handlers. `core` is `None` when startup failed; the UI then shows
/// `startup_error` with recovery options instead of a broken shell.
pub struct AppState {
    pub core: Option<Arc<Core>>,
    pub startup_error: Option<IpcError>,
    pub info: AppInfo,
    pub paths: Paths,
    /// One live event subscription per webview label. A page reload or a new subscription
    /// from the same webview replaces the previous one, so dead channels never accumulate.
    pub subscriptions: Mutex<HashMap<String, SubscriptionId>>,
    /// Time of the last credential-store check, for a short cooldown.
    pub last_store_check: Mutex<Option<Instant>>,
    /// Dropped on exit so buffered log lines are flushed before the process ends.
    log_guard: Mutex<Option<LogGuard>>,
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

    /// Removes the event subscription held by `label`, if any.
    pub fn drop_subscription(&self, label: &str) {
        let removed = self
            .subscriptions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(label);
        if let (Some(id), Some(core)) = (removed, &self.core) {
            core.unsubscribe(id);
        }
    }

    fn new(info: AppInfo, paths: Paths) -> Self {
        Self {
            core: None,
            startup_error: None,
            info,
            paths,
            subscriptions: Mutex::new(HashMap::new()),
            last_store_check: Mutex::new(None),
            log_guard: Mutex::new(None),
        }
    }
}

fn resolve_data_dir(app: &tauri::App) -> Result<PathBuf, KalError> {
    match environment::data_dir_override() {
        DataDirOverride::Path(dir) => return Ok(dir),
        DataDirOverride::Invalid => {
            return Err(KalError::validation(
                "invalid_data_dir",
                "KALCODE_DATA_DIR must be an absolute path.",
            ));
        }
        DataDirOverride::None => {}
    }
    app.path().app_data_dir().map_err(|e| {
        KalError::new(
            ErrorCategory::Filesystem,
            "data_dir_unavailable",
            "KalCode couldn't locate its data folder.",
        )
        .with_source(e)
    })
}

/// Records panics synchronously to `logs/crash.log` (the structured log writer runs on a
/// background thread and would not flush before `panic = "abort"` ends the process), and to
/// the structured log for development builds.
fn install_panic_hook(log_dir: PathBuf) {
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
        let message = logging::redact(&payload);
        let record = format!(
            "{} panic at {location}: {message}\n",
            kalcode_core::time::now_rfc3339()
        );
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("crash.log"))
        {
            let _ = file.write_all(record.as_bytes());
            let _ = file.sync_all();
        }
        tracing::error!(event = "app.panic", location = %location, message = %message);
        default_hook(info);
    }));
}

fn start(app: &tauri::App, removed_overrides: &[&str]) -> AppState {
    let channel = BuildChannel::current();
    let version = app.package_info().version.to_string();
    let info = AppInfo::current(&version, channel);

    let data_dir = match resolve_data_dir(app) {
        Ok(dir) => dir,
        Err(error) => {
            let mut state = AppState::new(info, Paths::new(std::env::temp_dir().join("KalCode")));
            state.startup_error = Some(error.to_ipc());
            return state;
        }
    };
    let mut state = AppState::new(info, Paths::new(&data_dir));

    match logging::init(&state.paths.logs, cfg!(debug_assertions)) {
        Ok(guard) => {
            *state
                .log_guard
                .get_mut()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(guard)
        }
        Err(error) => eprintln!("KalCode logging unavailable: {}", error.diagnostic()),
    }
    install_panic_hook(state.paths.logs.clone());
    if !removed_overrides.is_empty() {
        tracing::warn!(event = "environment.webview_overrides_removed", variables = ?removed_overrides);
    }

    let config = CoreConfig {
        paths: state.paths.clone(),
        app_version: version,
        channel,
    };
    match Core::open(config) {
        Ok(core) => state.core = Some(Arc::new(core)),
        Err(error) => {
            tracing::error!(event = "app.startup_failed", error_code = error.code, error = %error.diagnostic());
            state.startup_error = Some(error.to_ipc());
        }
    }
    state
}

fn uses_default_data_dir() -> bool {
    matches!(environment::data_dir_override(), DataDirOverride::None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(removed_overrides: Vec<&'static str>) {
    let mut builder = tauri::Builder::default();
    // A second launch against the default data folder focuses the running window. (Exclusive
    // use of a data folder is enforced separately by the core's lock file, in every mode.)
    if uses_default_data_dir() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_opener::init())
        // Used from Rust only (the native folder picker); the WebView gets no dialog permissions.
        .plugin(tauri_plugin_dialog::init())
        .manage(code_commands::TerminalViews::default())
        .on_page_load(|webview, payload| {
            // A (re)load starts a fresh page whose JS callbacks no longer exist.
            if payload.event() == PageLoadEvent::Started
                && let Some(state) = webview.try_state::<AppState>()
            {
                state.drop_subscription(webview.label());
                code_commands::drop_views(webview);
            }
        })
        .setup(move |app| {
            let state = start(app, &removed_overrides);
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
            code_commands::workspace_list,
            code_commands::workspace_active,
            code_commands::workspace_open_dialog,
            code_commands::workspace_activate,
            code_commands::workspace_remove,
            code_commands::shells_list,
            code_commands::terminal_list,
            code_commands::terminal_create,
            code_commands::terminal_restart,
            code_commands::terminal_close,
            code_commands::terminal_write,
            code_commands::terminal_resize,
            code_commands::terminal_attach,
            code_commands::terminal_detach,
            code_commands::terminal_ack,
            code_commands::terminal_set_active,
            code_commands::terminals_running,
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
            && let Some(state) = handle.try_state::<AppState>()
        {
            if let Some(core) = &state.core {
                core.shutdown();
            }
            // Flush and stop the background log writer before the process exits.
            drop(
                state
                    .log_guard
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take(),
            );
        }
    });
}
