//! Platform storage for untrusted Browser panes. WKWebView ignores filesystem data directories;
//! macOS 14+ instead uses a persistent data-store UUID scoped to the canonical profile location.

use std::path::PathBuf;
use tauri::Runtime;
use tauri::webview::WebviewBuilder;

pub fn configure<R: Runtime>(builder: WebviewBuilder<R>, directory: PathBuf) -> WebviewBuilder<R> {
    #[cfg(target_os = "macos")]
    {
        builder.data_store_identifier(store_identifier(&directory))
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder.data_directory(directory)
    }
}

#[cfg(any(target_os = "macos", test))]
fn store_identifier(directory: &std::path::Path) -> [u8; 16] {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(b"com.kalcode.desktop/browser-store/v1\0");
    digest.update(directory.as_os_str().as_encoded_bytes());
    let bytes = digest.finalize();
    let mut id = [0; 16];
    id.copy_from_slice(&bytes[..16]);
    // RFC 9562 version 8: application-defined deterministic UUID with the standard variant.
    id[6] = (id[6] & 0x0f) | 0x80;
    id[8] = (id[8] & 0x3f) | 0x80;
    id
}

#[cfg(test)]
mod tests {
    use super::store_identifier;
    use std::path::Path;

    #[test]
    fn profiles_are_stable_but_do_not_share_workspaces_or_data_roots() {
        let first = Path::new("/Users/test/Library/KalCode/browser-data/workspace-a");
        let other_workspace = Path::new("/Users/test/Library/KalCode/browser-data/workspace-b");
        let isolated_test = Path::new("/tmp/kalcode-e2e/browser-data/workspace-a");
        let id = store_identifier(first);
        assert_eq!(id, store_identifier(first));
        assert_ne!(id, store_identifier(other_workspace));
        assert_ne!(id, store_identifier(isolated_test));
        assert_eq!(id[6] >> 4, 8);
        assert_eq!(id[8] >> 6, 2);
    }

    #[test]
    fn spaces_and_unicode_are_preserved_in_profile_identity() {
        assert_ne!(
            store_identifier(Path::new("/Users/test/Projects/研发 space")),
            store_identifier(Path::new("/Users/test/Projects/研发space")),
        );
    }
}
