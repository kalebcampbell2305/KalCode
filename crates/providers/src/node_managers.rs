//! Unix: user-level Node.js install folders, searched for provider CLIs after `PATH` and the
//! documented install folders. A Finder-launched app's `PATH` has none of them, so an
//! npm-installed Gemini CLI or Codex in one of them was never found.
//!
//! Only fixed folders under the home folder, each canonicalized and required to be a real
//! directory:
//! - `~/.npm-global/bin` (npm's documented user prefix);
//! - `~/.volta/bin` (Volta);
//! - nvm's **default** version only: `~/.nvm/alias/default`, following nvm aliases
//!   (`lts/*` -> `~/.nvm/alias/lts/*` -> ...) to an installed `~/.nvm/versions/node/<v>/bin`.
//!   `node`/`stable` mean the highest installed version, and a partial version (`22`, `v22.4`)
//!   the highest installed match, as nvm resolves them. Anything else (`system`, a missing
//!   alias, a version that isn't installed, a loop) is skipped, never guessed.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// nvm aliases are short; a longer file is not one.
const MAX_ALIAS_BYTES: u64 = 256;
/// Alias chains are a few hops (`default` -> `lts/*` -> `lts/<name>` -> version).
const MAX_ALIAS_HOPS: usize = 8;

type Semver = (u64, u64, u64);

/// The user-level folders that exist, canonicalized, in search order.
pub(crate) fn user_bin_dirs(home: &Path) -> Vec<PathBuf> {
    if !home.is_absolute() {
        return Vec::new();
    }
    [
        Some(home.join(".npm-global/bin")),
        Some(home.join(".volta/bin")),
        nvm_default_bin(&home.join(".nvm")),
    ]
    .into_iter()
    .flatten()
    .filter_map(|dir| real_dir(&dir))
    .collect()
}

fn real_dir(dir: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(dir).ok()?;
    (canonical.is_absolute() && canonical.is_dir()).then_some(canonical)
}

/// `<nvm>/versions/node/<default version>/bin`, or `None` when the default can't be resolved
/// to an installed version.
pub(crate) fn nvm_default_bin(nvm: &Path) -> Option<PathBuf> {
    let versions = nvm.join("versions/node");
    let installed = installed_versions(&versions);
    let mut name = String::from("default");
    for _ in 0..MAX_ALIAS_HOPS {
        let value = read_alias(&nvm.join("alias"), &name)?;
        if let Some(dir) = match_version(&value, &installed) {
            return Some(versions.join(dir).join("bin"));
        }
        if value == "system" || parse_partial(&value).is_some() {
            // `system`, or a version that isn't installed.
            return None;
        }
        name = value;
    }
    None
}

/// The first line of `<alias dir>/<name>`, when `name` is a plain relative alias name.
fn read_alias(alias_dir: &Path, name: &str) -> Option<String> {
    let rel = Path::new(name);
    let plain = !name.is_empty() && rel.components().all(|c| matches!(c, Component::Normal(_)));
    if !plain {
        return None;
    }
    let mut text = String::new();
    std::fs::File::open(alias_dir.join(rel))
        .ok()?
        .take(MAX_ALIAS_BYTES)
        .read_to_string(&mut text)
        .ok()?;
    let value = text.lines().next()?.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// Installed versions: `v<major>.<minor>.<patch>` folders.
fn installed_versions(versions: &Path) -> Vec<(Semver, String)> {
    let Ok(entries) = std::fs::read_dir(versions) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let parts = parse_partial(&name)?;
            let [major, minor, patch] = parts[..] else {
                return None;
            };
            (name.starts_with('v') && entry.path().is_dir())
                .then_some(((major, minor, patch), name))
        })
        .collect()
}

/// `22`, `v22.4`, `22.4.1` -> the numbers given; anything else -> `None`.
fn parse_partial(value: &str) -> Option<Vec<u64>> {
    let digits = value.strip_prefix('v').unwrap_or(value);
    let parts = digits
        .split('.')
        .map(|p| {
            (!p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
                .then(|| p.parse().ok())
                .flatten()
        })
        .collect::<Option<Vec<u64>>>()?;
    (1..=3).contains(&parts.len()).then_some(parts)
}

/// The installed folder a version value names: `node`/`stable` -> the highest installed; a
/// full version -> exactly that one; a partial one -> the highest installed match.
fn match_version<'a>(value: &str, installed: &'a [(Semver, String)]) -> Option<&'a str> {
    let wanted: Vec<u64> = match value {
        "node" | "stable" => Vec::new(),
        _ => parse_partial(value)?,
    };
    installed
        .iter()
        .filter(|((major, minor, patch), _)| {
            wanted
                .iter()
                .zip([major, minor, patch])
                .all(|(want, have)| want == have)
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, name)| name.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An nvm folder with `versions` installed and `aliases` (name, value) written.
    fn nvm(versions: &[&str], aliases: &[(&str, &str)]) -> tempfile::TempDir {
        let root = tempfile::tempdir().expect("tempdir");
        for version in versions {
            std::fs::create_dir_all(root.path().join("versions/node").join(version).join("bin"))
                .expect("mkdir");
        }
        for (name, value) in aliases {
            let path = root.path().join("alias").join(name);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            std::fs::write(path, format!("{value}\n")).expect("alias");
        }
        root
    }

    fn default_version(versions: &[&str], aliases: &[(&str, &str)]) -> Option<String> {
        let root = nvm(versions, aliases);
        nvm_default_bin(root.path()).map(|bin| {
            assert_eq!(bin.file_name().and_then(|n| n.to_str()), Some("bin"));
            let dir = bin.parent().expect("version dir");
            assert_eq!(
                dir.parent(),
                Some(root.path().join("versions/node").as_path())
            );
            dir.file_name()
                .and_then(|n| n.to_str())
                .expect("name")
                .to_owned()
        })
    }

    const INSTALLED: &[&str] = &["v18.20.4", "v20.5.0", "v20.11.1", "v22.1.0"];

    #[test]
    fn default_resolves_versions_like_nvm() {
        for (value, expected) in [
            ("v20.5.0", Some("v20.5.0")),
            ("20.5.0", Some("v20.5.0")),
            ("20", Some("v20.11.1")),
            ("v20", Some("v20.11.1")),
            ("18.20", Some("v18.20.4")),
            ("node", Some("v22.1.0")),
            ("stable", Some("v22.1.0")),
            // Not installed, or not a version nvm would pick: skipped, never guessed.
            ("v21.0.0", None),
            ("19", None),
            ("system", None),
            ("iojs", None),
            ("", None),
            ("1.2.3.4", None),
        ] {
            assert_eq!(
                default_version(INSTALLED, &[("default", value)]).as_deref(),
                expected,
                "{value:?}"
            );
        }
    }

    #[test]
    fn alias_chains_are_followed() {
        let lts = [
            ("default", "lts/*"),
            ("lts/*", "lts/iron"),
            ("lts/iron", "v20.5.0"),
        ];
        assert_eq!(default_version(INSTALLED, &lts).as_deref(), Some("v20.5.0"));
        let user = [("default", "work"), ("work", "18")];
        assert_eq!(
            default_version(INSTALLED, &user).as_deref(),
            Some("v18.20.4")
        );
    }

    #[test]
    fn unresolvable_defaults_are_skipped() {
        // No default alias, a dangling alias, a loop, and an escape from the alias folder.
        assert_eq!(default_version(INSTALLED, &[]), None);
        assert_eq!(default_version(INSTALLED, &[("default", "lts/*")]), None);
        let looped = [("default", "a"), ("a", "b"), ("b", "a")];
        assert_eq!(default_version(INSTALLED, &looped), None);
        for escape in ["../outside", "/etc/passwd", "lts/../../x", "./default"] {
            let root = nvm(INSTALLED, &[("default", escape)]);
            std::fs::write(root.path().join("outside"), "v20.5.0").expect("write");
            assert_eq!(nvm_default_bin(root.path()), None, "{escape}");
        }
        // Nothing installed.
        assert_eq!(default_version(&[], &[("default", "node")]), None);
        // Folders that aren't `v<x>.<y>.<z>` are not versions.
        assert_eq!(
            default_version(&["22.1.0", "vfoo", "v22"], &[("default", "node")]),
            None
        );
    }

    #[test]
    fn user_bin_dirs_are_existing_canonical_folders_only() {
        let home = tempfile::tempdir().expect("tempdir");
        assert!(user_bin_dirs(home.path()).is_empty());
        assert!(user_bin_dirs(Path::new("relative-home")).is_empty());
        let npm_global = home.path().join(".npm-global/bin");
        let volta = home.path().join(".volta/bin");
        let nvm_bin = home.path().join(".nvm/versions/node/v20.5.0/bin");
        for dir in [&npm_global, &volta, &nvm_bin] {
            std::fs::create_dir_all(dir).expect("mkdir");
        }
        std::fs::create_dir_all(home.path().join(".nvm/alias")).expect("mkdir");
        std::fs::write(home.path().join(".nvm/alias/default"), "20").expect("alias");
        let canonical = |p: &Path| std::fs::canonicalize(p).expect("canonical");
        assert_eq!(
            user_bin_dirs(home.path()),
            [
                canonical(&npm_global),
                canonical(&volta),
                canonical(&nvm_bin)
            ]
        );
        // A file where a folder should be is not searched.
        std::fs::remove_dir(&volta).expect("rmdir");
        std::fs::write(&volta, b"").expect("file");
        assert_eq!(
            user_bin_dirs(home.path()),
            [canonical(&npm_global), canonical(&nvm_bin)]
        );
    }
}
