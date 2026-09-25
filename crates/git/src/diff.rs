//! `git diff`: file list with numstat, and unified hunks with old/new line numbers.
//!
//! Destructiveness: **read-only**. External diff drivers and text conversion filters are always
//! disabled (`--no-ext-diff --no-textconv`); prefixes, rename detection and relative mode are
//! fixed on the command line so user configuration cannot change the output shape.

use serde::{Deserialize, Serialize};

use kalcode_core::{KalError, Result};

use crate::handles::HandleRegistry;
use crate::paths::RelPath;
use crate::repo::{Repo, validate_revision};
use crate::runner::{Cmd, Git};
use crate::types::{DiffFile, GitFileChange};

/// Default cap on patch text per request.
pub const DEFAULT_MAX_PATCH_BYTES: usize = 8 * 1024 * 1024;
/// Most diff lines kept per file; beyond this the file's hunks are marked truncated.
pub const MAX_LINES_PER_FILE: usize = 50_000;
/// Longest single line kept (longer lines are cut and marked).
pub const MAX_LINE_CHARS: usize = 16 * 1024;

/// What to compare.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum DiffTarget {
    /// Index → working tree (unstaged changes).
    WorkingTree,
    /// HEAD → index (staged changes).
    Staged,
    /// HEAD → working tree (everything not committed).
    Head,
    /// A commit → working tree.
    Base { base: String },
    /// Commit → commit.
    Commits { from: String, to: String },
}

impl DiffTarget {
    fn args(&self) -> Result<Vec<String>> {
        Ok(match self {
            Self::WorkingTree => vec![],
            Self::Staged => vec!["--cached".into()],
            Self::Head => vec!["HEAD".into()],
            Self::Base { base } => {
                validate_revision(base)?;
                vec![base.clone()]
            }
            Self::Commits { from, to } => {
                validate_revision(from)?;
                validate_revision(to)?;
                vec![from.clone(), to.clone()]
            }
        })
    }

    fn has_revisions(&self) -> bool {
        matches!(self, Self::Head | Self::Base { .. } | Self::Commits { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffOptions {
    pub context_lines: u32,
    pub max_patch_bytes: usize,
    /// Include hunks (false = file list and counts only).
    pub patch: bool,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            context_lines: 3,
            max_patch_bytes: DEFAULT_MAX_PATCH_BYTES,
            patch: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    Context,
    Add,
    Delete,
    /// `\ No newline at end of file`.
    NoNewline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// The `@@ -a,b +c,d @@ section` line.
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

/// A file with its hunks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    #[serde(flatten)]
    pub meta: DiffFile,
    pub hunks: Vec<Hunk>,
    /// Some hunks or lines of this file were left out (size caps).
    pub hunks_truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub files: Vec<FileDiff>,
    /// The patch exceeded the byte cap; files after the cut have no hunks.
    pub truncated: bool,
}

/// One raw + numstat record, paths relative to the repository top level.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub change: GitFileChange,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

/// Diffs the workspace's repository. `files` limits the diff to those workspace files.
pub fn diff(
    git: &Git,
    repo: &Repo,
    target: &DiffTarget,
    files: &[RelPath],
    options: &DiffOptions,
    handles: &HandleRegistry,
) -> Result<Diff> {
    let mut pathspecs: Vec<String> = files.iter().map(|f| repo.file_pathspec(f)).collect();
    if pathspecs.is_empty()
        && let Some(scope) = repo.scope_pathspec()
    {
        pathspecs.push(scope);
    }
    let raw = run_diff(|| repo.cmd(git), target, &pathspecs, options)?;
    Ok(raw.into_view(repo.workspace().id(), handles, |p| repo.to_workspace_rel(p)))
}

/// Result before paths are mapped to the workspace.
pub(crate) struct RawDiff {
    pub entries: Vec<RawEntry>,
    pub patches: Vec<ParsedFile>,
    pub truncated: bool,
}

impl RawDiff {
    pub(crate) fn into_view(
        self,
        workspace_id: &str,
        handles: &HandleRegistry,
        map: impl Fn(&str) -> Option<RelPath>,
    ) -> Diff {
        let mut patches = self.patches.into_iter();
        let files = self
            .entries
            .into_iter()
            .map(|entry| {
                let parsed = patches.next().unwrap_or_default();
                let rel = map(&entry.path);
                FileDiff {
                    meta: DiffFile {
                        file: rel
                            .as_ref()
                            .map(|r| handles.issue_unchecked(workspace_id, r)),
                        path: rel
                            .as_ref()
                            .map_or_else(|| entry.path.clone(), |r| r.as_str().to_owned()),
                        old_path: entry
                            .old_path
                            .map(|old| map(&old).map_or(old, |r| r.as_str().to_owned())),
                        change: entry.change,
                        additions: entry.additions,
                        deletions: entry.deletions,
                        binary: entry.binary,
                    },
                    hunks: parsed.hunks,
                    hunks_truncated: parsed.truncated,
                }
            })
            .collect();
        Diff {
            files,
            truncated: self.truncated,
        }
    }
}

/// Runs the metadata pass and (optionally) the patch pass with commands from `make`.
pub(crate) fn run_diff<'g>(
    make: impl Fn() -> Cmd<'g>,
    target: &DiffTarget,
    pathspecs: &[String],
    options: &DiffOptions,
) -> Result<RawDiff> {
    let target_args = target.args()?;
    let fixed = [
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        "--ignore-submodules=dirty",
        "--find-renames",
        "--no-color",
    ];
    let with_target = |cmd: Cmd<'g>| {
        let cmd = if target.has_revisions() {
            cmd.arg("--end-of-options")
        } else {
            cmd
        };
        let cmd = cmd.args(target_args.iter().cloned()).arg("--");
        cmd.args(pathspecs.iter().cloned())
    };

    let meta_cmd = make()
        .arg("diff")
        .args(fixed)
        .args(["--raw", "--numstat", "-z", "--no-abbrev"]);
    let meta = with_target(meta_cmd).read_only().run_ok("diff")?;
    let entries = parse_raw_numstat(&meta.stdout);
    let mut truncated = meta.truncated;

    let patches = if options.patch && !entries.is_empty() {
        let context = format!("-U{}", options.context_lines.min(1000));
        let patch_cmd = make()
            .arg("diff")
            .args(fixed)
            .args(["-p", "--src-prefix=a/", "--dst-prefix=b/"])
            .arg(context);
        let out = with_target(patch_cmd)
            .max_stdout(options.max_patch_bytes)
            .read_only()
            .run_ok("diff")?;
        truncated |= out.truncated;
        parse_patch(&out.stdout)
    } else {
        Vec::new()
    };
    Ok(RawDiff {
        entries,
        patches,
        truncated,
    })
}

fn raw_change(status: &str) -> GitFileChange {
    match status.chars().next() {
        Some('A') => GitFileChange::Added,
        Some('D') => GitFileChange::Deleted,
        Some('R') => GitFileChange::Renamed,
        Some('C') => GitFileChange::Copied,
        Some('T') => GitFileChange::TypeChanged,
        Some('U') => GitFileChange::Unmerged,
        _ => GitFileChange::Modified,
    }
}

/// Parses `git diff --raw --numstat -z` (raw records first, then numstat records, same order).
pub(crate) fn parse_raw_numstat(bytes: &[u8]) -> Vec<RawEntry> {
    let text = String::from_utf8_lossy(bytes);
    let mut fields = text.split('\0').peekable();
    let mut entries: Vec<RawEntry> = Vec::new();
    let mut stats: Vec<(Option<u32>, Option<u32>)> = Vec::new();
    while let Some(field) = fields.next() {
        if field.is_empty() {
            continue;
        }
        if let Some(meta) = field.strip_prefix(':') {
            let status = meta.rsplit(' ').next().unwrap_or("M");
            let change = raw_change(status);
            let first = fields.next().unwrap_or_default().to_owned();
            let (path, old_path) =
                if matches!(change, GitFileChange::Renamed | GitFileChange::Copied) {
                    let second = fields.next().unwrap_or_default().to_owned();
                    (second, Some(first))
                } else {
                    (first, None)
                };
            entries.push(RawEntry {
                path,
                old_path,
                change,
                additions: 0,
                deletions: 0,
                binary: false,
            });
        } else {
            // numstat: `add\tdel\tpath` or, for renames, `add\tdel\t` followed by two paths.
            let mut parts = field.splitn(3, '\t');
            let add = parts.next().and_then(|a| a.parse::<u32>().ok());
            let del = parts.next().and_then(|d| d.parse::<u32>().ok());
            if parts.next().is_some_and(str::is_empty) {
                fields.next();
                fields.next();
            }
            stats.push((add, del));
        }
    }
    for (entry, (add, del)) in entries.iter_mut().zip(stats) {
        match (add, del) {
            (Some(a), Some(d)) => {
                entry.additions = a;
                entry.deletions = d;
            }
            _ => entry.binary = true,
        }
    }
    entries
}

/// Hunks of one file section of a patch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ParsedFile {
    pub hunks: Vec<Hunk>,
    pub truncated: bool,
}

/// Parses unified diff output into per-file hunks, in output order.
pub(crate) fn parse_patch(bytes: &[u8]) -> Vec<ParsedFile> {
    let mut files: Vec<ParsedFile> = Vec::new();
    let mut in_hunk = false;
    let (mut old_no, mut new_no) = (0u32, 0u32);
    let mut lines_in_file = 0usize;
    for raw in bytes.split(|b| *b == b'\n') {
        if raw.starts_with(b"diff --git ") || raw.starts_with(b"diff --cc ") {
            files.push(ParsedFile::default());
            in_hunk = false;
            lines_in_file = 0;
            continue;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };
        if raw.starts_with(b"@@ ") {
            let header = String::from_utf8_lossy(raw)
                .trim_end_matches('\r')
                .to_owned();
            match parse_hunk_header(&header) {
                Some((os, ol, ns, nl)) => {
                    old_no = os;
                    new_no = ns;
                    in_hunk = true;
                    if file.truncated {
                        continue;
                    }
                    file.hunks.push(Hunk {
                        header,
                        old_start: os,
                        old_lines: ol,
                        new_start: ns,
                        new_lines: nl,
                        lines: Vec::new(),
                    });
                }
                None => in_hunk = false,
            }
            continue;
        }
        if !in_hunk || raw.is_empty() {
            continue;
        }
        let (kind, old_line, new_line) = match raw[0] {
            b' ' => {
                let r = (LineKind::Context, Some(old_no), Some(new_no));
                old_no += 1;
                new_no += 1;
                r
            }
            b'+' => {
                let r = (LineKind::Add, None, Some(new_no));
                new_no += 1;
                r
            }
            b'-' => {
                let r = (LineKind::Delete, Some(old_no), None);
                old_no += 1;
                r
            }
            b'\\' => (LineKind::NoNewline, None, None),
            _ => {
                in_hunk = false;
                continue;
            }
        };
        if file.truncated {
            continue;
        }
        lines_in_file += 1;
        if lines_in_file > MAX_LINES_PER_FILE {
            file.truncated = true;
            continue;
        }
        let body = &raw[1..];
        let body = body.strip_suffix(b"\r").unwrap_or(body);
        let mut text = String::from_utf8_lossy(body).into_owned();
        if kind == LineKind::NoNewline {
            text = "No newline at end of file".to_owned();
        } else if text.chars().count() > MAX_LINE_CHARS {
            text = text.chars().take(MAX_LINE_CHARS).collect::<String>() + "…";
            file.truncated = true;
        }
        if let Some(hunk) = file.hunks.last_mut() {
            hunk.lines.push(DiffLine {
                kind,
                old_line,
                new_line,
                text,
            });
        }
    }
    files
}

/// `@@ -a[,b] +c[,d] @@…` → (a, b, c, d).
fn parse_hunk_header(header: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = header.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let range = |r: &str| -> Option<(u32, u32)> {
        match r.split_once(',') {
            Some((start, len)) => Some((start.parse().ok()?, len.parse().ok()?)),
            None => Some((r.parse().ok()?, 1)),
        }
    };
    let (os, ol) = range(old)?;
    let (ns, nl) = range(new)?;
    Some((os, ol, ns, nl))
}

/// Resolves handles for a diff request's `file` filter.
pub fn files_from_handles(
    handles: &HandleRegistry,
    workspace_id: &str,
    requested: &[crate::types::FileHandle],
) -> Result<Vec<RelPath>> {
    if requested.len() > 500 {
        return Err(KalError::validation(
            "too_many_files",
            "Too many files were requested.",
        ));
    }
    requested
        .iter()
        .map(|handle| handles.rel_path(workspace_id, handle))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_and_numstat_combine_in_order() {
        let raw = concat!(
            ":100644 100644 aaaa bbbb M\0src/a.rs\0",
            ":000000 100644 0000 cccc A\0new file.txt\0",
            ":100644 100644 dddd eeee R087\0old.txt\0renamed.txt\0",
            ":100644 100644 ffff 1111 M\0logo.png\0",
            "3\t1\tsrc/a.rs\0",
            "10\t0\tnew file.txt\0",
            "1\t1\t\0old.txt\0renamed.txt\0",
            "-\t-\tlogo.png\0",
        );
        let entries = parse_raw_numstat(raw.as_bytes());
        assert_eq!(entries.len(), 4);
        assert_eq!((entries[0].additions, entries[0].deletions), (3, 1));
        assert_eq!(entries[1].change, GitFileChange::Added);
        assert_eq!(entries[1].path, "new file.txt");
        assert_eq!(entries[2].change, GitFileChange::Renamed);
        assert_eq!(entries[2].path, "renamed.txt");
        assert_eq!(entries[2].old_path.as_deref(), Some("old.txt"));
        assert_eq!((entries[2].additions, entries[2].deletions), (1, 1));
        assert!(entries[3].binary);
    }

    #[test]
    fn hunks_carry_line_numbers() {
        let patch = concat!(
            "diff --git a/f.txt b/f.txt\n",
            "index 1..2 100644\n",
            "--- a/f.txt\n",
            "+++ b/f.txt\n",
            "@@ -1,3 +1,3 @@ fn main\n",
            " one\n",
            "-two\n",
            "+TWO\r\n",
            " three\n",
            "\\ No newline at end of file\n",
            "diff --git a/bin.png b/bin.png\n",
            "Binary files a/bin.png and b/bin.png differ\n",
            "diff --git a/x b/x\n",
            "@@ -10 +10,2 @@\n",
            " ten\n",
            "+eleven\n",
        );
        let files = parse_patch(patch.as_bytes());
        assert_eq!(files.len(), 3);
        let hunk = &files[0].hunks[0];
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_lines,
                hunk.new_start,
                hunk.new_lines
            ),
            (1, 3, 1, 3)
        );
        assert_eq!(hunk.lines[1].kind, LineKind::Delete);
        assert_eq!(hunk.lines[1].old_line, Some(2));
        assert_eq!(hunk.lines[2].kind, LineKind::Add);
        assert_eq!(hunk.lines[2].new_line, Some(2));
        assert_eq!(hunk.lines[2].text, "TWO");
        assert_eq!(hunk.lines[3].old_line, Some(3));
        assert_eq!(hunk.lines[4].kind, LineKind::NoNewline);
        assert!(files[1].hunks.is_empty());
        let single = &files[2].hunks[0];
        assert_eq!((single.old_start, single.old_lines), (10, 1));
        assert_eq!(single.lines[1].new_line, Some(11));
    }

    #[test]
    fn target_revisions_are_validated() {
        let bad = DiffTarget::Base {
            base: "--output=/tmp/x".into(),
        };
        assert!(bad.args().is_err());
        let range = DiffTarget::Commits {
            from: "a..b".into(),
            to: "HEAD".into(),
        };
        assert!(range.args().is_err());
    }
}
