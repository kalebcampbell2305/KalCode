//! Process-environment policy.
//!
//! WebView2 honours environment variables that change how the embedded browser runs: one can
//! open a Chrome DevTools Protocol port (letting any local process script the trusted UI and
//! call every allow-listed command), another swaps the browser runtime. In normal builds these
//! are removed before anything else runs, and `KALCODE_DATA_DIR` is ignored. Debug builds and
//! builds with the `e2e` feature (used only by the end-to-end test suite) keep them.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

/// Whether test and development hooks are compiled in.
pub const TEST_HOOKS_ENABLED: bool = cfg!(any(debug_assertions, feature = "e2e"));

/// Prefixes of browser-runtime override variables removed from the environment in normal
/// builds. Prefixes rather than a fixed list, so a variable a newer runtime starts honouring is
/// removed too. Sources (Microsoft Learn, WebView2): `WEBVIEW2_*` — the loader's documented
/// overrides (`WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`, `WEBVIEW2_USER_DATA_FOLDER`,
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, `WEBVIEW2_RELEASE_CHANNEL_PREFERENCE`,
/// `WEBVIEW2_CHANNEL_SEARCH_KIND`, `WEBVIEW2_RELEASE_CHANNELS`, `WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER`,
/// `WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER`, …;
/// https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl);
/// `COREWEBVIEW2_*` — runtime overrides such as `COREWEBVIEW2_MAX_INSTANCES` and
/// `COREWEBVIEW2_FORCED_HOSTING_MODE` (same reference). `WEBKIT_INSPECTOR*` covers the WebKit
/// remote inspector (`WEBKIT_INSPECTOR_SERVER`, `WEBKIT_INSPECTOR_HTTP_SERVER`) on Linux.
pub const WEBVIEW_OVERRIDE_PREFIXES: &[&str] = &["WEBVIEW2_", "COREWEBVIEW2_", "WEBKIT_INSPECTOR"];

/// Whether an environment variable name is a browser-runtime override. Case-insensitive: Windows
/// environment names are, and matching more names only removes more.
pub fn is_webview_override(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    WEBVIEW_OVERRIDE_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// The override names among `names` (pure; used by [`present_webview_overrides`] and tests).
pub fn webview_overrides_in<I>(names: I) -> Vec<OsString>
where
    I: IntoIterator<Item = OsString>,
{
    names
        .into_iter()
        .filter(|name| is_webview_override(name))
        .collect()
}

/// Names of overrides present in the environment (to be removed by `main`). Empty in builds
/// with test hooks, which keep them.
pub fn present_webview_overrides() -> Vec<OsString> {
    if TEST_HOOKS_ENABLED {
        return Vec::new();
    }
    webview_overrides_in(std::env::vars_os().map(|(name, _)| name))
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

    fn names(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn every_webview2_and_corewebview2_variable_matches_by_prefix() {
        let found = webview_overrides_in(names(&[
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
            "WEBVIEW2_USER_DATA_FOLDER",
            "WEBVIEW2_CHANNEL_SEARCH_KIND",
            "WEBVIEW2_RELEASE_CHANNELS",
            "WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER",
            "WEBVIEW2_SOME_FUTURE_OVERRIDE",
            "COREWEBVIEW2_FORCED_HOSTING_MODE",
            "COREWEBVIEW2_MAX_INSTANCES",
            "WEBKIT_INSPECTOR_SERVER",
            "WEBKIT_INSPECTOR_HTTP_SERVER",
        ]));
        assert_eq!(found.len(), 11, "{found:?}");
    }

    #[test]
    fn matching_ignores_case() {
        let found = webview_overrides_in(names(&[
            "webview2_additional_browser_arguments",
            "WebView2_User_Data_Folder",
            "CoreWebView2_Forced_Hosting_Mode",
        ]));
        assert_eq!(found.len(), 3, "{found:?}");
    }

    #[test]
    fn unrelated_variables_are_kept() {
        let found = webview_overrides_in(names(&[
            "PATH",
            "KALCODE_DATA_DIR",
            "MY_WEBVIEW2_NOTE",
            "WEBVIEW2",
            "WEBVIEW",
            "COREWEBVIEW",
        ]));
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn native_confirm_hook_accepts_only_exact_values() {
        assert_eq!(parse_native_confirm(Some("accept")), Some(true));
        assert_eq!(parse_native_confirm(Some("decline")), Some(false));
        assert_eq!(parse_native_confirm(Some("ACCEPT")), None);
        assert_eq!(parse_native_confirm(Some("")), None);
        assert_eq!(parse_native_confirm(None), None);
    }
}
