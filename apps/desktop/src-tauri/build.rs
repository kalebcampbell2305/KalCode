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
];

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    if let Err(error) = tauri_build::try_build(attributes) {
        eprintln!("tauri build script failed: {error:#}");
        std::process::exit(1);
    }
}
