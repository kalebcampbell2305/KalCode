/// Every command the frontend may call. Tauri generates an `allow-<command>` permission for
/// each; `capabilities/main.json` grants them to the main window. Anything not listed here is
/// unreachable from the WebView.
const COMMANDS: &[&str] = &[
    "boot",
    "window_ready",
    "settings_get",
    "settings_update",
    "events_recent",
    "events_subscribe",
    "events_unsubscribe",
    "diagnostics_get",
    "diagnostics_open_log_dir",
    "diagnostics_open_data_dir",
    "secure_store_check",
    "kalvoice_subscribe",
    "kalvoice_status",
    "kalvoice_request",
    "kalvoice_preferences_update",
    "kalvoice_listen_start",
    "kalvoice_listen_stop",
    "kalvoice_listen_cancel",
    "kalvoice_model_download",
    "kalvoice_model_cancel",
    "kalvoice_model_delete",
    "kalvoice_talk",
    "kalvoice_type_instead",
    "kalvoice_confirm",
    "kalvoice_latency",
    "kalvoice_latency_record",
    "providers_list",
    "providers_detect",
    // Workspaces and terminals (Z1)
    "workspace_list",
    "workspace_active",
    "workspace_open_dialog",
    "workspace_activate",
    "workspace_remove",
    "shells_list",
    "terminal_list",
    "terminal_create",
    "terminal_restart",
    "terminal_close",
    "terminal_write",
    "terminal_resize",
    "terminal_attach",
    "terminal_detach",
    "terminal_ack",
    "terminal_set_active",
    "terminals_running",
    "thread_list",
    "thread_get",
    "thread_messages",
    "thread_tool_calls",
    "thread_options",
    "thread_create",
    "thread_send",
    "thread_interrupt",
    "thread_resume",
    "thread_stop",
    "thread_rename",
    "thread_archive",
    "thread_stream",
    // Z4: permissions.
    "approval_list",
    "approval_decide",
    "permission_profiles_list",
    "thread_set_permission_mode",
    "permission_settings_get",
    "permission_settings_update",
    // Test hook: refused unless test hooks are compiled in (debug and `e2e` builds).
    "test_permission_probe",
];

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    if let Err(error) = tauri_build::try_build(attributes) {
        eprintln!("tauri build script failed: {error:#}");
        std::process::exit(1);
    }
}
