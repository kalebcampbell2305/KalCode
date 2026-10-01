//! Race-resistant reads and opens for app-owned handoff files.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::Path;

/// Opens an ordinary file without following a final symlink or Windows reparse point.
///
/// The caller must still verify the opened handle against its containing authority when parent
/// directories can be replaced. [`read_bounded_ordinary_file`] performs that complete check for
/// a canonical app-owned path.
pub fn open_ordinary_file_without_following(path: &Path) -> Option<File> {
    let before = std::fs::symlink_metadata(path).ok()?;
    if !before.is_file() || is_link_or_reparse(&before) {
        return None;
    }
    let file = open_without_following(path).ok()?;
    let opened = file.metadata().ok()?;
    (opened.is_file() && !is_link_or_reparse(&opened)).then_some(file)
}

/// Reads at most `cap` bytes only when the no-follow opened handle is still the exact ordinary
/// file at the canonical `expected` path. Parent-link swaps and final links fail closed.
pub fn read_bounded_ordinary_file(path: &Path, expected: &Path, cap: u64) -> Option<Vec<u8>> {
    let before = std::fs::symlink_metadata(path).ok()?;
    if before.len() > cap {
        return None;
    }
    let file = open_ordinary_file_without_following(path)?;
    let opened_metadata = file.metadata().ok()?;
    let opened_len = opened_metadata.len();
    if opened_len > cap {
        return None;
    }
    let opened = same_file::Handle::from_file(file).ok()?;
    if std::fs::canonicalize(expected).ok()? != expected
        || same_file::Handle::from_path(expected).ok()? != opened
    {
        return None;
    }
    let mut bytes = Vec::new();
    opened
        .as_file()
        .take(cap.saturating_add(1))
        .read_to_end(&mut bytes)
        .ok()?;
    let after = opened.as_file().metadata().ok()?;
    (u64::try_from(bytes.len()).ok()? == opened_len
        && after.is_file()
        && !is_link_or_reparse(&after)
        && after.len() == opened_len)
        .then_some(bytes)
}

/// Consumes one Operations artifact report by moving it between its two fixed app-owned names,
/// verifying that the moved object is the same opened ordinary file, and then removing it.
///
/// Calling this with the names reversed recovers the only crash window: a report left at the
/// `.consumed` name after the first rename. No caller-controlled directory or filename is used.
pub fn consume_operation_artifact_report_file(path: &Path, quarantine: &Path) -> bool {
    if std::fs::symlink_metadata(quarantine).is_ok() {
        return false;
    }
    let Some(original) = open_ordinary_file_without_following(path) else {
        return false;
    };
    let Ok(original) = same_file::Handle::from_file(original) else {
        return false;
    };
    if std::fs::rename(path, quarantine).is_err() {
        return false;
    }
    let same = open_ordinary_file_without_following(quarantine)
        .and_then(|file| same_file::Handle::from_file(file).ok())
        .is_some_and(|moved| moved == original);
    if !same {
        let _ = std::fs::rename(quarantine, path);
        return false;
    }
    std::fs::remove_file(quarantine).is_ok()
}

#[cfg(windows)]
fn open_without_following(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt as _;

    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(unix)]
fn open_without_following(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt as _;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

#[cfg(windows)]
pub fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
pub fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn bounded_reader_accepts_exact_file_and_rejects_cap_overflow() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("report.json");
        std::fs::write(&path, b"1234").expect("write");
        let expected = std::fs::canonicalize(&path).expect("canonical");
        assert_eq!(
            read_bounded_ordinary_file(&path, &expected, 4).as_deref(),
            Some(b"1234".as_slice())
        );
        assert!(read_bounded_ordinary_file(&path, &expected, 3).is_none());
    }

    #[test]
    fn bounded_reader_rejects_a_final_link_when_supported() {
        let dir = tempfile::tempdir().expect("temp");
        let target = dir.path().join("target.json");
        let alias = dir.path().join("alias.json");
        std::fs::write(&target, b"{}").expect("write");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&target, &alias).is_ok();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&target, &alias).is_ok();
        if linked {
            let expected = std::fs::canonicalize(&target).expect("canonical");
            assert!(read_bounded_ordinary_file(&alias, &expected, 16).is_none());
            assert!(open_ordinary_file_without_following(&alias).is_none());
        }
    }

    #[test]
    fn operation_report_consumer_recovers_from_consumed_name() {
        let dir = tempfile::tempdir().expect("temp");
        let report = dir.path().join("run.json");
        let consumed = dir.path().join("run.json.consumed");
        std::fs::write(&consumed, b"{}").expect("seed crash state");

        assert!(consume_operation_artifact_report_file(&consumed, &report));
        assert!(!report.exists());
        assert!(!consumed.exists());
    }
}
