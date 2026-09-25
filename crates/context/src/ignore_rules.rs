//! Ignore-file checks for single paths (items added one at a time, and diff sections).
//!
//! Folder analysis uses the `ignore` crate's walker directly; this oracle answers "is this one
//! path ignored?" with the same files: `.gitignore`, `.ignore` and `.kalcodeignore` in the
//! workspace root and every directory down to the path, `.git/info/exclude`, and the user's
//! global Git excludes file. Unlike Git, the rules apply even when the folder is not a
//! repository, and a path counts as ignored when **any** level ignores it (a deeper `!rule`
//! does not re-allow it). Both choices can only make the firewall stricter.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};

/// Names of the per-directory ignore files KalCode honours.
pub const IGNORE_FILE_NAMES: &[&str] = &[".gitignore", ".ignore", ".kalcodeignore"];

/// Which ignore file matched, for the preview ("ignored by src/.gitignore").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IgnoreHit {
    /// Workspace-relative path of the ignore file, or `"(global Git excludes)"`.
    pub file: String,
}

/// Caches one matcher per directory.
#[derive(Debug)]
pub struct IgnoreOracle {
    root: PathBuf,
    cache: Mutex<HashMap<String, Option<Arc<Gitignore>>>>,
    global: Option<Arc<Gitignore>>,
    exclude: Option<Arc<Gitignore>>,
}

impl IgnoreOracle {
    /// `root` must be the canonical workspace root.
    pub fn new(root: &Path) -> Self {
        let (global, _err) = Gitignore::global();
        let exclude = {
            let path = root.join(".git").join("info").join("exclude");
            if path.is_file() {
                let mut builder = GitignoreBuilder::new(root);
                builder.add(&path);
                builder.build().ok().map(Arc::new)
            } else {
                None
            }
        };
        Self {
            root: root.to_path_buf(),
            cache: Mutex::new(HashMap::new()),
            global: (!global.is_empty()).then(|| Arc::new(global)),
            exclude,
        }
    }

    /// Whether `relative` (canonical, `/`-separated) is ignored.
    pub fn check(&self, relative: &str, is_dir: bool) -> Option<IgnoreHit> {
        let relative = relative.trim_matches('/');
        if relative.is_empty() {
            return None;
        }
        let components: Vec<&str> = relative.split('/').collect();
        // Directories from the root down to the path's parent.
        for depth in 0..components.len() {
            let dir_rel = components[..depth].join("/");
            let Some(matcher) = self.matcher_for(&dir_rel) else {
                continue;
            };
            let sub = components[depth..].join("/");
            if let Match::Ignore(_) = matcher.matched_path_or_any_parents(&sub, is_dir) {
                return Some(IgnoreHit {
                    file: ignore_file_label(&dir_rel),
                });
            }
        }
        for (matcher, label) in [
            (&self.exclude, ".git/info/exclude"),
            (&self.global, "(global Git excludes)"),
        ] {
            if let Some(matcher) = matcher
                && let Match::Ignore(_) = matcher.matched_path_or_any_parents(relative, is_dir)
            {
                return Some(IgnoreHit {
                    file: label.to_owned(),
                });
            }
        }
        None
    }

    fn matcher_for(&self, dir_rel: &str) -> Option<Arc<Gitignore>> {
        if let Ok(cache) = self.cache.lock()
            && let Some(entry) = cache.get(dir_rel)
        {
            return entry.clone();
        }
        let dir = if dir_rel.is_empty() {
            self.root.clone()
        } else {
            self.root.join(dir_rel)
        };
        let mut builder = GitignoreBuilder::new(&dir);
        let mut any = false;
        for name in IGNORE_FILE_NAMES {
            let path = dir.join(name);
            if path.is_file() {
                // A malformed line is skipped by the builder; the rest of the file still applies.
                let _ = builder.add(&path);
                any = true;
            }
        }
        let matcher = if any {
            builder.build().ok().filter(|m| !m.is_empty()).map(Arc::new)
        } else {
            None
        };
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(dir_rel.to_owned(), matcher.clone());
        }
        matcher
    }
}

fn ignore_file_label(dir_rel: &str) -> String {
    if dir_rel.is_empty() {
        "ignore file in the workspace root".to_owned()
    } else {
        format!("ignore file in {dir_rel}/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn honours_nested_ignore_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("root");
        std::fs::write(root.join(".gitignore"), "target/\n*.log\n").expect("write");
        std::fs::create_dir_all(root.join("web")).expect("mkdir");
        std::fs::write(root.join("web").join(".ignore"), "dist\n").expect("write");
        std::fs::write(root.join(".kalcodeignore"), "notes/private.md\n").expect("write");
        let oracle = IgnoreOracle::new(&root);
        assert!(oracle.check("target/debug/app", false).is_some());
        assert!(oracle.check("logs/build.log", false).is_some());
        assert!(oracle.check("web/dist/index.js", false).is_some());
        assert!(oracle.check("notes/private.md", false).is_some());
        assert!(oracle.check("dist/index.js", false).is_none());
        assert!(oracle.check("src/main.rs", false).is_none());
    }
}
