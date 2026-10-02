//! Repository discovery for a workspace, per-repository neutralization of repository-defined
//! filter drivers, and validation of revisions and branch names before they reach argv.

use std::path::{Path, PathBuf};

use kalcode_core::{KalError, Result};

use crate::paths::{RelPath, WorkspaceRoot};
use crate::runner::{Git, git_error};

/// The repository a workspace belongs to.
#[derive(Debug, Clone)]
pub struct Repo {
    workspace: WorkspaceRoot,
    toplevel: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    /// The workspace root relative to the repository's top level (`""` when they are the same,
    /// otherwise `sub/dir`, no trailing slash).
    prefix: String,
    /// `-c` settings that neutralize filter drivers defined by the repository's own config.
    overrides: Vec<String>,
    /// The repository's own config (`local` / `worktree` scope) defines a merge driver
    /// (`merge.<name>.driver`, an arbitrary command). Merge predictions refuse to run then.
    repo_merge_driver: bool,
}

impl Repo {
    /// Finds the repository containing `workspace`. `Ok(None)` when the folder isn't in a Git
    /// repository. Refuses a repository whose work tree does not contain the workspace (for
    /// example a hostile `core.worktree` pointing elsewhere) and bare repositories.
    pub fn discover(git: &Git, workspace: &WorkspaceRoot) -> Result<Option<Self>> {
        let out = git
            .cmd()
            .current_dir(workspace.path())
            .args([
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--git-dir",
                "--git-common-dir",
            ])
            .read_only()
            .run()?;
        if !out.status.success() {
            let text = out.stderr.to_ascii_lowercase();
            if text.contains("not a git repository") {
                return Ok(None);
            }
            if text.contains("work tree") || text.contains("bare") {
                return Err(git_error(
                    "repository_bare",
                    "This folder is inside a Git repository without a working tree.",
                ));
            }
            return Err(crate::runner::classify_failure("discover", &out));
        }
        let text = out.stdout_text();
        let mut lines = text.lines();
        let (Some(top), Some(dir), Some(common)) = (lines.next(), lines.next(), lines.next())
        else {
            return Err(git_error(
                "discover_failed",
                "Git didn't describe the repository.",
            ));
        };
        let toplevel = std::fs::canonicalize(top).map_err(|e| {
            git_error(
                "discover_failed",
                "Git described a repository folder that doesn't exist.",
            )
            .with_source(e)
        })?;
        let prefix_path = workspace.path().strip_prefix(&toplevel).map_err(|_| {
            git_error(
                "repository_outside_workspace",
                "This repository's working tree is configured outside the workspace, so KalCode won't use it.",
            )
        })?;
        let prefix = prefix_path
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        let mut repo = Self {
            workspace: workspace.clone(),
            toplevel,
            git_dir: PathBuf::from(dir),
            common_dir: PathBuf::from(common),
            prefix,
            overrides: Vec::new(),
            repo_merge_driver: false,
        };
        (repo.overrides, repo.repo_merge_driver) =
            repository_filter_overrides(git, &repo.toplevel)?;
        Ok(Some(repo))
    }

    pub fn workspace(&self) -> &WorkspaceRoot {
        &self.workspace
    }

    /// Canonical top level of the work tree.
    pub fn toplevel(&self) -> &Path {
        &self.toplevel
    }

    pub fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    pub fn common_dir(&self) -> &Path {
        &self.common_dir
    }

    /// Workspace root relative to the top level (`""` when equal).
    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    pub fn overrides(&self) -> &[String] {
        &self.overrides
    }

    /// True when the repository's own config defines a merge driver (see the field docs).
    pub fn defines_merge_driver(&self) -> bool {
        self.repo_merge_driver
    }

    /// A hardened command running at the top level with this repository's neutralizations.
    pub(crate) fn cmd<'g>(&self, git: &'g Git) -> crate::runner::Cmd<'g> {
        git.cmd()
            .configs(self.overrides.iter().cloned())
            .current_dir(&self.toplevel)
    }

    /// Maps a top-level-relative path from git output to a workspace-relative path. `None`
    /// when it lies outside the workspace or isn't a valid [`RelPath`].
    pub fn to_workspace_rel(&self, repo_path: &str) -> Option<RelPath> {
        let rest = if self.prefix.is_empty() {
            repo_path
        } else {
            repo_path
                .strip_prefix(self.prefix.as_str())
                .and_then(|rest| rest.strip_prefix('/'))?
        };
        RelPath::parse(rest).ok()
    }

    /// Top-level-relative form of a workspace-relative path.
    pub fn to_repo_path(&self, rel: &RelPath) -> String {
        if self.prefix.is_empty() {
            rel.as_str().to_owned()
        } else {
            format!("{}/{}", self.prefix, rel.as_str())
        }
    }

    /// Pathspecs limiting a command to the workspace (none when it is the whole repository).
    pub fn scope_pathspec(&self) -> Option<String> {
        (!self.prefix.is_empty()).then(|| format!(":(top,literal){}", self.prefix))
    }

    /// A literal, top-anchored pathspec for one workspace file.
    pub fn file_pathspec(&self, rel: &RelPath) -> String {
        format!(":(top,literal){}", self.to_repo_path(rel))
    }
}

/// Filter drivers (`filter.<name>.clean/smudge/process`) run arbitrary commands during status,
/// diff and checkout. Drivers the user configured globally (for example large-file storage)
/// are the user's own choice; drivers defined or redefined by the **repository's** config
/// (`local` / `worktree` scope, including files it includes) are neutralized for KalCode's
/// operations. Reading the configuration executes nothing. Also reports whether the repository's
/// config defines a merge driver (`merge.<name>.driver`), which merge predictions must not run.
pub(crate) fn repository_filter_overrides(
    git: &Git,
    toplevel: &Path,
) -> Result<(Vec<String>, bool)> {
    let out = git
        .cmd()
        .current_dir(toplevel)
        .args(["config", "--list", "--show-scope", "--includes", "-z"])
        .read_only()
        .max_stdout(4 * 1024 * 1024)
        .run_ok("discover")?;
    let mut drivers: Vec<String> = Vec::new();
    let mut merge_driver = false;
    for (scope, key) in parse_config_list(&out.stdout) {
        if scope != "local" && scope != "worktree" {
            continue;
        }
        let lower = key.to_ascii_lowercase();
        if lower.starts_with("merge.") && lower.ends_with(".driver") {
            merge_driver = true;
            continue;
        }
        let Some(rest) = key.strip_prefix("filter.") else {
            continue;
        };
        let Some((name, _var)) = rest.rsplit_once('.') else {
            continue;
        };
        if name.is_empty() || name.contains('=') || name.chars().any(char::is_control) {
            return Err(git_error(
                "repository_config_unsafe",
                "This repository's Git configuration defines a filter KalCode can't safely disable.",
            ));
        }
        if !drivers.iter().any(|d| d == name) {
            drivers.push(name.to_owned());
        }
    }
    let mut overrides = Vec::new();
    for name in drivers {
        overrides.push(format!("filter.{name}.clean="));
        overrides.push(format!("filter.{name}.smudge="));
        overrides.push(format!("filter.{name}.process="));
        overrides.push(format!("filter.{name}.required=false"));
    }
    Ok((overrides, merge_driver))
}

/// Parses `git config --list --show-scope -z`: records of `scope\0key\nvalue\0` or `scope\0key\0`.
fn parse_config_list(bytes: &[u8]) -> Vec<(String, String)> {
    let mut fields = bytes.split(|b| *b == 0);
    let mut entries = Vec::new();
    while let (Some(scope), Some(entry)) = (fields.next(), fields.next()) {
        if scope.is_empty() {
            break;
        }
        let entry = String::from_utf8_lossy(entry);
        let key = entry.split('\n').next().unwrap_or_default().to_owned();
        entries.push((String::from_utf8_lossy(scope).into_owned(), key));
    }
    entries
}

/// A revision KalCode may pass to git: a commit id, branch, tag or simple relative form
/// (`HEAD~2`, `main^`, `@{upstream}`). Never an option, a range or a `rev:path` form.
pub fn validate_revision(rev: &str) -> Result<()> {
    let ok = !rev.is_empty()
        && rev.len() <= 200
        && !rev.starts_with('-')
        && !rev.contains("..")
        && rev.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, '.' | '_' | '/' | '~' | '^' | '@' | '{' | '}' | '-')
        });
    if ok {
        Ok(())
    } else {
        Err(KalError::validation(
            "invalid_revision",
            "That commit or branch name isn't valid.",
        ))
    }
}

/// A new branch name: a conservative subset of `git check-ref-format --branch`.
pub fn validate_branch_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 200
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && name != "@"
        && name != "HEAD"
        && !name
            .split('/')
            .any(|part| part.starts_with('.') || part.ends_with(".lock"))
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'));
    if ok {
        Ok(())
    } else {
        Err(KalError::validation(
            "invalid_branch_name",
            "That branch name isn't valid.",
        ))
    }
}

/// True for a full hexadecimal object id (SHA-1 or SHA-256).
pub fn is_object_id(oid: &str) -> bool {
    (oid.len() == 40 || oid.len() == 64) && oid.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_scoped_config_listing() {
        let raw = b"system\0filter.lfs.clean\ngit-lfs clean -- %f\0local\0filter.evil.clean\nsh -c x\0local\0core.bare\nfalse\0worktree\0filter.a.b.smudge\ny\0local\0flag\0";
        let entries = parse_config_list(raw);
        assert_eq!(entries.len(), 5);
        assert_eq!(entries[1], ("local".into(), "filter.evil.clean".into()));
        assert_eq!(entries[4], ("local".into(), "flag".into()));
    }

    #[test]
    fn revisions_reject_options_ranges_and_paths() {
        for ok in [
            "HEAD",
            "main",
            "origin/main",
            "HEAD~2",
            "v1.0^",
            "@{upstream}",
            "0123abcd",
        ] {
            assert!(validate_revision(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "--output=/tmp/x",
            "-p",
            "a..b",
            "HEAD:secret.txt",
            "a b",
            "$(x)",
            "a;b",
        ] {
            assert!(validate_revision(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn branch_names_follow_ref_rules() {
        for ok in ["feature/x", "kalcode/task-1", "fix_2"] {
            assert!(validate_branch_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "", "-b", "/x", "x/", "a..b", "x.lock", "a//b", "a@{b", "HEAD", ".hidden", "a/.b",
            "a b", "a~1", "a^", "a:b",
        ] {
            assert!(validate_branch_name(bad).is_err(), "{bad}");
        }
    }
}
