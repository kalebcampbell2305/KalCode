//! Commit history (paged) and branches.
//!
//! Destructiveness: **read-only**.

use kalcode_core::{KalError, Result};

use crate::repo::{Repo, is_object_id, validate_revision};
use crate::runner::Git;
pub use crate::types::{Branch, BranchKind, Commit};
use crate::types::{MAX_PAGE, Page};

/// A page of history. The cursor pins the starting commit, so pages stay stable while new
/// commits arrive: `<start-oid>:<offset>`.
pub fn log(
    git: &Git,
    repo: &Repo,
    rev: Option<&str>,
    limit: u32,
    cursor: Option<&str>,
) -> Result<Page<Commit>> {
    if limit == 0 || limit > MAX_PAGE {
        return Err(KalError::validation(
            "invalid_page",
            "Page size must be between 1 and 500.",
        ));
    }
    let (start, offset) = match cursor {
        Some(cursor) => parse_cursor(cursor)?,
        None => {
            let rev = rev.unwrap_or("HEAD");
            validate_revision(rev)?;
            let out = repo
                .cmd(git)
                .args(["rev-parse", "--verify", "--quiet", "--end-of-options"])
                .arg(format!("{rev}^{{commit}}"))
                .read_only()
                .run()?;
            if !out.status.success() {
                // No commits yet (or an unknown revision): an empty history, not an error.
                return Ok(Page {
                    items: Vec::new(),
                    next_cursor: None,
                    total_estimate: Some(0),
                });
            }
            (out.stdout_text().trim().to_owned(), 0)
        }
    };
    let mut cmd = repo.cmd(git).args([
        "log",
        "--no-color",
        "--no-show-signature",
        "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1e",
    ]);
    cmd = cmd
        .arg(format!("--skip={offset}"))
        .arg(format!("--max-count={}", limit + 1))
        .arg("--end-of-options")
        .arg(&start)
        .arg("--");
    if let Some(scope) = repo.scope_pathspec() {
        cmd = cmd.arg(scope);
    }
    let out = cmd.read_only().run_ok("log")?;
    let mut items = parse_log(&out.stdout);
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    Ok(Page {
        next_cursor: more.then(|| format!("{start}:{}", offset + limit as usize)),
        items,
        total_estimate: None,
    })
}

fn parse_cursor(cursor: &str) -> Result<(String, usize)> {
    let invalid = || KalError::validation("invalid_cursor", "That page cursor isn't valid.");
    let (oid, offset) = cursor.split_once(':').ok_or_else(invalid)?;
    if !is_object_id(oid) {
        return Err(invalid());
    }
    Ok((oid.to_owned(), offset.parse().map_err(|_| invalid())?))
}

fn parse_log(bytes: &[u8]) -> Vec<Commit> {
    String::from_utf8_lossy(bytes)
        .split('\x1e')
        .filter_map(|record| {
            let record = record.trim_start_matches(['\n', '\r']);
            let f: Vec<&str> = record.splitn(7, '\x1f').collect();
            let [oid, parents, an, ae, ad, cd, subject] = f.as_slice() else {
                return None;
            };
            Some(Commit {
                oid: (*oid).to_owned(),
                parents: parents
                    .split(' ')
                    .filter(|p| !p.is_empty())
                    .map(str::to_owned)
                    .collect(),
                author_name: (*an).to_owned(),
                author_email: (*ae).to_owned(),
                authored_at: (*ad).to_owned(),
                committed_at: (*cd).to_owned(),
                subject: (*subject).to_owned(),
            })
        })
        .collect()
}

/// Local and remote-tracking branches (at most 5,000).
pub fn branches(git: &Git, repo: &Repo) -> Result<Vec<Branch>> {
    let out = repo
        .cmd(git)
        .args([
            "for-each-ref",
            "--count=5000",
            "--format=%(refname)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track,nobracket)%1f%(HEAD)%1e",
            "refs/heads",
            "refs/remotes",
        ])
        .read_only()
        .run_ok("branches")?;
    Ok(parse_branches(&out.stdout))
}

fn parse_branches(bytes: &[u8]) -> Vec<Branch> {
    String::from_utf8_lossy(bytes)
        .split('\x1e')
        .filter_map(|record| {
            let record = record.trim_start_matches(['\n', '\r']);
            let f: Vec<&str> = record.splitn(5, '\x1f').collect();
            let [refname, oid, upstream, track, head] = f.as_slice() else {
                return None;
            };
            let (kind, name) = if let Some(n) = refname.strip_prefix("refs/heads/") {
                (BranchKind::Local, n)
            } else {
                let n = refname.strip_prefix("refs/remotes/")?;
                if n.ends_with("/HEAD") {
                    return None;
                }
                (BranchKind::Remote, n)
            };
            let (mut ahead, mut behind) = (None, None);
            for part in track.split(", ") {
                if let Some(n) = part.strip_prefix("ahead ") {
                    ahead = n.parse().ok();
                } else if let Some(n) = part.strip_prefix("behind ") {
                    behind = n.parse().ok();
                }
            }
            let has_upstream = !upstream.is_empty();
            Some(Branch {
                name: name.to_owned(),
                kind,
                oid: (*oid).to_owned(),
                upstream: has_upstream.then(|| (*upstream).to_owned()),
                ahead: if has_upstream && *track != "gone" {
                    Some(ahead.unwrap_or(0))
                } else {
                    None
                },
                behind: if has_upstream && *track != "gone" {
                    Some(behind.unwrap_or(0))
                } else {
                    None
                },
                upstream_gone: *track == "gone",
                current: head.trim() == "*",
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_records() {
        let raw = "aaa\x1fp1 p2\x1fAda\x1fada@example.com\x1f2026-01-01T00:00:00+00:00\x1f2026-01-02T00:00:00+00:00\x1fMerge: x\x1e\nbbb\x1f\x1fB\x1fb@e\x1fd\x1fd\x1fFirst\x1e\n";
        let commits = parse_log(raw.as_bytes());
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, ["p1", "p2"]);
        assert!(commits[1].parents.is_empty());
        assert_eq!(commits[1].subject, "First");
    }

    #[test]
    fn parses_branches_with_tracking() {
        let raw = "refs/heads/main\x1f111\x1forigin/main\x1fahead 2, behind 1\x1f*\x1e\nrefs/heads/old\x1f222\x1forigin/old\x1fgone\x1f \x1e\nrefs/remotes/origin/HEAD\x1f111\x1f\x1f\x1f \x1e\nrefs/remotes/origin/main\x1f111\x1f\x1f\x1f \x1e\nrefs/heads/solo\x1f333\x1f\x1f\x1f \x1e";
        let branches = parse_branches(raw.as_bytes());
        assert_eq!(branches.len(), 4);
        assert!(branches[0].current);
        assert_eq!((branches[0].ahead, branches[0].behind), (Some(2), Some(1)));
        assert!(branches[1].upstream_gone);
        assert_eq!(branches[2].kind, BranchKind::Remote);
        assert_eq!(branches[3].upstream, None);
        assert_eq!(branches[3].ahead, None);
    }

    #[test]
    fn cursors_must_pin_an_object_id() {
        assert!(parse_cursor(&format!("{}:20", "a".repeat(40))).is_ok());
        for bad in ["", "HEAD:1", "aaaa:1", &format!("{}:x", "a".repeat(40))] {
            assert!(parse_cursor(bad).is_err(), "{bad}");
        }
    }
}
