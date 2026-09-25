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

/// Test builds only: the folder `workspace_open_dialog` opens instead of showing the native
/// picker (`KALCODE_E2E_PICK_FOLDER`, absolute path), so end-to-end tests can open a project.
/// Normal builds ignore it and always show the picker.
pub fn e2e_pick_folder() -> Option<PathBuf> {
    if !TEST_HOOKS_ENABLED {
        return None;
    }
    std::env::var_os("KALCODE_E2E_PICK_FOLDER")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
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

/// Test builds only: how native confirmation dialogs are answered without a person
/// (`KALCODE_E2E_NATIVE_CONFIRM` = `accept` | `decline`), so end-to-end tests can exercise flows
/// that need one. Normal builds ignore it and always show the dialog.
pub fn e2e_native_confirm() -> Option<bool> {
    if !TEST_HOOKS_ENABLED {
        return None;
    }
    parse_native_confirm(std::env::var("KALCODE_E2E_NATIVE_CONFIRM").ok().as_deref())
}

fn parse_native_confirm(value: Option<&str>) -> Option<bool> {
    match value? {
        "accept" => Some(true),
        "decline" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_confirm_hook_accepts_only_exact_values() {
        assert_eq!(parse_native_confirm(Some("accept")), Some(true));
        assert_eq!(parse_native_confirm(Some("decline")), Some(false));
        assert_eq!(parse_native_confirm(Some("ACCEPT")), None);
        assert_eq!(parse_native_confirm(Some("")), None);
        assert_eq!(parse_native_confirm(None), None);
    }
}
