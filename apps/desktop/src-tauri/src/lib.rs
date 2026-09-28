//! KalCode desktop shell. A thin layer over `kalcode_core::Core`: it resolves platform paths,
//! starts logging, exposes the allow-listed IPC commands, and manages the window lifecycle.

mod account;
mod account_commands;
mod account_links;
mod command_registry;
mod runtime_coordinator;
mod runtime_lifecycle;
#[cfg(test)]
mod startup_recovery_tests;
#[cfg(test)]
mod window_lifecycle_tests;
use runtime_coordinator::RuntimeCoordinator;
mod browser_commands;
mod browser_policy;
mod browser_profile;
mod code_commands;
mod commands;
mod context_commands;
pub mod environment;
mod files_commands;
// Z6a: only the read-only `git_status`, `git_log` and `git_branches` are registered (Z7-W2's
// folder surface); the worktree and checkpoint commands wait for v7 and the lead's wiring.
mod doctor_commands;
#[allow(dead_code)]
mod git_commands;
mod kalvoice_accounting;
mod kalvoice_commands;
mod kalvoice_component_trust;
mod kalvoice_components;
mod kalvoice_executor;
mod kalvoice_guardian;
mod layout_commands;
mod locator_commands;
pub mod native_confirm;
mod notification_commands;
pub mod permission_commands;
mod provider_account_commands;
mod provider_auth_commands;
mod provider_commands;
mod provider_health_commands;
mod provider_pane_commands;
mod resource_commands;
mod runtime_shutdown;
mod session_resolver;
mod thread_commands;
mod updater_commands;
mod utility_commands;
use runtime_shutdown::RuntimeShutdown;

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

fn reconcile_core_startup(core: &Arc<Core>) -> kalcode_core::Result<(usize, u64)> {
    let recovered = context_commands::recover_deliveries(core)?;
    core.require_terminal_guardian()?;
    let invalidated = kalcode_providers::accounts::AccountStore::new(core.clone())
        .invalidate_cached_auth_on_start()?;
    Ok((recovered, invalidated))
}

fn start(app: &tauri::App, removed_overrides: &[String]) -> AppState {
    let channel = BuildChannel::current();
    let version = app.package_info().version.to_string();
    let mut info = AppInfo::current(&version, channel);
    // KalVoice is available on Stable. Outside development it requires this build to include
    // its on-device speech engine (`kalvoice-whisper`, which needs LLVM/libclang to build):
    // without it push to talk can't hear anything (docs/KALVOICE.md, "Building").
    info.flags.require_component(
        kalcode_core::flags::SurfaceId::KalVoice,
        kalcode_kalvoice::stt::ENGINE_AVAILABLE,
        channel,
    );

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
    // Z7-W2: `open_core` is `Core::open` (plus the provisional v11 for the E2E suite only).
    match locator_commands::open_core(config) {
        Ok(core) => {
            let core = Arc::new(core);
            match reconcile_core_startup(&core) {
                Ok((recovered, changed)) => {
                    if recovered > 0 {
                        tracing::info!(
                            event = "context.interrupted_deliveries_recovered",
                            count = recovered
                        );
                    }
                    if changed > 0 {
                        tracing::info!(
                            event = "provider_accounts.cached_auth_invalidated",
                            count = changed
                        );
                    }
                    state.core = Some(core);
                }
                Err(error) => {
                    tracing::error!(
                        event = "app.startup_failed",
                        error_code = error.code,
                        error = %error.diagnostic()
                    );
                    core.shutdown();
                    state.startup_error = Some(error.to_ipc());
                }
            }
        }
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

fn restore_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let Some(window) = app.get_window("main") else {
        return false;
    };
    // Keep all three independent attempts: a platform-specific unminimize failure must not keep
    // a retained window from being shown or focused by a second launch.
    let unminimized = window.unminimize().is_ok();
    let shown = window.show().is_ok();
    let focused = window.set_focus().is_ok();
    unminimized && shown && focused
}

fn route_main_close(
    label: &str,
    ready: bool,
    prevent_close: impl FnOnce(),
    request_exit: impl FnOnce(),
) {
    if label == "main" && !ready {
        // Keep the only owner-facing window alive until the bounded RunEvent shutdown path has
        // proved cleanup. Otherwise the last window is destroyed before ExitRequested can be
        // prevented, and a second launch has no window to restore while cleanup is in flight.
        prevent_close();
        request_exit();
    }
}

fn handle_window_event<R: tauri::Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let Some(exit) = window
        .app_handle()
        .try_state::<runtime_shutdown::ExitControl>()
    else {
        return;
    };
    route_main_close(
        window.label(),
        exit.ready.load(std::sync::atomic::Ordering::Acquire),
        || api.prevent_close(),
        || window.app_handle().exit(0),
    );
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExitAttempt {
    Ready,
    Start,
    Pending,
}

fn begin_exit_attempt(exit: &runtime_shutdown::ExitControl) -> ExitAttempt {
    use std::sync::atomic::Ordering;

    if exit.ready.load(Ordering::Acquire) {
        ExitAttempt::Ready
    } else if exit.requested.swap(true, Ordering::AcqRel) {
        ExitAttempt::Pending
    } else {
        ExitAttempt::Start
    }
}

fn finish_exit_attempt(exit: &runtime_shutdown::ExitControl, clean: bool) {
    use std::sync::atomic::Ordering;

    if clean {
        exit.ready.store(true, Ordering::Release);
    } else {
        exit.requested.store(false, Ordering::Release);
    }
}

#[cfg(feature = "e2e")]
fn build_e2e_main_webview(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = match environment::data_dir_override() {
        DataDirOverride::Path(path) => path,
        DataDirOverride::Invalid | DataDirOverride::None => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "E2E requires an absolute KALCODE_DATA_DIR.",
            )
            .into());
        }
    };
    let port = std::env::var("KALCODE_E2E_CDP_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value >= 1_024)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "E2E requires a valid KALCODE_E2E_CDP_PORT.",
            )
        })?;
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .cloned()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "E2E main window configuration is missing.",
            )
        })?;
    let browser_args = format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
    );
    tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
        .data_directory(data_dir.join("main-webview"))
        .additional_browser_args(&browser_args)
        .build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(removed_overrides: Vec<String>) {
    #[cfg(feature = "e2e")]
    let mut context = tauri::generate_context!();
    #[cfg(not(feature = "e2e"))]
    let context = tauri::generate_context!();
    #[cfg(feature = "e2e")]
    for config in &mut context.config_mut().app.windows {
        if config.label == "main" {
            // Build the trusted view explicitly in setup with a per-test profile and CDP port.
            // Browser children can then use their independent workspace profiles without a
            // process-global WebView2 override collapsing every view into one cookie jar.
            config.create = false;
        }
    }
    let mut builder = tauri::Builder::default()
        .on_window_event(handle_window_event)
        // KalVoice's push-to-talk key follows every KalCode window's focus changes.
        .on_window_event(kalvoice_commands::on_window_event);
    // A second launch against the default data folder focuses the running window. (Exclusive
    // use of a data folder is enforced separately by the core's lock file, in every mode.)
    if uses_default_data_dir() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = restore_main_window(app);
        }));
    }
    let app = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        // Used from Rust only (the native folder picker); the WebView gets no dialog permissions.
        .plugin(tauri_plugin_dialog::init())
        // KalVoice's push-to-talk key is registered from Rust only; the WebView has no
        // permission to call this plugin's commands.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(kalvoice_commands::on_shortcut)
                .build(),
        )
        .manage(RuntimeShutdown::default())
        .manage(runtime_shutdown::ExitControl::default())
        .manage(browser_commands::BrowserViews::default())
        .manage(code_commands::TerminalViews::default())
        // KalVoice's per-webview signal channels outlive account runtime generations.
        .manage(Arc::new(kalvoice_commands::KalVoiceSignals::default()))
        .on_page_load(|webview, payload| {
            // Untrusted native children must never outlive the trusted page that owns them.
            if payload.event() == PageLoadEvent::Started
                && webview.label() == "main"
                && let Some(views) = webview.try_state::<browser_commands::BrowserViews>()
                && browser_commands::begin_page_load(webview.app_handle(), &views).is_err()
            {
                tracing::error!(event = "browser.reload_cleanup_failed");
                // Keep a failed native child from intercepting a replacement trusted UI.
                let _ = webview.window().hide();
                webview.app_handle().exit(1);
                return;
            }
            // A (re)load starts a fresh page whose JS callbacks no longer exist.
            if payload.event() == PageLoadEvent::Started {
                kalvoice_commands::on_page_load_started(webview.app_handle(), webview.label());
            }
            if payload.event() == PageLoadEvent::Started
                && let Some(state) = webview.try_state::<AppState>()
            {
                state.drop_subscription(webview.label());
                code_commands::drop_views(webview);
                provider_pane_commands::drop_views(webview);
                if let Ok(threads) = runtime_coordinator::RuntimeState::<ThreadsState>::from_app(
                    webview.app_handle(),
                ) {
                    threads.drop_stream(webview.label());
                }
            }
            if payload.event() == PageLoadEvent::Finished && webview.label() == "main" {
                kalvoice_commands::on_page_load(webview.app_handle());
            }
        })
        .setup(move |app| {
            #[cfg(feature = "e2e")]
            build_e2e_main_webview(app)?;
            // Test hooks' grant (debug and `e2e` builds only; release builds don't register the
            // commands). Kept outside `capabilities/` so it is never loaded otherwise.
            #[cfg(any(debug_assertions, feature = "e2e"))]
            app.add_capability(include_str!("../test-capabilities/test-hooks.json"))?;
            #[cfg(feature = "e2e")]
            let fixture_account = account::e2e::runtime_from_environment(&resolve_data_dir(app)?)?;
            let state = start(app, &removed_overrides);
            #[cfg(feature = "e2e")]
            let account = fixture_account.unwrap_or_else(|| {
                Arc::new(account::runtime::AccountRuntime::production(Arc::new(
                    kalcode_secure_store::OsSecretStore::new(),
                )))
            });
            #[cfg(not(feature = "e2e"))]
            let account = Arc::new(account::runtime::AccountRuntime::production(Arc::new(
                kalcode_secure_store::OsSecretStore::new(),
            )));
            let coordinator = RuntimeCoordinator::new(account.clone());
            app.manage(account.clone());
            app.manage(coordinator.clone());
            let updater_app = app.handle().clone();
            let updater = updater_commands::DesktopUpdaterState::start(
                app.handle().clone(),
                &state.paths.data_dir,
                &state.info.version,
                option_env!("KALCODE_UPDATER_PUBLIC_KEY"),
                Arc::new(move || shutdown_runtime(&updater_app)),
            );
            app.manage(updater.clone());
            app.manage(state);
            coordinator.observe(app.handle().clone())?;
            // On the main thread, whose message loop delivers OS foreground changes.
            kalvoice_commands::watch_foreground(app.handle());
            account_links::start(app.handle(), account, coordinator);
            updater.check_in_background();
            updater.start_periodic_checks();

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
        .invoke_handler(move |invoke| {
            let command = invoke.message.command();
            let authority = invoke
                .message
                .state_ref()
                .try_get::<Arc<account::runtime::AccountRuntime>>()
                .map(|account| account.authority())
                .unwrap_or(account::model::AccountAuthority::SignedOut);
            if let account::guard::CommandAuthorization::Denied(code) =
                account::guard::authorize_command(command, authority)
            {
                invoke.resolver.reject(
                    KalError::validation(
                        code,
                        "Sign in to an active account before using this command.",
                    )
                    .to_ipc(),
                );
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                runtime_coordinator::runtime_status,
                runtime_coordinator::runtime_retry,
                account_commands::account_bootstrap,
                account_commands::account_status,
                account_commands::account_email_start,
                account_commands::account_social_start,
                account_commands::account_email_poll,
                account_commands::account_auth_cancel,
                account_commands::account_activate_free,
                account_commands::account_checkout,
                account_commands::account_portal,
                account_commands::account_refresh,
                account_commands::account_logout,
                account_commands::account_usage,
                provider_auth_commands::provider_claude_account_refresh,
                provider_auth_commands::provider_claude_login_start,
                provider_auth_commands::provider_claude_login_wait,
                provider_auth_commands::provider_claude_login_cancel,
                provider_auth_commands::provider_claude_logout,
                provider_auth_commands::provider_gemini_account_refresh,
                provider_auth_commands::provider_gemini_login_start,
                provider_auth_commands::provider_gemini_login_wait,
                provider_auth_commands::provider_gemini_login_cancel,
                provider_auth_commands::provider_gemini_logout,
                updater_commands::updater_status,
                updater_commands::updater_set_channel,
                updater_commands::updater_check,
                updater_commands::updater_cancel,
                updater_commands::updater_install,
                updater_commands::updater_restore_previous,
                browser_commands::browser_attach,
                browser_commands::browser_page_lease,
                context_commands::context_file_pick,
                context_commands::context_preview_create,
                context_commands::context_item_set,
                context_commands::context_item_confirm,
                context_commands::context_discard,
                context_commands::context_send,
                browser_commands::browser_set_view,
                browser_commands::browser_navigate,
                browser_commands::browser_action,
                browser_commands::browser_focus,
                browser_commands::browser_info,
                browser_commands::browser_close,
                browser_commands::browser_hide_all,
                browser_commands::browser_open_external,
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
                kalvoice_commands::kalvoice_reasoning_prepare,
                kalvoice_commands::kalvoice_reasoning_retry,
                kalvoice_commands::kalvoice_model_cancel,
                kalvoice_commands::kalvoice_model_delete,
                kalvoice_commands::kalvoice_open_microphone_settings,
                kalvoice_commands::kalvoice_talk,
                kalvoice_commands::kalvoice_type_instead,
                kalvoice_commands::kalvoice_latency,
                kalvoice_commands::kalvoice_latency_record,
                provider_auth_commands::provider_codex_account_refresh,
                provider_auth_commands::provider_codex_login_start,
                provider_auth_commands::provider_codex_login_wait,
                provider_auth_commands::provider_codex_login_cancel,
                provider_auth_commands::provider_codex_logout,
                provider_account_commands::provider_accounts_list,
                provider_account_commands::provider_account_create,
                provider_account_commands::provider_account_rename,
                provider_account_commands::provider_account_set_default,
                provider_account_commands::provider_account_archive,
                provider_account_commands::provider_account_bind,
                provider_account_commands::provider_account_unbind,
                provider_account_commands::provider_account_bindings_list,
                provider_commands::providers_list,
                provider_commands::providers_detect,
                provider_health_commands::provider_health_list,
                provider_health_commands::provider_health_get,
                provider_health_commands::provider_health_trend,
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
                session_resolver::session_resolve,
                thread_commands::thread_get,
                thread_commands::thread_messages,
                thread_commands::thread_tool_calls,
                thread_commands::thread_options,
                thread_commands::thread_create,
                thread_commands::thread_review_create_prompt,
                thread_commands::thread_review_prompt,
                thread_commands::thread_cancel_prompt_review,
                thread_commands::thread_send,
                thread_commands::thread_interrupt,
                thread_commands::thread_resume,
                thread_commands::thread_stop,
                thread_commands::thread_rebind_account,
                thread_commands::thread_rename,
                thread_commands::thread_archive,
                thread_commands::thread_stream,
                permission_commands::approval_list,
                permission_commands::approval_decide,
                permission_commands::permission_profiles_list,
                permission_commands::thread_set_permission_mode,
                permission_commands::permission_settings_get,
                permission_commands::permission_settings_update,
                provider_pane_commands::provider_pane_create,
                provider_pane_commands::provider_pane_attach,
                provider_pane_commands::provider_pane_ack,
                provider_pane_commands::provider_pane_detach,
                provider_pane_commands::provider_pane_write,
                provider_pane_commands::provider_pane_resize,
                provider_pane_commands::provider_pane_info,
                // Z7-W2: Session Locator, rail, home, recent work, workspace actions.
                locator_commands::locator_search,
                locator_commands::locator_open,
                locator_commands::rail_state,
                locator_commands::rail_update,
                locator_commands::rail_section_set,
                locator_commands::rail_group_create,
                locator_commands::rail_group_update,
                locator_commands::rail_group_delete,
                locator_commands::rail_group_reorder,
                locator_commands::home_summary,
                locator_commands::recent_work,
                locator_commands::workspace_reveal,
                locator_commands::workspace_create,
                // Z6a read-only (folder surface).
                files_commands::files_list,
                git_commands::git_status,
                resource_commands::resource_report,
                resource_commands::resource_set_mode,
                resource_commands::resource_set_view_open,
                doctor_commands::doctor_run,
                doctor_commands::doctor_cancel,
                doctor_commands::doctor_last,
                doctor_commands::doctor_fix_preview,
                doctor_commands::doctor_fix,
                doctor_commands::doctor_revert,
                doctor_commands::doctor_ignore,
                doctor_commands::doctor_ignored,
                doctor_commands::doctor_fix_log,
                utility_commands::utility_status,
                utility_commands::utility_http_send,
                utility_commands::utility_http_history,
                utility_commands::utility_http_history_clear,
                utility_commands::utility_http_saved_list,
                utility_commands::utility_http_saved_save,
                utility_commands::utility_http_saved_delete,
                utility_commands::utility_effect_continue,
                utility_commands::utility_processes,
                utility_commands::utility_process_signal,
                utility_commands::utility_process_restart,
                utility_commands::utility_ports,
                utility_commands::utility_port_lookup,
                utility_commands::utility_env_list,
                utility_commands::utility_env_reveal,
                utility_commands::utility_sqlite_candidates,
                utility_commands::utility_sqlite_open,
                utility_commands::utility_sqlite_pick,
                utility_commands::utility_sqlite_describe,
                utility_commands::utility_sqlite_query,
                utility_commands::utility_sqlite_write,
                utility_commands::utility_sqlite_close,
                utility_commands::utility_regex,
                utility_commands::utility_file_find,
                utility_commands::utility_file_read,
                utility_commands::utility_scratchpad_list,
                utility_commands::utility_scratchpad_save,
                utility_commands::utility_scratchpad_delete,
                git_commands::git_log,
                git_commands::git_branches,
                layout_commands::layout_get,
                layout_commands::layout_save,
                layout_commands::layout_presets,
                layout_commands::layout_preset_save,
                layout_commands::layout_preset_delete,
                notification_commands::notification_list,
                notification_commands::notification_mark,
                #[cfg(any(debug_assertions, feature = "e2e"))]
                permission_commands::test_permission_probe,
            ];
            handler(invoke)
        })
        .build(context);

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("KalCode failed to start: {error}");
            std::process::exit(1);
        }
    };

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            let exit = handle.state::<runtime_shutdown::ExitControl>();
            match begin_exit_attempt(&exit) {
                ExitAttempt::Ready => {}
                ExitAttempt::Pending => api.prevent_exit(),
                ExitAttempt::Start => {
                    api.prevent_exit();
                    let handle = handle.clone();
                    std::thread::spawn(move || {
                        if shutdown_runtime(&handle) {
                            finish_exit_attempt(
                                &handle.state::<runtime_shutdown::ExitControl>(),
                                true,
                            );
                            handle.exit(code.unwrap_or(0));
                        } else {
                            finish_exit_attempt(
                                &handle.state::<runtime_shutdown::ExitControl>(),
                                false,
                            );
                            tracing::error!(event = "app.exit_cleanup_incomplete");
                        }
                    });
                }
            }
        } else if let RunEvent::Exit = event {
            shutdown_services(handle);
        }
    });
}

fn shutdown_runtime(handle: &tauri::AppHandle) -> bool {
    handle
        .state::<RuntimeShutdown>()
        .run(|| shutdown_runtime_once(handle))
}

fn shutdown_runtime_once(handle: &tauri::AppHandle) -> bool {
    if let Some(coordinator) = handle.try_state::<Arc<RuntimeCoordinator>>() {
        coordinator.request_drain(true);
        if !coordinator.wait_drained(Duration::from_secs(30)) {
            return false;
        }
    }
    shutdown_services(handle);
    true
}

fn shutdown_services(handle: &tauri::AppHandle) {
    if let Some(updater) = handle.try_state::<updater_commands::DesktopUpdaterState>() {
        updater.stop_periodic_checks();
    }
    if let Some(state) = handle.try_state::<AppState>() {
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
}
