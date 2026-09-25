//! `git status` (porcelain v2, NUL-separated): branch, ahead/behind, staged and unstaged
//! changes, renames and copies, conflicts and untracked files.
//!
//! Destructiveness: **read-only**. Runs with `GIT_OPTIONAL_LOCKS=0`, so it never refreshes or
//! locks the user's index.

use serde::{Deserialize, Serialize};

use kalcode_core::Result;

use crate::handles::HandleRegistry;
use crate::repo::Repo;
use crate::runner::Git;
use crate::types::{FileRef, GitFileChange, GitStatusSummary};

/// Most status lines kept; beyond this `truncated` is set (the counts still cover everything).
pub const MAX_STATUS_ENTRIES: usize = 200_000;

/// Which side of a merge conflict changed what.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    BothDeleted,
    AddedByUs,
    DeletedByThem,
    AddedByThem,
    DeletedByUs,
    BothAdded,
    BothModified,
}

impl ConflictKind {
    fn parse(xy: &str) -> Option<Self> {
        Some(match xy {
            "DD" => Self::BothDeleted,
            "AU" => Self::AddedByUs,
            "UD" => Self::DeletedByThem,
            "UA" => Self::AddedByThem,
            "DU" => Self::DeletedByUs,
            "AA" => Self::BothAdded,
            "UU" => Self::BothModified,
            _ => return None,
        })
    }
}

/// One parsed status line (paths relative to the repository top level).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub path: String,
    pub orig_path: Option<String>,
    pub staged: Option<GitFileChange>,
    pub unstaged: Option<GitFileChange>,
    pub untracked: bool,
    pub conflict: Option<ConflictKind>,
    pub submodule: bool,
    /// Rename/copy similarity (0..=100) when git reported one.
    pub score: Option<u8>,
}

/// Branch facts from the `# branch.*` headers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchState {
    /// `None` before the first commit.
    pub head_oid: Option<String>,
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Status {
    pub branch: BranchState,
    pub entries: Vec<StatusEntry>,
    /// More lines existed than [`MAX_STATUS_ENTRIES`] or the output cap allowed.
    pub truncated: bool,
}

/// A status line as the UI receives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusFile {
    /// `None` when the file is outside the workspace or its name isn't a valid path.
    pub file: Option<FileRef>,
    /// Workspace-relative when inside the workspace, otherwise repository-relative.
    pub path: String,
    pub orig_path: Option<String>,
    pub staged: Option<GitFileChange>,
    pub unstaged: Option<GitFileChange>,
    pub untracked: bool,
    pub conflict: Option<ConflictKind>,
    pub submodule: bool,
}

/// Status for IPC: the summary plus every file (the IPC layer pages `files`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub summary: GitStatusSummary,
    pub branch: BranchState,
    pub files: Vec<StatusFile>,
    pub truncated: bool,
}

fn change(code: char) -> Option<GitFileChange> {
    Some(match code {
        'M' => GitFileChange::Modified,
        'T' => GitFileChange::TypeChanged,
        'A' => GitFileChange::Added,
        'D' => GitFileChange::Deleted,
        'R' => GitFileChange::Renamed,
        'C' => GitFileChange::Copied,
        'U' => GitFileChange::Unmerged,
        _ => return None,
    })
}

/// Parses `git status --porcelain=v2 -z --branch` output.
pub fn parse_porcelain_v2(bytes: &[u8]) -> Status {
    let mut status = Status::default();
    let mut records = bytes.split(|b| *b == 0).peekable();
    while let Some(raw) = records.next() {
        if raw.is_empty() {
            continue;
        }
        let Ok(line) = std::str::from_utf8(raw) else {
            // A non-UTF-8 path: skip it (and a rename's second path).
            if raw.first() == Some(&b'2') {
                records.next();
            }
            continue;
        };
        if let Some(header) = line.strip_prefix("# ") {
            parse_header(header, &mut status.branch);
            continue;
        }
        if status.entries.len() >= MAX_STATUS_ENTRIES {
            status.truncated = true;
            if line.starts_with('2') {
                records.next();
            }
            continue;
        }
        let mut kind = line.splitn(2, ' ');
        let (Some(tag), Some(rest)) = (kind.next(), kind.next()) else {
            continue;
        };
        match tag {
            "1" => {
                let f: Vec<&str> = rest.splitn(8, ' ').collect();
                if let [xy, sub, _, _, _, _, _, path] = f.as_slice() {
                    status.entries.push(ordinary(xy, sub, path, None, None));
                }
            }
            "2" => {
                let f: Vec<&str> = rest.splitn(9, ' ').collect();
                let orig = records.next().and_then(|o| std::str::from_utf8(o).ok());
                if let ([xy, sub, _, _, _, _, _, score, path], Some(orig)) = (f.as_slice(), orig) {
                    let score = score.get(1..).and_then(|s| s.parse::<u8>().ok());
                    status
                        .entries
                        .push(ordinary(xy, sub, path, Some(orig.to_owned()), score));
                }
            }
            "u" => {
                let f: Vec<&str> = rest.splitn(10, ' ').collect();
                if let [xy, sub, _, _, _, _, _, _, _, path] = f.as_slice() {
                    status.entries.push(StatusEntry {
                        path: (*path).to_owned(),
                        orig_path: None,
                        staged: Some(GitFileChange::Unmerged),
                        unstaged: Some(GitFileChange::Unmerged),
                        untracked: false,
                        conflict: ConflictKind::parse(xy),
                        submodule: sub.starts_with('S'),
                        score: None,
                    });
                }
            }
            "?" => status.entries.push(StatusEntry {
                path: rest.to_owned(),
                orig_path: None,
                staged: None,
                unstaged: None,
                untracked: true,
                conflict: None,
                submodule: false,
                score: None,
            }),
            _ => {} // `!` (ignored) is never requested.
        }
    }
    status
}

fn ordinary(
    xy: &str,
    sub: &str,
    path: &str,
    orig: Option<String>,
    score: Option<u8>,
) -> StatusEntry {
    let mut codes = xy.chars();
    StatusEntry {
        path: path.to_owned(),
        orig_path: orig,
        staged: codes.next().and_then(change),
        unstaged: codes.next().and_then(change),
        untracked: false,
        conflict: None,
        submodule: sub.starts_with('S'),
        score,
    }
}

fn parse_header(header: &str, branch: &mut BranchState) {
    if let Some(oid) = header.strip_prefix("branch.oid ") {
        branch.head_oid = (oid != "(initial)").then(|| oid.to_owned());
    } else if let Some(head) = header.strip_prefix("branch.head ") {
        branch.branch = (head != "(detached)").then(|| head.to_owned());
    } else if let Some(upstream) = header.strip_prefix("branch.upstream ") {
        branch.upstream = Some(upstream.to_owned());
    } else if let Some(ab) = header.strip_prefix("branch.ab ") {
        let mut parts = ab.split(' ');
        branch.ahead = parts
            .next()
            .and_then(|a| a.strip_prefix('+'))
            .and_then(|a| a.parse().ok());
        branch.behind = parts
            .next()
            .and_then(|b| b.strip_prefix('-'))
            .and_then(|b| b.parse().ok());
    }
}

/// Runs `git status` for the workspace (limited to the workspace folder when it is a
/// subfolder of the repository).
pub fn status(git: &Git, repo: &Repo) -> Result<Status> {
    let mut cmd = repo.cmd(git).args([
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
        "--ignored=no",
        "--find-renames",
        "--ignore-submodules=dirty",
    ]);
    if let Some(scope) = repo.scope_pathspec() {
        cmd = cmd.arg("--").arg(scope);
    }
    let out = cmd.read_only().run_ok("status")?;
    let mut status = parse_porcelain_v2(&out.stdout);
    status.truncated |= out.truncated;
    Ok(status)
}

impl Status {
    pub fn summary(&self, workspace_id: &str) -> GitStatusSummary {
        let untracked = self.entries.iter().filter(|e| e.untracked).count();
        GitStatusSummary {
            workspace_id: workspace_id.to_owned(),
            branch: self.branch.branch.clone(),
            head: self.branch.head_oid.clone(),
            changed: u32::try_from(self.entries.len() - untracked).unwrap_or(u32::MAX),
            untracked: u32::try_from(untracked).unwrap_or(u32::MAX),
            ahead: self.branch.ahead,
            behind: self.branch.behind,
        }
    }

    /// The UI form: workspace-relative paths with handles.
    pub fn view(&self, repo: &Repo, handles: &HandleRegistry) -> StatusView {
        let workspace_id = repo.workspace().id();
        let files = self
            .entries
            .iter()
            .map(|entry| {
                let rel = repo.to_workspace_rel(&entry.path);
                StatusFile {
                    file: rel
                        .as_ref()
                        .map(|rel| handles.issue_unchecked(workspace_id, rel)),
                    path: rel.map_or_else(|| entry.path.clone(), |r| r.as_str().to_owned()),
                    orig_path: entry.orig_path.as_ref().map(|orig| {
                        repo.to_workspace_rel(orig)
                            .map_or_else(|| orig.clone(), |r| r.as_str().to_owned())
                    }),
                    staged: entry.staged,
                    unstaged: entry.unstaged,
                    untracked: entry.untracked,
                    conflict: entry.conflict,
                    submodule: entry.submodule,
                }
            })
            .collect();
        StatusView {
            summary: self.summary(workspace_id),
            branch: self.branch.clone(),
            files,
            truncated: self.truncated,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_record_kind() {
        let raw = concat!(
            "# branch.oid 1111111111111111111111111111111111111111\0",
            "# branch.head main\0",
            "# branch.upstream origin/main\0",
            "# branch.ab +2 -1\0",
            "1 .M N... 100644 100644 100644 aaaa bbbb src/with space.rs\0",
            "1 A. N... 000000 100644 100644 0000 cccc new.txt\0",
            "2 R. N... 100644 100644 100644 dddd dddd R95 renamed.txt\0old name.txt\0",
            "u UU N... 100644 100644 100644 100644 e1 e2 e3 conflict.txt\0",
            "? untracked dir/file.txt\0",
            "1 .M S.M. 160000 160000 160000 ffff ffff vendor/sub\0",
        );
        let status = parse_porcelain_v2(raw.as_bytes());
        assert_eq!(status.branch.branch.as_deref(), Some("main"));
        assert_eq!(status.branch.upstream.as_deref(), Some("origin/main"));
        assert_eq!(
            (status.branch.ahead, status.branch.behind),
            (Some(2), Some(1))
        );
        assert_eq!(status.entries.len(), 6);
        assert_eq!(status.entries[0].path, "src/with space.rs");
        assert_eq!(status.entries[0].unstaged, Some(GitFileChange::Modified));
        assert_eq!(status.entries[0].staged, None);
        assert_eq!(status.entries[1].staged, Some(GitFileChange::Added));
        assert_eq!(status.entries[2].staged, Some(GitFileChange::Renamed));
        assert_eq!(status.entries[2].orig_path.as_deref(), Some("old name.txt"));
        assert_eq!(status.entries[2].score, Some(95));
        assert_eq!(status.entries[3].conflict, Some(ConflictKind::BothModified));
        assert!(status.entries[4].untracked);
        assert_eq!(status.entries[4].path, "untracked dir/file.txt");
        assert!(status.entries[5].submodule);
        let summary = status.summary("w");
        assert_eq!((summary.changed, summary.untracked), (5, 1));
    }

    #[test]
    fn initial_and_detached_heads() {
        let status = parse_porcelain_v2(b"# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!(status.branch.head_oid, None);
        assert_eq!(status.branch.branch, None);
    }

    #[test]
    fn skips_non_utf8_paths_without_desynchronizing() {
        let mut raw = b"2 R. N... 100644 100644 100644 d d R100 bad\xff\0old\0".to_vec();
        raw.extend_from_slice(b"? ok.txt\0");
        let status = parse_porcelain_v2(&raw);
        assert_eq!(status.entries.len(), 1);
        assert_eq!(status.entries[0].path, "ok.txt");
    }
}
