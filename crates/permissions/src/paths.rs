//! Workspace containment for paths named by an action.
//!
//! A path is **inside** the workspace only when every interpretation KalCode can think of lands
//! inside the canonical workspace root:
//!
//! * `..` resolved lexically first (Windows Win32 semantics), then symlinks/junctions resolved;
//! * symlinks/junctions resolved component by component, with `..` applied to the real parent
//!   (POSIX kernel semantics).
//!
//! Anything KalCode cannot resolve — device and UNC paths, alternate data streams, environment
//! expansion, dangling links, reserved device names, a missing workspace root — is treated as
//! **outside** the workspace. The check is a component-boundary prefix test on canonical paths,
//! so `C:\ws2` is never "inside" `C:\ws`, and case differences resolve through the filesystem.
//!
//! Containment is decided at evaluation time. The executor that performs the action must still
//! open files without following links it did not expect (time-of-check/time-of-use).

use std::path::{Component, Path, PathBuf};

/// Longest path string KalCode will classify. Longer input is treated as outside.
pub const MAX_PATH_LEN: usize = 4096;

/// The workspace an action runs in, with its root already canonicalized.
#[derive(Debug, Clone, Default)]
pub struct Workspace {
    root: Option<PathBuf>,
}

impl Workspace {
    /// Canonicalizes `root`. A root that does not exist (or no root at all) yields a workspace
    /// in which every path is outside — the fail-closed default.
    pub fn new(root: Option<&Path>) -> Self {
        Self {
            root: root.and_then(|r| std::fs::canonicalize(r).ok()),
        }
    }

    /// A workspace with no usable root: nothing is inside.
    pub fn none() -> Self {
        Self { root: None }
    }

    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }
}

/// What KalCode learned about one path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathInfo {
    /// True unless the path provably resolves inside the workspace root.
    pub outside: bool,
    /// Workspace-relative form with `/` separators (inside paths only).
    pub relative: Option<String>,
    /// Normalized display form: the relative path when inside, otherwise the input.
    pub display: String,
    /// The path could not be interpreted safely (device path, stream, control characters).
    pub opaque: bool,
    /// The path names a network share (UNC). Touching it can contact another machine.
    pub network: bool,
    /// The path looks like a credential or secret store (`.env`, `.ssh`, `*.pem`, …).
    pub credentials: bool,
    /// The path is inside Git's internal directory (`.git/`), where writes can run code.
    pub git_internal: bool,
    /// Human-readable reason when the path is outside or opaque.
    pub note: Option<String>,
}

impl PathInfo {
    fn outside(raw: &str, note: impl Into<String>) -> Self {
        let mut info = Self::base(raw);
        info.note = Some(note.into());
        info
    }

    fn opaque(raw: &str, note: impl Into<String>) -> Self {
        let mut info = Self::outside(raw, note);
        info.opaque = true;
        info
    }

    fn base(raw: &str) -> Self {
        let display: String = raw.chars().take(300).collect();
        Self {
            outside: true,
            relative: None,
            credentials: looks_like_credentials(&display),
            display,
            opaque: false,
            network: false,
            git_internal: false,
            note: None,
        }
    }
}

/// Resolves `raw` (absolute, or relative to `base`, or to the workspace root when `base` is
/// `None`) and reports whether it is inside `workspace`.
pub fn resolve(workspace: &Workspace, base: Option<&Path>, raw: &str) -> PathInfo {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return PathInfo::opaque(raw, "The path is empty.");
    }
    if trimmed.len() > MAX_PATH_LEN {
        return PathInfo::opaque("(very long path)", "The path is too long to check.");
    }
    if trimmed.chars().any(is_suspicious_char) {
        return PathInfo::opaque(
            trimmed,
            "The path contains control or invisible characters.",
        );
    }
    if has_expansion(trimmed) {
        return PathInfo::outside(
            trimmed,
            "The path depends on environment variables or the home folder, so KalCode treats it as outside the workspace.",
        );
    }

    // Namespace prefixes are checked on the raw text so they are recognized on every OS.
    let unified = trimmed.replace('/', "\\");
    if let Some(rest) = unified
        .strip_prefix(r"\\?\")
        .or_else(|| unified.strip_prefix(r"\??\"))
    {
        let upper = rest.to_ascii_uppercase();
        if upper.starts_with(r"UNC\") {
            let mut info = PathInfo::outside(trimmed, "The path is a network share.");
            info.network = true;
            return info;
        }
        if is_drive_absolute(rest) && cfg!(windows) && unified.starts_with(r"\\?\") {
            // A verbatim drive path (`\\?\C:\…`) is the same location as `C:\…`.
            return resolve(workspace, base, rest);
        }
        return PathInfo::opaque(trimmed, "The path uses a device namespace.");
    }
    if unified.starts_with(r"\\.\") {
        return PathInfo::opaque(trimmed, "The path names a device.");
    }
    if unified.starts_with(r"\\") {
        let mut info = PathInfo::outside(trimmed, "The path is a network share.");
        info.network = true;
        return info;
    }

    let components: Vec<&str> = split_components(trimmed);
    for (index, component) in components.iter().enumerate() {
        let is_drive = index == 0 && is_drive_spec(component);
        if !is_drive && component.contains(':') {
            return PathInfo::opaque(
                trimmed,
                "The path names an alternate data stream or a drive in the wrong place.",
            );
        }
        if is_reserved_device_name(component) {
            return PathInfo::opaque(trimmed, "The path names a reserved device.");
        }
        if cfg!(windows)
            && *component != "."
            && *component != ".."
            && (component.ends_with('.') || component.ends_with(' '))
        {
            return PathInfo::opaque(
                trimmed,
                "The path has a name ending in a dot or space, which Windows rewrites.",
            );
        }
    }

    let Some(root) = workspace.root() else {
        return PathInfo::outside(
            trimmed,
            "This thread has no workspace folder KalCode can verify, so every path is treated as outside it.",
        );
    };

    // Canonical roots on Windows are verbatim (`\\?\C:\…`), where `/` is NOT a separator:
    // joining `a/../b` onto one would create a single literal component. Win32 treats `/` and
    // `\` alike for ordinary paths, so separators are normalized first.
    let native = if cfg!(windows) {
        trimmed.replace('/', "\\")
    } else {
        trimmed.to_owned()
    };
    let absolute = if is_drive_spec(components.first().copied().unwrap_or_default())
        && !is_drive_absolute(trimmed)
    {
        // `C:foo` is relative to the current directory of drive C — ambiguous.
        return PathInfo::outside(trimmed, "The path is relative to another drive.");
    } else if is_drive_absolute(trimmed) {
        if !cfg!(windows) {
            return PathInfo::outside(trimmed, "The path is a Windows drive path.");
        }
        PathBuf::from(&native)
    } else if trimmed.starts_with('/') || (cfg!(windows) && trimmed.starts_with('\\')) {
        if cfg!(windows) {
            // Rooted but driveless: relative to whatever drive the process is on.
            return PathInfo::outside(trimmed, "The path has no drive letter.");
        }
        PathBuf::from(&native)
    } else {
        // `PathBuf::push` resolves `..` textually when the base is verbatim (`\\?\C:\…`), which
        // would hide the physical interpretation below, so join onto the plain form.
        non_verbatim(base.unwrap_or(root)).join(&native)
    };

    let lexical = lexical_normalize(&absolute).and_then(|p| real_path(&p));
    let kernel = real_path(&absolute);
    let inside = match (&lexical, &kernel) {
        (Some(a), Some(b)) => a.starts_with(root) && b.starts_with(root),
        _ => false,
    };

    let mut info = PathInfo::base(trimmed);
    if !inside {
        info.note = Some(if lexical.is_none() || kernel.is_none() {
            "KalCode couldn't resolve this path (for example a broken link), so it is treated as outside the workspace.".to_owned()
        } else {
            "The path resolves outside the workspace.".to_owned()
        });
        info.credentials = looks_like_credentials(trimmed);
        return info;
    }
    let Some(real) = kernel else {
        return info;
    };
    let relative = real
        .strip_prefix(root)
        .map(|rest| {
            rest.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default();
    // Short (8.3) names in a part that does not exist yet cannot be verified.
    if relative.split('/').any(is_short_name) && std::fs::symlink_metadata(&real).is_err() {
        info.note = Some("The path uses a short (8.3) file name KalCode can't verify.".into());
        return info;
    }
    info.outside = false;
    info.git_internal = relative.split('/').any(|c| c.eq_ignore_ascii_case(".git"));
    info.credentials = looks_like_credentials(&relative);
    info.display = if relative.is_empty() {
        ".".into()
    } else {
        relative.clone()
    };
    info.relative = Some(relative);
    info
}

/// `\\?\C:\x` → `C:\x`; anything else unchanged.
fn non_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if is_drive_absolute(rest) => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

fn is_suspicious_char(c: char) -> bool {
    (c.is_control() && c != '\t')
        || matches!(
            c,
            '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
        )
}

/// `~`, `$VAR`, `${…}`, `$(…)`, `%VAR%` and backticks make the real path depend on the
/// environment at run time.
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
        && stem.len() == 4
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
fn lexical_normalize(path: &Path) -> Option<PathBuf> {
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
    Some(out)
}

/// Resolves links component by component: each existing prefix is canonicalized (following
/// symlinks and junctions), `..` moves to the real parent, and components that do not exist
/// yet are appended as written. A link that cannot be resolved yields `None`.
fn real_path(path: &Path) -> Option<PathBuf> {
    let mut current = PathBuf::new();
    let mut anchored = false;
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => {
                current.push(component.as_os_str());
            }
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

/// Folders whose contents are credentials (`~/.ssh/config`, `~/.aws/credentials`).
const CREDENTIAL_DIRS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".azure",
    ".kube",
    ".docker",
    ".password-store",
    "gcloud",
    ".oci",
    ".terraform.d",
];
/// File names that hold credentials.
const CREDENTIAL_FILES: &[&str] = &[
    ".npmrc",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".git-credentials",
    ".pgpass",
    ".htpasswd",
    ".vault-token",
    ".s3cfg",
    ".boto",
    ".dockercfg",
    ".my.cnf",
    ".terraformrc",
    "credentials.tfrc.json",
    "kubeconfig",
    "credentials",
    "credentials.json",
    "credentials.toml",
    "credentials.yml",
    "credentials.yaml",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ecdsa_sk",
    "id_ed25519",
    "id_ed25519_sk",
    "hosts.yml",
    "auth.json",
    "secrets.json",
    "secrets.yml",
    "secrets.yaml",
    "secrets.toml",
    "service-account.json",
    "keychain-db",
    "environ",
];
/// Extensions of key, certificate-store and password-database files.
const CREDENTIAL_EXTENSIONS: &[&str] = &[
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".p8",
    ".keystore",
    ".jks",
    ".kdbx",
    ".ppk",
    ".asc",
    ".gpg",
    ".keychain-db",
];
/// `.env.*` files that are templates, not secrets.
const ENV_TEMPLATES: &[&str] = &[".env.example", ".env.sample", ".env.template", ".env.dist"];

/// Names that commonly hold credentials or secrets.
pub fn looks_like_credentials(path: &str) -> bool {
    let components: Vec<String> = split_components(path)
        .into_iter()
        .map(str::to_ascii_lowercase)
        .collect();
    let Some(name) = components.last() else {
        return false;
    };
    let is_env =
        name == ".env" || (name.starts_with(".env.") && !ENV_TEMPLATES.contains(&name.as_str()));
    is_env
        || components[..components.len() - 1]
            .iter()
            .any(|c| CREDENTIAL_DIRS.contains(&c.as_str()))
        || CREDENTIAL_FILES.contains(&name.as_str())
        || CREDENTIAL_EXTENSIONS.iter().any(|ext| name.ends_with(ext))
}

/// One element of a shell wildcard pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
enum GlobElem {
    Literal(char),
    /// `?`
    One,
    /// `*` (and `**`)
    Star,
    /// `[abc]`, `[a-z]`, `[!x]`/`[^x]`
    Class {
        ranges: Vec<(char, char)>,
        negated: bool,
    },
}

impl GlobElem {
    fn matches(&self, c: char) -> bool {
        match self {
            Self::Literal(l) => *l == c,
            Self::One | Self::Star => true,
            Self::Class { ranges, negated } => {
                ranges.iter().any(|(lo, hi)| (*lo..=*hi).contains(&c)) != *negated
            }
        }
    }

    /// Whether some character matches both single-character elements.
    fn overlaps(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Literal(c), e) | (e, Self::Literal(c)) => e.matches(*c),
            // Two classes, or `?`: assume a common character exists (fail closed).
            _ => true,
        }
    }
}

/// Parses a wildcard pattern, case-folded to lower case (Windows and macOS file systems compare
/// names without case).
fn glob_parse(pattern: &str) -> Vec<GlobElem> {
    let chars: Vec<char> = pattern.to_lowercase().chars().collect();
    let mut out = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' => {
                if out.last() != Some(&GlobElem::Star) {
                    out.push(GlobElem::Star);
                }
            }
            '?' => out.push(GlobElem::One),
            '[' => {
                let mut j = i + 1;
                let negated = matches!(chars.get(j), Some('!' | '^'));
                if negated {
                    j += 1;
                }
                let start = j;
                // A `]` right after `[` or `[!` is a member, not the end.
                if chars.get(j) == Some(&']') {
                    j += 1;
                }
                while j < chars.len() && chars[j] != ']' {
                    j += 1;
                }
                if j >= chars.len() {
                    out.push(GlobElem::Literal('['));
                } else {
                    let members = &chars[start..j];
                    let mut ranges = Vec::new();
                    let mut k = 0;
                    while k < members.len() {
                        if k + 2 < members.len() && members[k + 1] == '-' {
                            ranges.push((members[k], members[k + 2]));
                            k += 3;
                        } else {
                            ranges.push((members[k], members[k]));
                            k += 1;
                        }
                    }
                    out.push(GlobElem::Class { ranges, negated });
                    i = j;
                }
            }
            c => out.push(GlobElem::Literal(c)),
        }
        i += 1;
    }
    out
}

/// Whether a name matches a wildcard pattern (case-insensitive; `*` matches a leading dot, as
/// in PowerShell and cmd.exe).
pub fn glob_match(pattern: &str, name: &str) -> bool {
    let elems = glob_parse(pattern);
    let name: Vec<char> = name.to_lowercase().chars().collect();
    // Linear matcher that backtracks only to the most recent star.
    let (mut p, mut n) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while n < name.len() {
        match elems.get(p) {
            Some(GlobElem::Star) => {
                star = Some((p, n));
                p += 1;
            }
            Some(e) if e.matches(name[n]) => {
                p += 1;
                n += 1;
            }
            _ => match star {
                Some((sp, sn)) => {
                    p = sp + 1;
                    n = sn + 1;
                    star = Some((sp, sn + 1));
                }
                None => return false,
            },
        }
    }
    elems[p.min(elems.len())..]
        .iter()
        .all(|e| *e == GlobElem::Star)
}

/// Whether some name matches both patterns. `dotted` applies the POSIX rule that a leading dot
/// is only matched by a literal dot.
fn globs_intersect(a: &[GlobElem], b: &[GlobElem], dotted: bool) -> bool {
    if dotted
        && matches!(b.first(), Some(GlobElem::Literal('.')))
        && !matches!(a.first(), Some(GlobElem::Literal('.')))
    {
        return false;
    }
    let (la, lb) = (a.len(), b.len());
    let index = |i: usize, j: usize| i * (lb + 1) + j;
    let mut reached = vec![false; (la + 1) * (lb + 1)];
    let mut stack = vec![(0usize, 0usize)];
    reached[0] = true;
    while let Some((i, j)) = stack.pop() {
        if i == la && j == lb {
            return true;
        }
        let (ea, eb) = (a.get(i), b.get(j));
        let mut next: Vec<(usize, usize)> = Vec::with_capacity(4);
        if ea == Some(&GlobElem::Star) {
            next.push((i + 1, j)); // the star matches nothing more
            if eb.is_some() && eb != Some(&GlobElem::Star) {
                next.push((i, j + 1)); // the star swallows b's next character
            }
        }
        if eb == Some(&GlobElem::Star) {
            next.push((i, j + 1));
            if ea.is_some() && ea != Some(&GlobElem::Star) {
                next.push((i + 1, j));
            }
        }
        if let (Some(x), Some(y)) = (ea, eb)
            && *x != GlobElem::Star
            && *y != GlobElem::Star
            && x.overlaps(y)
        {
            next.push((i + 1, j + 1));
        }
        for (ni, nj) in next {
            if !reached[index(ni, nj)] {
                reached[index(ni, nj)] = true;
                stack.push((ni, nj));
            }
        }
    }
    false
}

/// Whether a wildcard path (`.en*`, `*.pem`, `~/.ss?/*`) can name a credential file or folder
/// under the POSIX dot rule. Callers also expand the pattern against the real folder, which
/// covers shells where `*` matches dot files.
pub fn glob_may_match_credentials(pattern: &str) -> bool {
    let components: Vec<&str> = split_components(pattern);
    let Some((last, _)) = components.split_last() else {
        return false;
    };
    let is_glob = |c: &str| c.contains(['*', '?', '[']);
    // A name made only of wildcards (`*`, `*.*`, `?*`) aims at nothing in particular; whether it
    // reaches a credential depends on the folder's real contents, which the caller lists.
    let aims = |c: &str| {
        c.chars()
            .any(|ch| !matches!(ch, '*' | '?' | '.' | '[' | ']' | '!' | '^'))
    };
    // A wildcard part can name, or walk into, a credential folder; `**` into any of them.
    for part in &components {
        if !is_glob(part) {
            if CREDENTIAL_DIRS.contains(&part.to_ascii_lowercase().as_str()) {
                return true;
            }
            continue;
        }
        if *part == "**" {
            return true;
        }
        let elems = glob_parse(part);
        if aims(part)
            && CREDENTIAL_DIRS
                .iter()
                .any(|d| globs_intersect(&elems, &glob_parse(d), true))
        {
            return true;
        }
    }
    if !is_glob(last) {
        return looks_like_credentials(pattern);
    }
    if !aims(last) {
        return false;
    }
    let elems = glob_parse(last);
    let mut candidates: Vec<Vec<GlobElem>> = CREDENTIAL_FILES
        .iter()
        .map(|f| glob_parse(f))
        .chain(
            CREDENTIAL_EXTENSIONS
                .iter()
                .map(|e| glob_parse(&format!("*{e}"))),
        )
        .collect();
    candidates.push(glob_parse(".env"));
    candidates.push(glob_parse(".env.*"));
    candidates
        .iter()
        .any(|candidate| globs_intersect(&elems, candidate, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("ws").join("src")).expect("mkdir");
        std::fs::write(dir.path().join("ws").join("src").join("a.txt"), b"x").expect("write");
        std::fs::create_dir_all(dir.path().join("ws2")).expect("mkdir");
        let workspace = Workspace::new(Some(&dir.path().join("ws")));
        (dir, workspace)
    }

    #[test]
    fn relative_paths_inside_the_root_are_inside() {
        let (_dir, workspace) = ws();
        for path in [
            "src/a.txt",
            "./src/a.txt",
            "src/new/file.rs",
            "src/../src/a.txt",
            ".",
        ] {
            let info = resolve(&workspace, None, path);
            assert!(!info.outside, "{path}: {info:?}");
        }
        assert_eq!(
            resolve(&workspace, None, "src/a.txt").relative.as_deref(),
            Some("src/a.txt")
        );
    }

    #[test]
    fn traversal_and_sibling_prefixes_are_outside() {
        let (dir, workspace) = ws();
        let sibling = dir.path().join("ws2").join("x");
        for path in [
            "../ws2/x".to_owned(),
            "src/../../ws2/x".to_owned(),
            "../../../../../../etc/passwd".to_owned(),
            "src/new/../../../x".to_owned(),
            sibling.to_string_lossy().into_owned(),
        ] {
            let info = resolve(&workspace, None, &path);
            assert!(info.outside, "{path}: {info:?}");
        }
    }

    #[test]
    fn absolute_paths_inside_the_root_are_inside() {
        let (dir, workspace) = ws();
        let inside = dir.path().join("ws").join("src").join("a.txt");
        assert!(!resolve(&workspace, None, &inside.to_string_lossy()).outside);
    }

    #[test]
    fn environment_and_home_paths_are_outside() {
        let (_dir, workspace) = ws();
        for path in [
            "~/.ssh/id_rsa",
            "$HOME/x",
            "${HOME}/x",
            "%USERPROFILE%\\x",
            "`pwd`/x",
        ] {
            assert!(resolve(&workspace, None, path).outside, "{path}");
        }
    }

    #[test]
    fn namespace_and_device_paths_are_outside_and_opaque() {
        let (_dir, workspace) = ws();
        for path in [
            r"\\server\share\file",
            "//server/share/file",
            r"\\.\PhysicalDrive0",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\x",
            r"\\?\UNC\server\share\x",
            r"\??\C:\x",
            "src/NUL",
            "src/con.txt",
            "src/COM1",
            "src/a.txt:hidden",
        ] {
            let info = resolve(&workspace, None, path);
            assert!(info.outside, "{path}: {info:?}");
        }
        assert!(resolve(&workspace, None, r"\\server\share\f").network);
        assert!(resolve(&workspace, None, r"\\.\PhysicalDrive0").opaque);
    }

    #[test]
    fn control_and_invisible_characters_are_opaque() {
        let (_dir, workspace) = ws();
        for path in [
            "src/a\u{0}.txt",
            "src/\u{202E}txt.exe",
            "src/a\u{200B}.txt",
            "src/a\n.txt",
        ] {
            let info = resolve(&workspace, None, path);
            assert!(info.outside && info.opaque, "{path:?}");
        }
    }

    #[test]
    fn missing_workspace_root_fails_closed() {
        let info = resolve(&Workspace::none(), None, "src/a.txt");
        assert!(info.outside);
        let gone = Workspace::new(Some(Path::new("/definitely/not/a/real/root/kalcode")));
        assert!(resolve(&gone, None, "a.txt").outside);
    }

    #[test]
    fn credentials_and_git_internals_are_flagged() {
        let (_dir, workspace) = ws();
        assert!(resolve(&workspace, None, ".env").credentials);
        assert!(resolve(&workspace, None, "config/.env.production").credentials);
        assert!(!resolve(&workspace, None, ".env.example").credentials);
        assert!(resolve(&workspace, None, "certs/server.pem").credentials);
        assert!(resolve(&workspace, None, ".git/hooks/pre-commit").git_internal);
        assert!(resolve(&workspace, None, "sub/.GIT/config").git_internal);
        assert!(!resolve(&workspace, None, "src/a.txt").git_internal);
    }

    #[test]
    fn wildcards_that_can_name_credentials() {
        for pattern in [
            ".en*",
            ".en?",
            ".e*",
            ".[e]nv",
            "*.pem",
            "*.P?M",
            "id_*",
            "src/*.key",
            "~/.ss*/id_rsa",
            ".aw?/credentials",
            "**/x",
            "cred*",
            ".git-cred*",
        ] {
            assert!(glob_may_match_credentials(pattern), "{pattern}");
        }
        for pattern in ["*", "*.*", "*.rs", "src/*.md", "?", "a*z", ".github/*.md"] {
            assert!(!glob_may_match_credentials(pattern), "{pattern}");
        }
    }

    #[test]
    fn glob_match_follows_shell_rules() {
        assert!(glob_match("*.pem", "server.PEM"));
        assert!(glob_match("*", ".env"));
        assert!(glob_match(".[e]nv", ".env"));
        assert!(glob_match("[!x]*", "abc"));
        assert!(!glob_match("[!a]*", "abc"));
        assert!(glob_match("a*b*c", "aXbYbZc"));
        assert!(!glob_match("a*b", "aXbY"));
        assert!(glob_match("???", "abc"));
        assert!(!glob_match("??", "abc"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_case_verbatim_and_separator_tricks() {
        let (dir, workspace) = ws();
        let root = dir.path().join("ws");
        let upper = root.to_string_lossy().to_uppercase();
        assert!(!resolve(&workspace, None, &format!("{upper}\\SRC\\A.TXT")).outside);
        let verbatim = format!(r"\\?\{}\src\a.txt", root.to_string_lossy());
        assert!(!resolve(&workspace, None, &verbatim).outside, "{verbatim}");
        let mixed = format!("{}/src\\..//..\\ws2/x", root.to_string_lossy());
        assert!(resolve(&workspace, None, &mixed).outside);
        for path in [
            "C:relative.txt",
            r"\Windows\System32\drivers\etc\hosts",
            "src\\evil. ",
            "src\\evil.",
        ] {
            assert!(resolve(&workspace, None, path).outside, "{path}");
        }
        // A sibling whose name extends the root name is not inside.
        let sibling = format!("{}2\\x", root.to_string_lossy());
        assert!(resolve(&workspace, None, &sibling).outside);
    }
}
