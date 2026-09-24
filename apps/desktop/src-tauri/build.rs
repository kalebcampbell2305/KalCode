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
];

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    if let Err(error) = tauri_build::try_build(attributes) {
        eprintln!("tauri build script failed: {error:#}");
        std::process::exit(1);
    }
}
