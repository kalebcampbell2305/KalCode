//! Workspace text reads for the Diff Tool, by file handle (ADVANCED.md §3 D4): the WebView only
//! names files native listings issued; the desktop shell opens them with the handle registry's
//! open-then-verify and passes the opened file here.

use std::io::Read;

use kalcode_contracts::refs::FileRef;
use kalcode_core::{ErrorCategory, KalError, Result};

use crate::types::TextFile;

/// Largest text read for a diff side.
pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
/// Files searched per query.
pub const MAX_FIND: usize = 50;

/// SQLite databases by file name.
pub fn is_sqlite_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".db", ".sqlite", ".sqlite3", ".db3", ".s3db", ".sl3"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// Reads up to [`MAX_TEXT_BYTES`] of an opened file as UTF-8 text. Binary files (a NUL byte in
/// the first 8 KiB, or invalid UTF-8) are refused.
pub fn read_text(mut file: std::fs::File, file_ref: FileRef) -> Result<TextFile> {
    let bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut buffer = Vec::new();
    (&mut file)
        .take(MAX_TEXT_BYTES as u64 + 1)
        .read_to_end(&mut buffer)
        .map_err(|e| {
            KalError::new(
                ErrorCategory::Filesystem,
                "file_read_failed",
                "KalCode couldn't read that file.",
            )
            .with_source(e)
        })?;
    let truncated = buffer.len() > MAX_TEXT_BYTES;
    if truncated {
        buffer.truncate(MAX_TEXT_BYTES);
        // Don't cut a character in half.
        while !buffer.is_empty() && std::str::from_utf8(&buffer).is_err() {
            buffer.pop();
        }
    }
    if buffer.iter().take(8192).any(|b| *b == 0) {
        return Err(binary());
    }
    let text = String::from_utf8(buffer).map_err(|_| binary())?;
    Ok(TextFile {
        file: file_ref,
        text,
        bytes,
        truncated,
    })
}

fn binary() -> KalError {
    KalError::validation(
        "file_not_text",
        "That file isn't text (it looks binary), so it can't be compared line by line.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::refs::FileHandle;

    fn file_ref() -> FileRef {
        FileRef {
            handle: FileHandle {
                id: "00000000-0000-7000-8000-000000000000".into(),
            },
            workspace_id: "ws".into(),
            display_path: "a.txt".into(),
        }
    }

    #[test]
    fn text_is_read_and_binary_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let text = dir.path().join("a.txt");
        std::fs::write(&text, "one\ntwo\n").expect("write");
        let read = read_text(std::fs::File::open(&text).expect("open"), file_ref()).expect("read");
        assert_eq!(read.text, "one\ntwo\n");
        assert!(!read.truncated);
        let bin = dir.path().join("b.bin");
        std::fs::write(&bin, [0u8, 1, 2]).expect("write");
        assert_eq!(
            read_text(std::fs::File::open(&bin).expect("open"), file_ref()).map_err(|e| e.code),
            Err("file_not_text")
        );
        let big = dir.path().join("big.txt");
        std::fs::write(&big, "é".repeat(MAX_TEXT_BYTES)).expect("write");
        let read = read_text(std::fs::File::open(&big).expect("open"), file_ref()).expect("read");
        assert!(read.truncated);
        assert!(read.text.len() <= MAX_TEXT_BYTES);
    }

    #[test]
    fn sqlite_names() {
        for name in ["app.db", "DATA.SQLITE", "x.sqlite3", "y.db3"] {
            assert!(is_sqlite_name(name), "{name}");
        }
        for name in ["db.json", "notes.txt", "dbx"] {
            assert!(!is_sqlite_name(name), "{name}");
        }
    }
}
