//! Workspace roots, validated workspace-relative paths, and containment.
//!
//! A [`RelPath`] is the only path form that crosses into this crate from outside native code
//! (through a file handle, never directly from the WebView). It is `/`-separated, relative,
//! and free of anything that could change which file it names: no `.`/`..`, no empty
//! components, no drive letters, alternate data streams (`:`), backslashes, device or UNC
//! prefixes (`\\?\`, `\\.\`, `\\server`), control characters, Windows reserved device names,
//! trailing dots or spaces (which Windows silently strips), and never a `.git` component.
//!
//! Containment is decided on **canonical** paths (symlinks and junctions resolved) with a
//! component-wise prefix test, both when a handle is issued and again when it is used.

use std::path::{Component, Path, PathBuf};

use kalcode_contracts::ids::is_valid_id;
use kalcode_core::{ErrorCategory, KalError, Result};

/// Longest relative path accepted.
pub const MAX_REL_PATH: usize = 4096;
/// Longest single component accepted.
pub const MAX_COMPONENT: usize = 255;

fn outside(message: &'static str) -> KalError {
    KalError::new(ErrorCategory::Permission, "path_outside_workspace", message)
}

fn invalid(message: &'static str) -> KalError {
    KalError::validation("path_invalid", message)
}

/// A workspace's canonical root folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRoot {
    id: String,
    root: PathBuf,
}

impl WorkspaceRoot {
    /// `root` is resolved natively (from the workspace record, never from the WebView).
    pub fn new(workspace_id: &str, root: &Path) -> Result<Self> {
        if !is_valid_id(workspace_id) {
            return Err(KalError::validation(
                "invalid_id",
                "That workspace id isn't valid.",
            ));
        }
        let canonical = std::fs::canonicalize(root).map_err(|e| {
            KalError::new(
                ErrorCategory::Filesystem,
                "workspace_unavailable",
                "The workspace folder is missing or can't be opened.",
            )
            .with_source(e)
        })?;
        if !canonical.is_dir() {
            return Err(KalError::new(
                ErrorCategory::Filesystem,
                "workspace_unavailable",
                "The workspace folder is missing or can't be opened.",
            ));
        }
        Ok(Self {
            id: workspace_id.to_owned(),
            root: canonical,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// The canonical root.
    pub fn path(&self) -> &Path {
        &self.root
    }

    /// Resolves `rel` to a location inside the workspace, re-checking containment now
    /// (time-of-use). Existing paths are canonicalized; a missing path is accepted when its
    /// deepest existing ancestor is inside the root (a file deleted since it was listed).
    pub fn resolve(&self, rel: &RelPath) -> Result<Resolved> {
        let joined = rel.to_native(&self.root);
        match std::fs::symlink_metadata(&joined) {
            Ok(_) => {
                let canonical = std::fs::canonicalize(&joined)
                    .map_err(|_| outside("That file points outside the workspace."))?;
                self.check_inside(&canonical)?;
                Ok(Resolved {
                    path: canonical,
                    exists: true,
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut ancestor = joined.parent();
                while let Some(dir) = ancestor {
                    if std::fs::symlink_metadata(dir).is_ok() {
                        let canonical = std::fs::canonicalize(dir)
                            .map_err(|_| outside("That file points outside the workspace."))?;
                        self.check_inside(&canonical)?;
                        return Ok(Resolved {
                            path: joined,
                            exists: false,
                        });
                    }
                    ancestor = dir.parent();
                }
                Err(outside("That file is outside the workspace."))
            }
            Err(e) => Err(KalError::new(
                ErrorCategory::Filesystem,
                "file_unavailable",
                "KalCode couldn't read that file.",
            )
            .with_source(e)),
        }
    }

    /// True when the canonical `path` is the root or below it (component-wise, so `C:\ws2` is
    /// never inside `C:\ws`), and no component below the root is `.git`.
    pub fn contains(&self, canonical: &Path) -> bool {
        match canonical.strip_prefix(&self.root) {
            Ok(rest) => !rest.components().any(|c| is_git_dir_name(c.as_os_str())),
            Err(_) => false,
        }
    }

    /// Opens a workspace file for reading **and then** verifies the opened handle.
    ///
    /// Resolving a path and opening it afterwards is a check-then-use race: a symlink or
    /// junction swapped in between redirects the open outside the workspace. Here the open
    /// comes first; [`Self::verify_opened`] then asks the operating system where the opened
    /// handle really is and refuses it unless that is inside the workspace (and not in `.git`).
    /// A handle obtained through a swap — even one swapped back afterwards — points outside
    /// and is refused. Hard links are the same file by definition and pass: their content lives
    /// inside the workspace.
    ///
    /// Every read of workspace file content in this crate goes through here; consumers that
    /// read by handle use [`crate::handles::HandleRegistry::open`].
    pub fn open_verified(&self, rel: &RelPath) -> Result<OpenedFile> {
        let file = std::fs::File::open(rel.to_native(&self.root)).map_err(|e| {
            KalError::new(
                ErrorCategory::Filesystem,
                "file_unavailable",
                "KalCode couldn't read that file.",
            )
            .with_source(e)
        })?;
        let path = self.verify_opened(rel, &file)?;
        if !file.metadata().is_ok_and(|m| m.is_file()) {
            return Err(KalError::validation(
                "path_not_a_file",
                "That isn't a file KalCode can read.",
            ));
        }
        Ok(OpenedFile { file, path })
    }

    /// Verifies an already opened `file` (opened through `rel`): its final path — asked of the
    /// opened handle itself (`GetFinalPathNameByHandleW` on Windows, `/proc/self/fd` on Linux;
    /// elsewhere the handle's device + inode must equal those of `rel`'s canonical path now) —
    /// must be inside the workspace. Returns that path.
    pub fn verify_opened(&self, rel: &RelPath, file: &std::fs::File) -> Result<PathBuf> {
        let swapped = || outside("That file changed while KalCode was opening it.");
        let path = opened_path(file, || {
            self.resolve(rel).ok().filter(|r| r.exists).map(|r| r.path)
        })
        .ok_or_else(swapped)?;
        self.check_inside(&path)?;
        Ok(path)
    }

    fn check_inside(&self, canonical: &Path) -> Result<()> {
        if self.contains(canonical) {
            Ok(())
        } else {
            Err(outside("That file is outside the workspace."))
        }
    }

    /// The workspace-relative form of an absolute path (watcher events), if it is inside.
    /// Lexical only; callers resolve the result again before touching the file.
    pub fn relativize(&self, absolute: &Path) -> Option<RelPath> {
        let plain_root = plain(&self.root);
        let rest = absolute
            .strip_prefix(&self.root)
            .or_else(|_| absolute.strip_prefix(&plain_root))
            .ok()?;
        let mut parts = Vec::new();
        for component in rest.components() {
            match component {
                Component::Normal(part) => parts.push(part.to_str()?.to_owned()),
                _ => return None,
            }
        }
        RelPath::parse(&parts.join("/")).ok()
    }
}

/// The ordinary form of a canonical path, for handing to git: Windows canonical paths carry
/// the verbatim prefix (`\\?\C:\…`, `\\?\UNC\server\share\…`), which Git for Windows doesn't
/// accept everywhere (`--git-dir`). Other paths are returned unchanged.
pub fn plain(path: &Path) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path.to_path_buf();
    };
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\")
        && rest.as_bytes().get(1) == Some(&b':')
    {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

fn is_git_dir_name(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_some_and(|n| {
        let trimmed = n.trim_end_matches(['.', ' ']);
        trimmed.eq_ignore_ascii_case(".git")
    })
}

/// A workspace file opened by [`WorkspaceRoot::open_verified`].
#[derive(Debug)]
pub struct OpenedFile {
    pub file: std::fs::File,
    /// The canonical path the opened handle was verified against.
    pub path: PathBuf,
}

/// The final path of an opened handle, asked of the operating system. `canonical_now` is only
/// used where no such query exists: the handle is accepted as `canonical_now()` when both name
/// the same device + inode.
#[cfg(windows)]
fn opened_path(
    file: &std::fs::File,
    _canonical_now: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    final_path_by_handle(file).ok()
}

#[cfg(target_os = "linux")]
fn opened_path(
    file: &std::fs::File,
    _canonical_now: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn opened_path(
    file: &std::fs::File,
    canonical_now: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    let path = canonical_now()?;
    let expected = same_file::Handle::from_path(&path).ok()?;
    let actual = same_file::Handle::from_file(file.try_clone().ok()?).ok()?;
    (expected == actual).then_some(path)
}

/// `GetFinalPathNameByHandleW` (normalized, DOS volume name — the same form
/// `std::fs::canonicalize` returns, `\\?\C:\…`).
#[cfg(windows)]
#[allow(unsafe_code)]
fn final_path_by_handle(file: &std::fs::File) -> std::io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW, VOLUME_NAME_DOS,
    };
    let handle = file.as_raw_handle();
    let mut buffer = vec![0u16; 512];
    loop {
        let capacity = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        // SAFETY: `handle` is the live handle owned by `file`, borrowed for the duration of the
        // call; `buffer` is writable for `capacity` UTF-16 units and the API writes at most that
        // many (it returns the required size instead when the buffer is too small).
        let written = unsafe {
            GetFinalPathNameByHandleW(
                handle,
                buffer.as_mut_ptr(),
                capacity,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if written == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if written < buffer.len() {
            buffer.truncate(written);
            return Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer)));
        }
        if written > 32 * 1024 + 1 {
            return Err(std::io::Error::other("final path too long"));
        }
        buffer.resize(written + 1, 0);
    }
}

/// Where `path` is, as far as the filesystem can tell today: the nearest existing ancestor is
/// canonicalized (links, junctions, 8.3 names and letter case resolved) and the missing rest is
/// appended lexically (`.` dropped, `..` popped). Used for locations that may not exist yet.
pub fn resolve_nearest(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut rest: Vec<Component<'_>> = Vec::new();
    let mut current: &Path = &absolute;
    loop {
        if let Ok(canonical) = std::fs::canonicalize(current) {
            let mut out = canonical;
            for component in rest.iter().rev() {
                match component {
                    Component::CurDir => {}
                    Component::ParentDir => {
                        out.pop();
                    }
                    other => out.push(other.as_os_str()),
                }
            }
            return out;
        }
        match (current.parent(), current.components().next_back()) {
            (Some(parent), Some(last)) => {
                rest.push(last);
                current = parent;
            }
            _ => return lexical(&absolute),
        }
    }
}

/// `.` dropped and `..` popped without touching the filesystem.
pub fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Component-wise "`path` is `ancestor` or below it", after removing Windows verbatim
/// prefixes; letter case is ignored on Windows (NTFS folders are case-insensitive).
pub fn is_within(path: &Path, ancestor: &Path) -> bool {
    let path = plain(path);
    let ancestor = plain(ancestor);
    let mut inner = path.components();
    for want in ancestor.components() {
        let Some(have) = inner.next() else {
            return false;
        };
        let same = if cfg!(windows) {
            have.as_os_str().to_string_lossy().to_lowercase()
                == want.as_os_str().to_string_lossy().to_lowercase()
        } else {
            have == want
        };
        if !same {
            return false;
        }
    }
    true
}

/// A location inside a workspace, checked at the time it was resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    /// Canonical path when `exists`, otherwise the lexical path under the canonical root.
    pub path: PathBuf,
    pub exists: bool,
}

/// A validated, `/`-separated, workspace-relative path. See the module docs for the rules.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RelPath(String);

impl RelPath {
    /// Validates with the rules of the platform KalCode runs on.
    pub fn parse(raw: &str) -> Result<Self> {
        Self::parse_for(raw, cfg!(windows))
    }

    /// Validates with Windows rules (`windows = true`) or POSIX rules. Windows rules are a
    /// superset; both reject anything that could escape the workspace.
    pub fn parse_for(raw: &str, windows: bool) -> Result<Self> {
        if raw.is_empty() {
            return Err(invalid("The path is empty."));
        }
        if raw.len() > MAX_REL_PATH {
            return Err(invalid("The path is too long."));
        }
        if raw.starts_with('/') || raw.starts_with('\\') {
            return Err(outside("Absolute paths aren't accepted."));
        }
        if raw.contains('\\') {
            return Err(invalid("The path uses backslashes."));
        }
        if raw.chars().any(|c| c.is_control() || is_invisible(c)) {
            return Err(invalid(
                "The path contains control or invisible characters.",
            ));
        }
        for component in raw.split('/') {
            validate_component(component, windows)?;
        }
        Ok(Self(raw.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn components(&self) -> impl Iterator<Item = &str> {
        self.0.split('/')
    }

    pub fn file_name(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or(&self.0)
    }

    /// The containing directory, or `None` for a top-level entry.
    pub fn parent(&self) -> Option<RelPath> {
        self.0
            .rsplit_once('/')
            .map(|(parent, _)| RelPath(parent.to_owned()))
    }

    /// `self/name`, validated.
    pub fn join(&self, name: &str) -> Result<RelPath> {
        RelPath::parse(&format!("{}/{name}", self.0))
    }

    /// True when `self` is `ancestor` or below it.
    pub fn starts_with(&self, ancestor: &RelPath) -> bool {
        self.0 == ancestor.0
            || (self.0.starts_with(&ancestor.0)
                && self.0.as_bytes().get(ancestor.0.len()) == Some(&b'/'))
    }

    /// The native path under `root`.
    pub fn to_native(&self, root: &Path) -> PathBuf {
        let mut path = root.to_path_buf();
        for component in self.components() {
            path.push(component);
        }
        path
    }
}

impl std::fmt::Display for RelPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
    )
}

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "COM1", "COM2", "COM3", "COM4", "COM5",
    "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5",
    "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
];

fn validate_component(component: &str, windows: bool) -> Result<()> {
    if component.is_empty() {
        return Err(invalid("The path has an empty part."));
    }
    if component == "." || component == ".." {
        return Err(outside("Paths with `.` or `..` aren't accepted."));
    }
    if component.len() > MAX_COMPONENT {
        return Err(invalid("A part of the path is too long."));
    }
    if component.eq_ignore_ascii_case(".git") {
        return Err(KalError::new(
            ErrorCategory::Permission,
            "path_git_internal",
            "Git's internal folder isn't accessible through KalCode's file views.",
        ));
    }
    if windows {
        if component.contains(':') {
            return Err(invalid("The path contains a drive or stream separator."));
        }
        if component
            .chars()
            .any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
        {
            return Err(invalid(
                "The path contains characters Windows doesn't allow.",
            ));
        }
        if component.ends_with('.') || component.ends_with(' ') {
            // Windows strips these, so `x.` would silently name `x` (and `.git.` names `.git`).
            return Err(invalid("The path ends a part with a dot or a space."));
        }
        let stem = component.split('.').next().unwrap_or(component).trim_end();
        if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
            return Err(invalid("The path names a Windows device."));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ordinary_relative_paths_on_both_platforms() {
        for windows in [false, true] {
            for ok in [
                "a.txt",
                "src/lib.rs",
                "deep/nested/dir/file.tar.gz",
                ".gitignore",
                "日本/語.md",
            ] {
                assert!(
                    RelPath::parse_for(ok, windows).is_ok(),
                    "{ok} windows={windows}"
                );
            }
        }
    }

    #[test]
    fn rejects_escapes_on_both_platforms() {
        for windows in [false, true] {
            for bad in [
                "",
                "..",
                "../x",
                "a/../../x",
                "a/./b",
                "/etc/passwd",
                "\\\\server\\share\\x",
                "\\\\?\\C:\\Windows",
                "\\\\.\\PhysicalDrive0",
                "a\\..\\..\\x",
                "a//b",
                "a/",
                ".git/config",
                "sub/.GIT/hooks/pre-commit",
                "a\u{0000}b",
                "a\u{202E}b",
            ] {
                assert!(
                    RelPath::parse_for(bad, windows).is_err(),
                    "{bad:?} windows={windows}"
                );
            }
        }
    }

    #[test]
    fn windows_rules_reject_device_names_streams_and_trailing_dots() {
        for bad in [
            "C:/Windows/win.ini",
            "C:x",
            "file.txt:secret",
            "CON",
            "sub/nul.txt",
            "Com1.log",
            "lpt9",
            "x.",
            "x ",
            ".git.",
            "a*b",
        ] {
            assert!(RelPath::parse_for(bad, true).is_err(), "{bad:?}");
        }
        // The same names are ordinary files on POSIX (except `.git` components).
        for ok in ["CON", "sub/nul.txt", "x.", "file.txt:secret"] {
            assert!(RelPath::parse_for(ok, false).is_ok(), "{ok:?}");
        }
    }

    #[test]
    fn plain_strips_windows_verbatim_prefixes_only() {
        assert_eq!(plain(Path::new(r"\\?\C:\ws\x")), PathBuf::from(r"C:\ws\x"));
        assert_eq!(
            plain(Path::new(r"\\?\UNC\server\share\ws")),
            PathBuf::from(r"\\server\share\ws")
        );
        assert_eq!(plain(Path::new("/home/u/ws")), PathBuf::from("/home/u/ws"));
        assert_eq!(
            plain(Path::new(r"\\?\GLOBALROOT\x")),
            PathBuf::from(r"\\?\GLOBALROOT\x")
        );
    }

    #[test]
    fn prefix_test_is_component_wise() {
        let a = RelPath::parse_for("src", false).expect("src");
        assert!(
            RelPath::parse_for("src/x", false)
                .expect("x")
                .starts_with(&a)
        );
        assert!(RelPath::parse_for("src", false).expect("x").starts_with(&a));
        assert!(
            !RelPath::parse_for("src2/x", false)
                .expect("x")
                .starts_with(&a)
        );
    }

    #[test]
    fn workspace_containment_is_component_wise_and_blocks_git_dir() {
        let base = tempfile::tempdir().expect("tempdir");
        let ws = base.path().join("ws");
        let ws2 = base.path().join("ws2");
        std::fs::create_dir_all(ws.join(".git")).expect("mkdir");
        std::fs::create_dir_all(&ws2).expect("mkdir");
        let root = WorkspaceRoot::new(&kalcode_contracts::ids::new_id(), &ws).expect("root");
        let ws2 = std::fs::canonicalize(ws2).expect("canon");
        assert!(!root.contains(&ws2));
        assert!(root.contains(root.path()));
        assert!(!root.contains(&root.path().join(".git").join("config")));
    }
}
