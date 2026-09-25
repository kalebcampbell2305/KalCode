// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let removed = remove_webview_overrides();
    kalcode_desktop_lib::run(removed);
}

/// Strips browser-runtime overrides (every `WEBVIEW2_*`, `COREWEBVIEW2_*` and
/// `WEBKIT_INSPECTOR*` variable) from the environment before anything reads it. See
/// `environment.rs`. Returns the names removed so they can be logged once logging starts.
#[allow(unsafe_code)]
fn remove_webview_overrides() -> Vec<String> {
    let present = kalcode_desktop_lib::environment::present_webview_overrides();
    for name in &present {
        // SAFETY: this is the first thing `main` does. No other thread exists yet (Tauri,
        // logging and the runtime have not started), so nothing can read or write the
        // environment concurrently — the precondition `remove_var` requires.
        unsafe { std::env::remove_var(name) };
    }
    present
        .iter()
        .map(|name| name.to_string_lossy().into_owned())
        .collect()
}
