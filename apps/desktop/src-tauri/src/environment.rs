//! Process-environment policy.
//!
//! WebView2 honours environment variables that change how the embedded browser runs: one can
//! open a Chrome DevTools Protocol port (letting any local process script the trusted UI and
//! call every allow-listed command), another swaps the browser runtime. In normal builds these
//! are removed before anything else runs, and `KALCODE_DATA_DIR` is ignored. Debug builds and
//! builds with the `e2e` feature (used only by the end-to-end test suite) keep them.

use std::path::PathBuf;

/// Whether test and development hooks are compiled in.
pub const TEST_HOOKS_ENABLED: bool = cfg!(any(debug_assertions, feature = "e2e"));

/// Browser-runtime overrides removed from the environment in normal builds.
pub const WEBVIEW_OVERRIDES: &[&str] = &[
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
    "WEBVIEW2_USER_DATA_FOLDER",
    "WEBVIEW2_RELEASE_CHANNEL_PREFERENCE",
    "WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER",
    "WEBKIT_INSPECTOR_SERVER",
    "WEBKIT_INSPECTOR_HTTP_SERVER",
];

/// Names of overrides present in the environment (to be removed by `main`).
pub fn present_webview_overrides() -> Vec<&'static str> {
    if TEST_HOOKS_ENABLED {
        return Vec::new();
    }
    WEBVIEW_OVERRIDES
        .iter()
        .copied()
        .filter(|name| std::env::var_os(name).is_some())
        .collect()
}

/// Outcome of reading `KALCODE_DATA_DIR`.
#[derive(Debug, PartialEq, Eq)]
pub enum DataDirOverride {
    /// Not set, or ignored in this build.
    None,
    Path(PathBuf),
    /// Set but not an absolute path.
    Invalid,
}

pub fn data_dir_override() -> DataDirOverride {
    if !TEST_HOOKS_ENABLED {
        return DataDirOverride::None;
    }
    match std::env::var_os("KALCODE_DATA_DIR").filter(|v| !v.is_empty()) {
        None => DataDirOverride::None,
        Some(value) => {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                DataDirOverride::Path(path)
            } else {
                DataDirOverride::Invalid
            }
        }
    }
}
