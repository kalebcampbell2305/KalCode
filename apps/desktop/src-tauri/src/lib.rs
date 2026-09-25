//! KalCode desktop shell. A thin layer over `kalcode_core::Core`: it resolves platform paths,
//! starts logging, exposes the allow-listed IPC commands, and manages the window lifecycle.

mod code_commands;
mod commands;
pub mod environment;
mod kalvoice_commands;
mod kalvoice_executor;
pub mod native_confirm;
pub mod permission_commands;
mod provider_commands;
mod thread_commands;

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
use thread_commands::ThreadsState;

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

fn start(app: &tauri::App, removed_overrides: &[String]) -> AppState {
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
    match open_core(config) {
        Ok(core) => state.core = Some(Arc::new(core)),
        Err(error) => {
            tracing::error!(event = "app.startup_failed", error_code = error.code, error = %error.diagnostic());
            state.startup_error = Some(error.to_ipc());
        }
    }
    state
}

/// Opens the core with this build's migrations. KalVoice's ledger (schema v6) isn't registered
/// until the event platform's v5 lands; only the end-to-end build, only against a test's own
/// `KALCODE_DATA_DIR`, and only when the KalVoice suite asks (`KALCODE_E2E_KALVOICE_SCHEMA=1`)
/// adds it now, behind an empty v5 stand-in. Real data folders never get either, so the real v5
/// applies cleanly later.
fn open_core(config: CoreConfig) -> Result<Core, KalError> {
    #[cfg(feature = "e2e")]
    if matches!(environment::data_dir_override(), DataDirOverride::Path(_))
        && std::env::var_os("KALCODE_E2E_KALVOICE_SCHEMA").is_some_and(|v| v == "1")
    {
        return Core::open_with_migrations(
            config,
            &kalcode_kalvoice::schema::migrations_with_kalvoice(),
        );
    }
    Core::open(config)
}

fn uses_default_data_dir() -> bool {
    matches!(environment::data_dir_override(), DataDirOverride::None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(removed_overrides: Vec<String>) {
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
        // KalVoice's push-to-talk key is registered from Rust only; the WebView has no
        // permission to call this plugin's commands.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(kalvoice_commands::on_shortcut)
                .build(),
        )
        .manage(code_commands::TerminalViews::default())
        .on_page_load(|webview, payload| {
            // A (re)load starts a fresh page whose JS callbacks no longer exist.
            if payload.event() == PageLoadEvent::Started
                && let Some(state) = webview.try_state::<AppState>()
            {
                state.drop_subscription(webview.label());
                code_commands::drop_views(webview);
                if let Some(threads) = webview.try_state::<ThreadsState>() {
                    threads.drop_stream(webview.label());
                }
            }
        })
        .setup(move |app| {
            // Test hooks' grant (debug and `e2e` builds only; release builds don't register the
            // commands). Kept outside `capabilities/` so it is never loaded otherwise.
            #[cfg(any(debug_assertions, feature = "e2e"))]
            app.add_capability(include_str!("../test-capabilities/test-hooks.json"))?;
            let state = start(app, &removed_overrides);
            let providers = provider_commands::ProviderState::from_process();
            // Z4 over Z1 (workspace roots) and Z3 (thread modes, bound once the runtime starts).
            let modes = Arc::new(thread_commands::ThreadModes::default());
            let permissions = permission_commands::PermissionState::new(
                state.core.clone(),
                state.core.clone().map_or_else(
                    || {
                        Arc::new(kalcode_permissions::NoWorkspaces)
                            as Arc<dyn kalcode_permissions::WorkspaceRoots>
                    },
                    |core| Arc::new(kalcode_permissions::CoreWorkspaceRoots::new(core)),
                ),
                modes.clone(),
            );
            let threads = ThreadsState::start(
                state.core.as_ref(),
                providers.registry(),
                permissions.service(),
                &modes,
            );
            let kalvoice = kalvoice_commands::init(
                app.handle(),
                state.core.clone(),
                &state.info,
                providers.registry(),
                threads.runtime_handle(),
                permissions.service(),
            );
            app.manage(kalvoice);
            app.manage(state);
            app.manage(providers);
            app.manage(permissions);
            app.manage(threads);

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
            commands::events_query,
            commands::events_subscribe,
            commands::events_unsubscribe,
            commands::diagnostics_get,
            commands::diagnostics_open_log_dir,
            commands::diagnostics_open_data_dir,
            commands::secure_store_check,
            kalvoice_commands::kalvoice_subscribe,
            kalvoice_commands::kalvoice_status,
            kalvoice_commands::kalvoice_request,
            kalvoice_commands::kalvoice_preferences_update,
            kalvoice_commands::kalvoice_listen_start,
            kalvoice_commands::kalvoice_listen_stop,
            kalvoice_commands::kalvoice_listen_cancel,
            kalvoice_commands::kalvoice_model_download,
            kalvoice_commands::kalvoice_model_cancel,
            kalvoice_commands::kalvoice_model_delete,
            kalvoice_commands::kalvoice_talk,
            kalvoice_commands::kalvoice_type_instead,
            kalvoice_commands::kalvoice_confirm,
            kalvoice_commands::kalvoice_latency,
            kalvoice_commands::kalvoice_latency_record,
            provider_commands::providers_list,
            provider_commands::providers_detect,
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
            thread_commands::thread_list,
            thread_commands::thread_get,
            thread_commands::thread_messages,
            thread_commands::thread_tool_calls,
            thread_commands::thread_options,
            thread_commands::thread_create,
            thread_commands::thread_send,
            thread_commands::thread_interrupt,
            thread_commands::thread_resume,
            thread_commands::thread_stop,
            thread_commands::thread_rename,
            thread_commands::thread_archive,
            thread_commands::thread_stream,
            permission_commands::approval_list,
            permission_commands::approval_decide,
            permission_commands::permission_profiles_list,
            permission_commands::thread_set_permission_mode,
            permission_commands::permission_settings_get,
            permission_commands::permission_settings_update,
            #[cfg(any(debug_assertions, feature = "e2e"))]
            permission_commands::test_permission_probe,
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
            // End provider sessions (and their process trees) before the core records its
            // shutdown; their threads become `interrupted`, resumable.
            if let Some(threads) = handle.try_state::<ThreadsState>() {
                threads.shutdown();
            }
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
