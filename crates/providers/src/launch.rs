//! How a resolved provider executable is actually started.
//!
//! A native executable (`claude.exe`, `codex`) is started directly. On Windows, npm, pnpm and
//! Yarn install CLIs as `.cmd` shims that `cmd.exe` interprets: typically
//! `"%dp0%\node.exe" "%dp0%\node_modules\pkg\cli.js" %*`, falling back to a **bare** `node` when
//! there is no `node.exe` next to the shim. Provider sessions run with the workspace as their
//! working directory, and `cmd.exe` looks for a bare program name in the current directory
//! first, so a `node.cmd` or `node.exe` committed to a repository would run instead of Node.js
//! the moment a thread starts (security review, finding 1).
//!
//! KalCode therefore never lets `cmd.exe` pick the program:
//! 1. The shim is read (bounded, never executed) and its single launch target — the quoted
//!    `%dp0%\…` / `%~dp0\…` path — is resolved to an absolute, existing file.
//!    - A native target (`bin\claude.exe`, what current `@anthropic-ai/claude-code` releases
//!      install) is started directly.
//!    - A script target (`.js`, `.cjs`, `.mjs`) is started as `<node.exe> <script> <args…>`,
//!      with `node.exe` taken from the shim's own folder, else from the **absolute** `PATH`
//!      entries of the provider environment. Never `node.cmd`, never a relative folder.
//! 2. Only when a shim can't be understood is it run as-is, and then with the hardened
//!    environment ([`crate::env::harden`]): `NoDefaultCurrentDirectoryInExePath=1` (so
//!    `cmd.exe` does not search the working directory for bare names) and a `PATH` with only
//!    absolute entries. The Rust standard library starts batch files with the `cmd.exe` from
//!    the system directory (not one found on `PATH` or in the working directory) and `/d`
//!    (no AutoRun).
//!
//! Why not start the shim in an empty KalCode-owned folder instead? Claude Code has no flag
//! that sets its project folder separately from its working directory (`claude --help`
//! 2.1.282 lists `--add-dir` for *additional* folders only), and the working directory decides
//! which project the session reads and where its file tools are confined. Starting it anywhere
//! but the workspace would change what the session can reach.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::env::{absolute_path_entries, lookup};

/// Shims are a few hundred bytes; anything much larger is not a shim KalCode understands.
const MAX_SHIM_BYTES: u64 = 16 * 1024;

/// What to start for a resolved executable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    /// Arguments that go before the caller's own (the script, for a Node.js shim).
    pub prefix_args: Vec<OsString>,
    pub kind: LaunchKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchKind {
    /// Started directly: not a script launcher.
    Direct,
    /// A `.cmd`/`.bat` shim whose native target is started directly.
    ShimNative,
    /// A `.cmd`/`.bat` shim whose script is started with an absolute `node.exe`.
    ShimNode,
    /// A `.cmd`/`.bat` shim KalCode couldn't resolve; run through `cmd.exe` with the hardened
    /// environment.
    ShimUnresolved,
}

fn is_script_launcher(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// Decides how to start `executable` with the (already sanitized) provider environment `env`.
pub fn resolve(executable: &Path, env: &BTreeMap<OsString, OsString>) -> Launch {
    let direct = |kind| Launch {
        program: executable.to_path_buf(),
        prefix_args: Vec::new(),
        kind,
    };
    if !is_script_launcher(executable) {
        return direct(LaunchKind::Direct);
    }
    let Some(target) = shim_target(executable) else {
        tracing::warn!(
            event = "provider.shim_unresolved",
            reason = "target",
            shim = %kalcode_core::runtime::display_path(executable)
        );
        return direct(LaunchKind::ShimUnresolved);
    };
    if is_script(&target) {
        match node_for(executable, env) {
            Some(node) => Launch {
                program: node,
                prefix_args: vec![target.into_os_string()],
                kind: LaunchKind::ShimNode,
            },
            None => {
                tracing::warn!(
                    event = "provider.shim_unresolved",
                    reason = "node",
                    shim = %kalcode_core::runtime::display_path(executable)
                );
                direct(LaunchKind::ShimUnresolved)
            }
        }
    } else if is_native(&target) {
        Launch {
            program: target,
            prefix_args: Vec::new(),
            kind: LaunchKind::ShimNative,
        }
    } else {
        direct(LaunchKind::ShimUnresolved)
    }
}

fn has_ext(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|e| exts.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

fn is_script(path: &Path) -> bool {
    has_ext(path, &["js", "cjs", "mjs"])
}

fn is_native(path: &Path) -> bool {
    has_ext(path, &["exe", "com"])
}

/// The one launch target a shim names, resolved against the shim's folder. `None` when there is
/// no target, more than one distinct target, or the target isn't an existing file inside a
/// plain relative path (no drive, root or `%VAR%` expansion other than the shim folder).
pub fn shim_target(shim: &Path) -> Option<PathBuf> {
    let dir = shim.parent()?;
    let mut text = String::new();
    std::fs::File::open(shim)
        .ok()?
        .take(MAX_SHIM_BYTES + 1)
        .read_to_string(&mut text)
        .ok()?;
    if text.len() as u64 > MAX_SHIM_BYTES {
        return None;
    }
    let mut targets: Vec<PathBuf> = Vec::new();
    for quoted in text.split('"').skip(1).step_by(2) {
        let Some(rel) = strip_shim_dir(quoted) else {
            continue;
        };
        let rel_path = Path::new(rel);
        let name_is_node = rel_path
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|n| n.eq_ignore_ascii_case("node.exe"));
        if name_is_node || !(is_script(rel_path) || is_native(rel_path)) {
            continue;
        }
        let candidate = join_relative(dir, rel)?;
        if !targets.contains(&candidate) {
            targets.push(candidate);
        }
    }
    let [target] = targets.as_slice() else {
        return None;
    };
    let canonical = plain(&std::fs::canonicalize(target).ok()?);
    canonical.is_file().then_some(canonical)
}

/// `%dp0%\x`, `%~dp0\x` or `%~dp0x` → `x`.
fn strip_shim_dir(quoted: &str) -> Option<&str> {
    let lower = quoted.to_ascii_lowercase();
    for prefix in ["%dp0%\\", "%dp0%/", "%~dp0\\", "%~dp0/", "%~dp0"] {
        if lower.starts_with(prefix) {
            let rest = &quoted[prefix.len()..];
            return (!rest.is_empty()).then_some(rest);
        }
    }
    None
}

/// Joins a shim-relative path. Refuses anything that isn't plain names and `..`: no drive or
/// root, and no `%` (further variable expansion) or other characters `cmd.exe` would treat
/// specially.
fn join_relative(dir: &Path, rel: &str) -> Option<PathBuf> {
    if rel.contains(['%', '!', '^', '&', '|', '<', '>', '\r', '\n']) {
        return None;
    }
    let normalized = rel.replace('/', "\\");
    let mut out = dir.to_path_buf();
    for part in normalized
        .split('\\')
        .filter(|p| !p.is_empty() && *p != ".")
    {
        match Path::new(part).components().next() {
            Some(Component::Normal(_)) if Path::new(part).components().count() == 1 => {
                out.push(part);
            }
            Some(Component::ParentDir) => {
                out.pop();
            }
            _ => return None,
        }
    }
    Some(out)
}

/// `node.exe` next to the shim (what the shim itself prefers), else the first `node.exe` in an
/// absolute `PATH` entry of the provider environment.
fn node_for(shim: &Path, env: &BTreeMap<OsString, OsString>) -> Option<PathBuf> {
    let beside = shim.parent().map(|d| d.join("node.exe"));
    beside
        .filter(|p| p.is_file())
        .or_else(|| {
            let path = lookup(env, "PATH")?;
            absolute_path_entries(path)
                .into_iter()
                .map(|dir| dir.join("node.exe"))
                .find(|p| p.is_file())
        })
        .map(|p| std::fs::canonicalize(&p).map_or(p, |c| plain(&c)))
}

/// Removes the `\\?\` prefix `canonicalize` adds on Windows for ordinary drive paths, so the
/// path works for every program it is passed to.
fn plain(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest)
            if rest.len() >= 2
                && rest.as_bytes()[1] == b':'
                && rest.as_bytes()[0].is_ascii_alphabetic() =>
        {
            PathBuf::from(rest)
        }
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
#[cfg(windows)]
mod tests {
    use super::*;

    /// The shim npm (cmd-shim) writes for a package whose bin is a Node.js script.
    const NPM_NODE_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js\" %*\r\n";
    /// The shim npm writes for a package whose bin is a native executable (current Claude Code).
    const NPM_NATIVE_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n";
    /// The older npm / pnpm style.
    const PNPM_SHIM: &str = "@SETLOCAL\r\n@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\..\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  \"%~dp0\\..\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n)\r\n";

    fn install(shim: &str, target_rel: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().expect("tempdir");
        let bin = root.path().join("bin");
        std::fs::create_dir_all(&bin).expect("mkdir");
        let target = bin.join(target_rel);
        std::fs::create_dir_all(target.parent().expect("parent")).expect("mkdir");
        std::fs::write(&target, b"").expect("target");
        let shim_path = bin.join("tool.cmd");
        std::fs::write(&shim_path, shim).expect("shim");
        let target = plain(&std::fs::canonicalize(&target).expect("canonical"));
        (root, shim_path, target)
    }

    fn env_with_path(dirs: &[&Path]) -> BTreeMap<OsString, OsString> {
        let mut env = BTreeMap::new();
        env.insert(
            OsString::from("PATH"),
            std::env::join_paths(dirs).expect("join"),
        );
        env
    }

    #[test]
    fn native_executables_start_directly() {
        let launch = resolve(Path::new("/opt/claude"), &BTreeMap::new());
        assert_eq!(launch.kind, LaunchKind::Direct);
        assert!(launch.prefix_args.is_empty());
    }

    #[test]
    fn an_npm_shim_for_a_native_binary_starts_the_binary() {
        let (_root, shim, target) = install(
            NPM_NATIVE_SHIM,
            r"node_modules\@anthropic-ai\claude-code\bin\claude.exe",
        );
        let launch = resolve(&shim, &BTreeMap::new());
        assert_eq!(launch.kind, LaunchKind::ShimNative);
        assert_eq!(launch.program, target);
        assert!(launch.prefix_args.is_empty());
    }

    #[test]
    fn an_npm_node_shim_starts_an_absolute_node_with_the_script() {
        let (root, shim, script) = install(
            NPM_NODE_SHIM,
            r"node_modules\@anthropic-ai\claude-code\cli.js",
        );
        // No node.exe beside the shim, none on PATH: can't resolve, falls back.
        let launch = resolve(&shim, &env_with_path(&[]));
        assert_eq!(launch.kind, LaunchKind::ShimUnresolved);
        assert_eq!(launch.program, shim);

        let node_dir = root.path().join("nodejs");
        std::fs::create_dir_all(&node_dir).expect("mkdir");
        std::fs::write(node_dir.join("node.exe"), b"").expect("node");
        // A node.cmd earlier on PATH is never used; only node.exe.
        let decoy = root.path().join("decoy");
        std::fs::create_dir_all(&decoy).expect("mkdir");
        std::fs::write(decoy.join("node.cmd"), b"@echo decoy").expect("decoy");
        let launch = resolve(&shim, &env_with_path(&[&decoy, &node_dir]));
        assert_eq!(launch.kind, LaunchKind::ShimNode);
        assert_eq!(
            launch.program,
            plain(&std::fs::canonicalize(node_dir.join("node.exe")).expect("canonical"))
        );
        assert_eq!(launch.prefix_args, [script.into_os_string()]);

        // node.exe beside the shim wins, as the shim itself would choose.
        std::fs::write(shim.parent().expect("dir").join("node.exe"), b"").expect("node");
        let launch = resolve(&shim, &env_with_path(&[&node_dir]));
        assert_eq!(
            launch.program,
            plain(&std::fs::canonicalize(shim.with_file_name("node.exe")).expect("canonical"))
        );
    }

    #[test]
    fn relative_path_entries_never_supply_node() {
        let (_root, shim, _script) = install(
            NPM_NODE_SHIM,
            r"node_modules\@anthropic-ai\claude-code\cli.js",
        );
        let here = tempfile::tempdir_in(".").expect("tempdir in cwd");
        std::fs::write(here.path().join("node.exe"), b"").expect("node");
        let rel = PathBuf::from(here.path().file_name().expect("name"));
        let launch = resolve(&shim, &env_with_path(&[&rel]));
        assert_eq!(launch.kind, LaunchKind::ShimUnresolved);
    }

    #[test]
    fn pnpm_style_shims_resolve_parent_relative_targets() {
        let root = tempfile::tempdir().expect("tempdir");
        let bin = root.path().join("pnpm");
        let script = root
            .path()
            .join(r"global\5\node_modules\@openai\codex\bin\codex.js");
        std::fs::create_dir_all(script.parent().expect("parent")).expect("mkdir");
        std::fs::create_dir_all(&bin).expect("mkdir");
        std::fs::write(&script, b"").expect("script");
        std::fs::write(bin.join("node.exe"), b"").expect("node");
        let shim = bin.join("codex.cmd");
        std::fs::write(&shim, PNPM_SHIM).expect("shim");
        let launch = resolve(&shim, &BTreeMap::new());
        assert_eq!(launch.kind, LaunchKind::ShimNode);
        assert_eq!(
            launch.prefix_args,
            [plain(&std::fs::canonicalize(&script).expect("canonical")).into_os_string()]
        );
    }

    #[test]
    fn ambiguous_missing_or_unsafe_targets_are_not_resolved() {
        for (shim, target) in [
            // Two different targets.
            ("\"%dp0%\\a.js\" \"%dp0%\\b.js\" %*", "a.js"),
            // Target doesn't exist.
            ("\"%dp0%\\missing.js\" %*", "present.js"),
            // Further variable expansion.
            ("\"%dp0%\\%NAME%.js\" %*", "x.js"),
            // Absolute path hidden behind the shim folder.
            ("\"%dp0%\\C:\\evil\\x.js\" %*", "x.js"),
            // No target at all.
            ("@echo hello", "x.js"),
        ] {
            let (_root, shim_path, _target) = install(shim, target);
            if target == "a.js" {
                std::fs::write(shim_path.with_file_name("b.js"), b"").expect("b");
            }
            assert_eq!(shim_target(&shim_path), None, "{shim}");
            assert_eq!(
                resolve(&shim_path, &BTreeMap::new()).kind,
                LaunchKind::ShimUnresolved,
                "{shim}"
            );
        }
    }

    #[test]
    fn oversized_shims_are_not_parsed() {
        let mut big = "\"%dp0%\\cli.js\" %*\r\n".to_owned();
        big.push_str(&"rem padding\r\n".repeat(2000));
        let (_root, shim, _target) = install(&big, "cli.js");
        assert_eq!(shim_target(&shim), None);
    }
}
