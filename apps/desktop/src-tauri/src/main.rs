// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Read-only release probe: exits before WebView, stores, providers, or any runtime starts.
    if std::env::args_os().skip(1).collect::<Vec<_>>() == [std::ffi::OsString::from("--build-info")]
    {
        println!(
            "{}",
            serde_json::json!({
                "schemaVersion": 1,
                // The app's runtime version (`X.Y.Z` or `X.Y.Z+N`), set by build.rs.
                "version": env!("KALCODE_APP_VERSION"),
                "channel": kalcode_contracts::app::BuildChannel::current(),
                "testHooks": kalcode_desktop_lib::environment::TEST_HOOKS_ENABLED,
                // Live Update's native fingerprint; null in development builds.
                "nativeFingerprint": kalcode_desktop_lib::live_update::native_fingerprint(),
            })
        );
        return;
    }
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
