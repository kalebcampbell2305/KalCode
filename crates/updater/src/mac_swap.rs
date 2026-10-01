//! Narrow primitives shared by the macOS updater and its post-exit helper.

use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};

use crate::UpdateError;

pub const MAC_APP_EXECUTABLE: &str = "Contents/MacOS/kalcode";

/// Beside `updater.json`: a KalCode launch stepped aside while the helper applied an update
/// after KalCode closed, so the helper opens KalCode when it finishes.
pub const REOPEN_MARKER: &str = "reopen-after-update";

#[must_use]
pub fn app_executable(app: &Path) -> PathBuf {
    app.join(MAC_APP_EXECUTABLE)
}

#[cfg(target_os = "macos")]
pub fn process_identity_sha256(pid: u32) -> Result<String, UpdateError> {
    let pid = pid.to_string();
    let output = std::process::Command::new("/bin/ps")
        .args(["-p", pid.as_str(), "-o", "lstart=", "-o", "command="])
        .output()
        .map_err(|_| helper_error())?;
    if !output.status.success() {
        return Err(helper_error());
    }
    let identity = std::str::from_utf8(&output.stdout)
        .map_err(|_| helper_error())?
        .trim();
    if identity.is_empty() || identity.len() > 16 * 1024 {
        return Err(helper_error());
    }
    Ok(format!("{:x}", Sha256::digest(identity.as_bytes())))
}

#[cfg(not(target_os = "macos"))]
pub fn process_identity_sha256(_pid: u32) -> Result<String, UpdateError> {
    Err(UpdateError::new(
        "update_target_unsupported",
        "Automatic updates aren't available for this platform.",
    ))
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
pub fn atomic_swap_apps(current: &Path, staged: &Path) -> Result<(), UpdateError> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt as _;

    const RENAME_SWAP: u32 = 0x0000_0002;
    unsafe extern "C" {
        fn renameatx_np(
            from_fd: i32,
            from: *const std::ffi::c_char,
            to_fd: i32,
            to: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }

    validate_swap_paths(current, staged)?;
    let current = CString::new(current.as_os_str().as_bytes()).map_err(|_| helper_error())?;
    let staged = CString::new(staged.as_os_str().as_bytes()).map_err(|_| helper_error())?;
    // SAFETY: both C strings are NUL-free absolute paths validated to be distinct sibling app
    // bundles. `AT_FDCWD` makes each path authoritative and `RENAME_SWAP` is one atomic APFS/HFS+
    // namespace operation; failure leaves both names unchanged.
    let result = unsafe {
        renameatx_np(
            libc_at_fdcwd(),
            current.as_ptr(),
            libc_at_fdcwd(),
            staged.as_ptr(),
            RENAME_SWAP,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(helper_error())
    }
}

#[cfg(target_os = "macos")]
const fn libc_at_fdcwd() -> i32 {
    -2
}

#[cfg(not(target_os = "macos"))]
pub fn atomic_swap_apps(_current: &Path, _staged: &Path) -> Result<(), UpdateError> {
    Err(UpdateError::new(
        "update_target_unsupported",
        "Automatic updates aren't available for this platform.",
    ))
}

pub fn validate_swap_paths(current: &Path, staged: &Path) -> Result<(), UpdateError> {
    let valid = current.is_absolute()
        && staged.is_absolute()
        && current != staged
        && current.parent().is_some()
        && current.parent() == staged.parent()
        && current.file_name().and_then(|name| name.to_str()) == Some("KalCode.app")
        && staged
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.starts_with(".KalCode-update-")
                    && name.ends_with(".app")
                    && name.len() <= 96
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
            });
    if valid { Ok(()) } else { Err(helper_error()) }
}

/// Removes only the hidden sibling bundle left behind by an already completed app swap.
/// Callers must first verify which version and signing identity the staged bundle contains.
pub fn remove_swapped_out_app(current: &Path, staged: &Path) -> Result<(), UpdateError> {
    validate_swap_paths(current, staged)?;
    for path in [current, staged] {
        let metadata = std::fs::symlink_metadata(path).map_err(|_| helper_error())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(helper_error());
        }
    }
    std::fs::remove_dir_all(staged).map_err(|_| helper_error())
}

/// Whether a staged app's `Info.plist` identifies the exact release `expected_version`.
///
/// `CFBundleShortVersionString` must equal the release version exactly. A build release
/// `X.Y.Z+N` (public version plus internal build number) must also carry `CFBundleVersion == N`,
/// which the release tooling stamps, so a bundle of another build is never accepted.
#[must_use]
pub fn bundle_version_matches(
    short_version: &str,
    bundle_version: &str,
    expected_version: &str,
) -> bool {
    if short_version != expected_version {
        return false;
    }
    match expected_version.split_once('+') {
        None => true,
        Some((public, build)) => {
            !public.is_empty()
                && !build.is_empty()
                && !build.starts_with('0')
                && build.bytes().all(|byte| byte.is_ascii_digit())
                && bundle_version == build
        }
    }
}

fn helper_error() -> UpdateError {
    UpdateError::new(
        "update_helper_failed",
        "KalCode couldn't safely apply the macOS update.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_paths_are_exact_distinct_sibling_app_bundles() {
        let root = std::env::current_dir().unwrap().join("Applications");
        let current = root.join("KalCode.app");
        let staged = root.join(".KalCode-update-abc123.app");
        validate_swap_paths(&current, &staged).unwrap();
        for invalid in [
            root.join("nested").join(".KalCode-update-abc123.app"),
            root.join("Other.app"),
            root.join(".KalCode-update-../x.app"),
        ] {
            assert!(validate_swap_paths(&current, &invalid).is_err());
        }
    }

    #[test]
    fn bundle_version_requires_the_exact_release_and_its_build_number() {
        assert!(bundle_version_matches("0.1.7", "0.1.7", "0.1.7"));
        assert!(bundle_version_matches("0.1.7+780", "780", "0.1.7+780"));

        assert!(!bundle_version_matches("0.1.7+780", "779", "0.1.7+780"));
        assert!(!bundle_version_matches("0.1.7", "780", "0.1.7+780"));
        assert!(!bundle_version_matches("0.1.6", "780", "0.1.7+780"));
        assert!(!bundle_version_matches("0.1.7+779", "780", "0.1.7+780"));
        assert!(!bundle_version_matches("+", "", "+"));
        assert!(!bundle_version_matches("0.1.7+0780", "0780", "0.1.7+0780"));
        assert!(!bundle_version_matches("0.1.7+x", "x", "0.1.7+x"));
    }

    #[test]
    fn swapped_out_app_removal_preserves_the_installed_app() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join("KalCode.app");
        let staged = temp.path().join(".KalCode-update-cleanup.app");
        std::fs::create_dir(&current).unwrap();
        std::fs::write(current.join("marker"), b"installed").unwrap();
        std::fs::create_dir_all(staged.join("Contents").join("MacOS")).unwrap();
        std::fs::write(
            staged.join("Contents").join("MacOS").join("marker"),
            b"superseded",
        )
        .unwrap();

        remove_swapped_out_app(&current, &staged).unwrap();

        assert_eq!(std::fs::read(current.join("marker")).unwrap(), b"installed");
        assert!(!staged.exists());
    }

    #[test]
    fn swapped_out_app_removal_rejects_unverified_path_shapes() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join("KalCode.app");
        let staged = temp.path().join(".KalCode-update-cleanup.app");
        std::fs::create_dir(&current).unwrap();
        std::fs::write(current.join("marker"), b"installed").unwrap();
        std::fs::write(&staged, b"not an app bundle").unwrap();

        assert!(remove_swapped_out_app(&current, &current).is_err());
        assert!(remove_swapped_out_app(&current, &staged).is_err());
        assert_eq!(std::fs::read(current.join("marker")).unwrap(), b"installed");
        assert_eq!(std::fs::read(&staged).unwrap(), b"not an app bundle");
    }

    #[cfg(unix)]
    #[test]
    fn swapped_out_app_removal_never_follows_a_replaced_bundle_link() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join("KalCode.app");
        let staged = temp.path().join(".KalCode-update-cleanup.app");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&current).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep"), b"outside").unwrap();
        symlink(&outside, &staged).unwrap();

        assert!(remove_swapped_out_app(&current, &staged).is_err());
        assert_eq!(std::fs::read(outside.join("keep")).unwrap(), b"outside");
        assert!(
            std::fs::symlink_metadata(&staged)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_swap_is_atomic_and_the_same_primitive_rolls_back() {
        let temp = tempfile::tempdir().unwrap();
        let current = temp.path().join("KalCode.app");
        let staged = temp.path().join(".KalCode-update-test.app");
        std::fs::create_dir(&current).unwrap();
        std::fs::write(current.join("marker"), b"old").unwrap();

        assert!(atomic_swap_apps(&current, &staged).is_err());
        assert_eq!(std::fs::read(current.join("marker")).unwrap(), b"old");
        assert!(!staged.exists());

        std::fs::create_dir(&staged).unwrap();
        std::fs::write(staged.join("marker"), b"new").unwrap();
        atomic_swap_apps(&current, &staged).unwrap();
        assert_eq!(std::fs::read(current.join("marker")).unwrap(), b"new");
        assert_eq!(std::fs::read(staged.join("marker")).unwrap(), b"old");

        atomic_swap_apps(&current, &staged).unwrap();
        assert_eq!(std::fs::read(current.join("marker")).unwrap(), b"old");
        assert_eq!(std::fs::read(staged.join("marker")).unwrap(), b"new");
    }
}
