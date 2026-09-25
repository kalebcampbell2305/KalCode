//! Canonical workspace containment for items that name a path.
//!
//! The approach follows the Z4 permission engine's `paths` module (branch `z4/permissions`)
//! without depending on it: a path is **inside** the workspace only when every interpretation
//! lands inside the canonical root —
//!
//! * `..` applied lexically first (Win32 semantics), then links resolved;
//! * links and junctions resolved component by component, with `..` applied to the real parent
//!   (POSIX kernel semantics).
//!
//! Anything that cannot be interpreted safely is refused rather than guessed: device and UNC
//! paths, alternate data streams (`file:stream`, `::$DATA`), environment expansion, reserved
//! device names, names ending in a dot or a space (Windows silently strips them, so `.env.`
//! opens `.env`), control and invisible characters, unverifiable 8.3 short names, and a missing
//! workspace root. Unlike the permission engine, trailing dots and spaces are refused on every
//! platform: a context package must mean the same thing wherever KalCode runs.
//!
//! Never-share rules are matched against the **canonical** relative path returned here (the
//! on-disk name after links, junctions and short names are resolved), folded by
//! [`normalize_for_match`] — so `.ENV`, `ENV~1`, a junction to `.env`, and a full-width `．env`
//! all hit the `.env` rule.

use std::path::{Component, Path, PathBuf};

/// Longest path string KalCode will interpret.
pub const MAX_PATH_LEN: usize = 4096;

/// A workspace root, canonicalized once. A root that does not exist yields a workspace in which
/// every path is outside (fail closed).
#[derive(Debug, Clone, Default)]
pub struct WorkspaceRoot {
    root: Option<PathBuf>,
}

impl WorkspaceRoot {
    pub fn new(root: &Path) -> Self {
        Self {
            root: std::fs::canonicalize(root).ok(),
        }
    }

    /// A workspace with no usable root: nothing is inside.
    pub fn none() -> Self {
        Self { root: None }
    }

    /// The canonical root (verbatim `\\?\` form on Windows).
    pub fn path(&self) -> Option<&Path> {
        self.root.as_deref()
    }
}

/// Result of resolving a path against the workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathCheck {
    Inside {
        /// Canonical absolute path (links resolved).
        real: PathBuf,
        /// Canonical workspace-relative path with `/` separators; `""` for the root itself.
        relative: String,
    },
    Outside {
        reason: &'static str,
    },
    Unsafe {
        reason: &'static str,
    },
}

impl PathCheck {
    pub fn relative(&self) -> Option<&str> {
        match self {
            Self::Inside { relative, .. } => Some(relative),
            _ => None,
        }
    }
}

/// Resolves `raw` (workspace-relative, or absolute) against `workspace`.
pub fn resolve(workspace: &WorkspaceRoot, raw: &str) -> PathCheck {
    resolve_inner(workspace, raw, false)
}

fn resolve_inner(workspace: &WorkspaceRoot, raw: &str, native: bool) -> PathCheck {
    if let Some(reason) = unsafe_text(raw, native) {
        return reason;
    }
    let trimmed = raw;

    let unified = trimmed.replace('/', "\\");
    if let Some(rest) = unified
        .strip_prefix(r"\\?\")
        .or_else(|| unified.strip_prefix(r"\??\"))
    {
        if rest.to_ascii_uppercase().starts_with(r"UNC\") {
            return PathCheck::Outside {
                reason: "The path is a network share.",
            };
        }
        if cfg!(windows) && is_drive_absolute(rest) && unified.starts_with(r"\\?\") {
            // A verbatim drive path (`\\?\C:\…`) is the same location as `C:\…`.
            return resolve_inner(workspace, rest, native);
        }
        return PathCheck::Unsafe {
            reason: "The path uses a device namespace.",
        };
    }
    if unified.starts_with(r"\\.\") {
        return PathCheck::Unsafe {
            reason: "The path names a device.",
        };
    }
    if unified.starts_with(r"\\") {
        return PathCheck::Outside {
            reason: "The path is a network share.",
        };
    }

    let components = split_components(trimmed);
    for (index, component) in components.iter().enumerate() {
        if let Some(reason) = unsafe_component(component, index == 0) {
            return reason;
        }
    }

    let Some(root) = workspace.path() else {
        return PathCheck::Outside {
            reason: "The workspace folder couldn't be verified, so every path is treated as outside it.",
        };
    };

    let native_text = if cfg!(windows) {
        trimmed.replace('/', "\\")
    } else {
        trimmed.to_owned()
    };
    let first = components.first().copied().unwrap_or_default();
    let absolute = if is_drive_spec(first) && !is_drive_absolute(trimmed) {
        return PathCheck::Outside {
            reason: "The path is relative to another drive.",
        };
    } else if is_drive_absolute(trimmed) {
        if !cfg!(windows) {
            return PathCheck::Outside {
                reason: "The path is a Windows drive path.",
            };
        }
        PathBuf::from(&native_text)
    } else if trimmed.starts_with('/') || (cfg!(windows) && trimmed.starts_with('\\')) {
        if cfg!(windows) {
            return PathCheck::Outside {
                reason: "The path has no drive letter.",
            };
        }
        PathBuf::from(&native_text)
    } else {
        non_verbatim(root).join(&native_text)
    };
    check_absolute(root, &absolute)
}

/// Resolves an absolute path produced by native code (for example a directory-walk result).
/// Applies the same containment checks as [`resolve`], except that `$`, `%` and `~` are taken
/// literally: a real on-disk name such as `Foo$Bar.java` involves no expansion.
pub fn resolve_path(workspace: &WorkspaceRoot, path: &Path) -> PathCheck {
    match path.to_str() {
        Some(text) => resolve_inner(workspace, text, true),
        None => PathCheck::Unsafe {
            reason: "The path isn't valid Unicode.",
        },
    }
}

fn check_absolute(root: &Path, absolute: &Path) -> PathCheck {
    let kernel = real_path_from(root, absolute);
    // Without `..` the lexical and kernel interpretations are the same walk.
    let lexical = if absolute
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        real_path_from(root, &lexical_normalize(absolute))
    } else {
        kernel.clone()
    };
    let (Some(lexical), Some(kernel)) = (lexical, kernel) else {
        return PathCheck::Outside {
            reason: "The path couldn't be resolved (for example a broken link), so it is treated as outside the workspace.",
        };
    };
    if !(lexical.starts_with(root) && kernel.starts_with(root)) {
        return PathCheck::Outside {
            reason: "The path resolves outside the workspace.",
        };
    }
    let relative = kernel
        .strip_prefix(root)
        .map(|rest| {
            rest.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default();
    // A short (8.3) name in a part that does not exist cannot be expanded, so it cannot be
    // matched against never-share rules.
    if relative.split('/').any(is_short_name) && std::fs::symlink_metadata(&kernel).is_err() {
        return PathCheck::Unsafe {
            reason: "The path uses a short (8.3) file name KalCode can't verify.",
        };
    }
    // Re-check the canonical names: a link may point at a name that is itself unsafe.
    for component in relative.split('/').filter(|c| !c.is_empty()) {
        if let Some(reason) = unsafe_component(component, false) {
            return reason;
        }
    }
    PathCheck::Inside {
        real: kernel,
        relative,
    }
}

/// Text-level refusals shared by [`resolve`] and relative-path matching.
fn unsafe_text(raw: &str, native: bool) -> Option<PathCheck> {
    if raw.trim().is_empty() {
        return Some(PathCheck::Unsafe {
            reason: "The path is empty.",
        });
    }
    if raw != raw.trim() {
        return Some(PathCheck::Unsafe {
            reason: "The path starts or ends with a space.",
        });
    }
    if raw.len() > MAX_PATH_LEN {
        return Some(PathCheck::Unsafe {
            reason: "The path is too long to check.",
        });
    }
    if raw.chars().any(is_suspicious_char) {
        return Some(PathCheck::Unsafe {
            reason: "The path contains control or invisible characters.",
        });
    }
    if !native && has_expansion(raw) {
        return Some(PathCheck::Outside {
            reason: "The path depends on environment variables or the home folder.",
        });
    }
    None
}

fn unsafe_component(component: &str, first: bool) -> Option<PathCheck> {
    let is_drive = first && is_drive_spec(component);
    if !is_drive && component.contains(':') {
        return Some(PathCheck::Unsafe {
            reason: "The path names an alternate data stream or a drive in the wrong place.",
        });
    }
    if is_reserved_device_name(component) {
        return Some(PathCheck::Unsafe {
            reason: "The path names a reserved device.",
        });
    }
    if component != "."
        && component != ".."
        && (component.ends_with('.') || component.ends_with(' '))
    {
        return Some(PathCheck::Unsafe {
            reason: "The path has a name ending in a dot or space, which Windows rewrites.",
        });
    }
    None
}

/// Checks a workspace-relative path **textually** (no filesystem access): used for paths that
/// appear inside content, such as the file headers of a diff. Returns the reason when the path
/// is unsafe or escapes the workspace.
pub fn check_relative_text(raw: &str) -> Result<String, &'static str> {
    if let Some(check) = unsafe_text(raw, false) {
        return Err(match check {
            PathCheck::Unsafe { reason } | PathCheck::Outside { reason } => reason,
            PathCheck::Inside { .. } => "The path can't be checked.",
        });
    }
    let components = split_components(raw);
    let mut depth = 0usize;
    let mut out: Vec<&str> = Vec::new();
    for (index, component) in components.iter().enumerate() {
        if let Some(PathCheck::Unsafe { reason } | PathCheck::Outside { reason }) =
            unsafe_component(component, index == 0)
        {
            return Err(reason);
        }
        if index == 0 && (is_drive_spec(component) || raw.starts_with(['/', '\\'])) {
            return Err("The path is absolute.");
        }
        match *component {
            "." => {}
            ".." => {
                if depth == 0 {
                    return Err("The path leaves the workspace.");
                }
                depth -= 1;
                out.pop();
            }
            name => {
                depth += 1;
                out.push(name);
            }
        }
    }
    Ok(out.join("/"))
}

/// Folds a workspace-relative path for rule matching: `/` separators, lowercase, and common
/// ASCII look-alikes (full-width forms, one-dot leaders, small full stops) mapped to ASCII, so a
/// file named `．ＥＮＶ` meets the `.env` rule. Folding can only add matches (deny wins).
pub fn normalize_for_match(relative: &str) -> String {
    let mut out = String::with_capacity(relative.len());
    for c in relative.chars() {
        let folded = match c {
            '\\' => '/',
            // Full-width ASCII block.
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            '\u{2024}' | '\u{FE52}' | '\u{FF61}' | '\u{3002}' => '.',
            '\u{2010}'..='\u{2015}' | '\u{2212}' | '\u{FE63}' => '-',
            '\u{FE4D}'..='\u{FE4F}' => '_',
            other => other,
        };
        for lower in folded.to_lowercase() {
            out.push(lower);
        }
    }
    out
}

/// `\\?\C:\x` → `C:\x`; anything else unchanged.
fn non_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if is_drive_absolute(rest) => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

pub(crate) fn is_suspicious_char(c: char) -> bool {
    (c.is_control() && c != '\t')
        || matches!(
            c,
            '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
                | '\u{00AD}'
        )
}

/// `~`, `$VAR`, `${…}`, `$(…)`, `%VAR%` and backticks make the real path depend on the
/// environment.
pub fn has_expansion(text: &str) -> bool {
    text.starts_with('~') || text.contains('$') || text.contains('`') || has_percent_var(text)
}

fn has_percent_var(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
                j += 1;
            }
            if j > start && j < bytes.len() && bytes[j] == b'%' {
                return true;
            }
            i = j.max(start);
        } else {
            i += 1;
        }
    }
    false
}

fn split_components(path: &str) -> Vec<&str> {
    path.split(['/', '\\']).filter(|c| !c.is_empty()).collect()
}

fn is_drive_spec(component: &str) -> bool {
    let b = component.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

fn is_drive_absolute(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// `CON`, `NUL`, `COM1.txt`, … name devices on Windows regardless of directory or extension.
fn is_reserved_device_name(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_lowercase();
    matches!(
        stem.as_str(),
        "con" | "prn" | "aux" | "nul" | "conin$" | "conout$" | "clock$"
    ) || ((stem.starts_with("com") || stem.starts_with("lpt"))
        && stem.chars().count() == 4
        && stem
            .chars()
            .nth(3)
            .is_some_and(|c| c.is_ascii_digit() || matches!(c, '¹' | '²' | '³')))
}

fn is_short_name(component: &str) -> bool {
    component
        .find('~')
        .is_some_and(|i| component[i + 1..].starts_with(|c: char| c.is_ascii_digit()))
}

/// Removes `.` and applies `..` textually, never above the root/prefix.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    let mut depth = 0usize;
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if depth > 0 {
                    out.pop();
                    depth -= 1;
                }
            }
            Component::Normal(name) => {
                out.push(name);
                depth += 1;
            }
        }
    }
    out
}

/// [`real_path`], starting at the canonical `root` when `path` lies under the root's plain form
/// (the common case: a workspace-relative path joined onto the root). Only the components below
/// the root are walked: each one that is a link or junction is resolved as it is met (so `..`
/// applies to the real parent), and the longest existing prefix is canonicalized once at the end
/// (case, short names). Equivalent to [`real_path`] for such paths, with far fewer system calls.
fn real_path_from(root: &Path, path: &Path) -> Option<PathBuf> {
    let plain = non_verbatim(root);
    let rest = path
        .strip_prefix(&plain)
        .or_else(|_| path.strip_prefix(root))
        .ok();
    let Some(rest) = rest else {
        return real_path(path);
    };
    let mut current = root.to_path_buf();
    for component in rest.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                current.pop();
            }
            Component::Normal(name) => {
                current.push(name);
                if let Ok(meta) = std::fs::symlink_metadata(&current)
                    && meta.file_type().is_symlink()
                {
                    current = std::fs::canonicalize(&current).ok()?;
                }
            }
            Component::Prefix(_) | Component::RootDir => return real_path(path),
        }
    }
    canonicalize_existing_prefix(&current)
}

/// Canonicalizes the longest existing prefix of `path` and re-appends the rest as written.
fn canonicalize_existing_prefix(path: &Path) -> Option<PathBuf> {
    let mut existing = path.to_path_buf();
    let mut tail = Vec::new();
    while std::fs::symlink_metadata(&existing).is_err() {
        tail.push(existing.file_name()?.to_os_string());
        if !existing.pop() {
            return None;
        }
    }
    let mut out = std::fs::canonicalize(&existing).ok()?;
    for name in tail.into_iter().rev() {
        out.push(name);
    }
    Some(out)
}

/// Resolves links component by component: each existing prefix is canonicalized (following
/// symlinks and junctions), `..` moves to the real parent, and components that do not exist
/// are appended as written. A link that cannot be resolved yields `None`.
fn real_path(path: &Path) -> Option<PathBuf> {
    let mut current = PathBuf::new();
    let mut anchored = false;
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !anchored {
                    current = std::fs::canonicalize(&current).ok()?;
                    anchored = true;
                }
                current.pop();
            }
            Component::Normal(name) => {
                if !anchored {
                    current = std::fs::canonicalize(&current).ok()?;
                    anchored = true;
                }
                current.push(name);
                if std::fs::symlink_metadata(&current).is_ok() {
                    current = std::fs::canonicalize(&current).ok()?;
                }
            }
        }
    }
    if !anchored {
        current = std::fs::canonicalize(&current).ok()?;
    }
    Some(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding_maps_lookalikes_and_case() {
        assert_eq!(normalize_for_match(r"Config\.ENV"), "config/.env");
        assert_eq!(normalize_for_match("\u{FF0E}ｅｎｖ"), ".env");
        assert_eq!(normalize_for_match("id\u{FE4D}rsa"), "id_rsa");
        assert_eq!(normalize_for_match("a\u{2024}pem"), "a.pem");
    }

    #[test]
    fn relative_text_checks() {
        assert_eq!(
            check_relative_text("src/./a/../b.rs"),
            Ok("src/b.rs".into())
        );
        assert!(check_relative_text("../x").is_err());
        assert!(check_relative_text("/etc/passwd").is_err());
        assert!(check_relative_text("C:/x").is_err());
        assert!(check_relative_text("a.txt:stream").is_err());
        assert!(check_relative_text(".env.").is_err());
        assert!(check_relative_text("src/NUL").is_err());
    }
}
