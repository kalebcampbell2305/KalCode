//! Snapshotting a workspace into its shadow repository.
//!
//! KalCode walks the workspace itself (the same ignore-aware walker as the file index: Git's
//! ignore rules, `.git` never entered, **links never followed**) instead of `git add`, for two
//! reasons found while measuring Z6a:
//!
//! * **Containment.** Git for Windows follows directory junctions during `add`, so a junction in
//!   the workspace would pull files from outside it into a checkpoint. The walker never follows
//!   links; on Windows links are skipped entirely, on POSIX a symlink is stored as a link.
//! * **Speed.** Writing one loose object per file costs ~7 ms on Windows (real-time scanning of
//!   every new file), so 1,000 changed files took 8 s. New content is instead streamed through
//!   `git fast-import` into **one packfile per snapshot**.
//!
//! A stat manifest (`kalcode-manifest`: object id, mode, size, mtime per path) lets unchanged
//! files reuse their object id without being read. Files modified within two seconds of the
//! snapshot are always re-read and never cached ("racy" files), as Git itself does.
//! The tree is built in a temporary index (`update-index --index-info`, `write-tree`).

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ignore::WalkState;

use kalcode_core::Result;

use crate::index::walker;
use crate::paths::{RelPath, WorkspaceRoot, plain};
use crate::repo::is_object_id;
use crate::runner::{Git, git_error};

pub(crate) const MANIFEST: &str = "kalcode-manifest";
const RACY: Duration = Duration::from_secs(2);
/// Repack when this many packs have accumulated (one per snapshot with new content).
const MAX_PACKS: usize = 48;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Cached {
    oid: String,
    mode: u32,
    size: u64,
    mtime_ns: i128,
}

#[derive(Debug, Clone)]
struct Found {
    rel: String,
    mode: u32,
    size: u64,
    mtime_ns: Option<i128>,
}

/// The result of one snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub tree: String,
    pub files: u32,
    /// Workspace-relative paths of files over the size limit (not snapshotted).
    pub large: Vec<String>,
    /// Links that were not snapshotted (Windows).
    pub skipped_links: u32,
    /// Files that vanished or couldn't be read while snapshotting.
    pub unreadable: u32,
}

fn mtime_ns(meta: &std::fs::Metadata) -> Option<i128> {
    let modified = meta.modified().ok()?;
    let since = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(since.as_nanos() as i128)
}

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
    false
}

fn load_manifest(path: &Path) -> HashMap<String, Cached> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    text.lines()
        .filter_map(|line| {
            let mut f = line.splitn(5, '\t');
            let oid = f.next()?;
            let mode = u32::from_str_radix(f.next()?, 8).ok()?;
            let size = f.next()?.parse().ok()?;
            let mtime_ns = f.next()?.parse().ok()?;
            let rel = f.next()?;
            is_object_id(oid).then(|| {
                (
                    rel.to_owned(),
                    Cached {
                        oid: oid.to_owned(),
                        mode,
                        size,
                        mtime_ns,
                    },
                )
            })
        })
        .collect()
}

fn save_manifest(path: &Path, entries: &HashMap<String, Cached>) {
    let mut text = String::with_capacity(entries.len() * 96);
    for (rel, c) in entries {
        text.push_str(&format!(
            "{}\t{:o}\t{}\t{}\t{rel}\n",
            c.oid, c.mode, c.size, c.mtime_ns
        ));
    }
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// Walks the workspace: every non-ignored file (and, on POSIX, symlink) as a candidate.
fn walk(ws: &WorkspaceRoot, large_limit: u64) -> (Vec<Found>, Vec<String>, u32) {
    let root = plain(ws.path());
    let (tx, rx) = mpsc::channel::<std::result::Result<Found, (String, bool)>>();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get().min(8));
    walker(&root, None)
        .threads(threads)
        .build_parallel()
        .run(|| {
            let tx = tx.clone();
            let root = root.clone();
            Box::new(move |entry| {
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                let Some(file_type) = entry.file_type() else {
                    return WalkState::Continue;
                };
                if file_type.is_dir() {
                    return WalkState::Continue;
                }
                let Some(rel) = relative(&root, entry.path()) else {
                    return WalkState::Continue;
                };
                let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                    return WalkState::Continue;
                };
                let found = if meta.file_type().is_symlink() {
                    if cfg!(windows) {
                        Err((rel, false))
                    } else {
                        Ok(Found {
                            rel,
                            mode: 0o120000,
                            size: meta.len(),
                            mtime_ns: mtime_ns(&meta),
                        })
                    }
                } else if !meta.is_file() {
                    return WalkState::Continue;
                } else if meta.len() > large_limit {
                    Err((rel, true))
                } else {
                    Ok(Found {
                        rel,
                        mode: if is_executable(&meta) {
                            0o100755
                        } else {
                            0o100644
                        },
                        size: meta.len(),
                        mtime_ns: mtime_ns(&meta),
                    })
                };
                let _ = tx.send(found);
                WalkState::Continue
            })
        });
    drop(tx);
    let mut files = Vec::new();
    let mut large = Vec::new();
    let mut links = 0u32;
    for item in rx {
        match item {
            Ok(found) => files.push(found),
            Err((rel, true)) => large.push(rel),
            Err((_, false)) => links += 1,
        }
    }
    large.sort();
    (files, large, links)
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    let rest = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in rest.components() {
        parts.push(component.as_os_str().to_str()?);
    }
    let rel = parts.join("/");
    RelPath::parse(&rel).ok().map(|_| rel)
}

/// Snapshots the workspace into the shadow repository and returns the tree.
pub(crate) fn snapshot(
    git: &Git,
    ws: &WorkspaceRoot,
    shadow: &Path,
    large_limit: u64,
) -> Result<Snapshot> {
    let started = SystemTime::now();
    let racy_after = started
        .checked_sub(RACY)
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos() as i128);
    let manifest_path = shadow.join(MANIFEST);
    let manifest = load_manifest(&manifest_path);
    let (mut files, large, skipped_links) = walk(ws, large_limit);
    files.sort_by(|a, b| a.rel.cmp(&b.rel));

    // Reuse cached object ids for files whose stat data is unchanged and not racy.
    let mut oids: Vec<Option<String>> = Vec::with_capacity(files.len());
    let mut to_hash: Vec<usize> = Vec::new();
    for (i, f) in files.iter().enumerate() {
        let cached = manifest.get(&f.rel).filter(|c| {
            f.mtime_ns
                .is_some_and(|m| m == c.mtime_ns && m < racy_after)
                && c.size == f.size
                && c.mode == f.mode
        });
        match cached {
            Some(c) => oids.push(Some(c.oid.clone())),
            None => {
                oids.push(None);
                to_hash.push(i);
            }
        }
    }

    if !to_hash.is_empty() {
        let hashed = import_blobs(git, ws, shadow, &files, &to_hash, large_limit)?;
        for (i, oid) in hashed {
            oids[i] = Some(oid);
        }
        repack_if_needed(git, shadow);
    }

    // Build the tree in a temporary index.
    let mut info = Vec::with_capacity(files.len() * 80);
    let mut unreadable = 0u32;
    let mut next_manifest = HashMap::with_capacity(files.len());
    let mut count = 0u32;
    for (f, oid) in files.iter().zip(&oids) {
        let Some(oid) = oid else {
            unreadable += 1;
            continue;
        };
        info.extend_from_slice(format!("{:o} {oid}\t{}\0", f.mode, f.rel).as_bytes());
        count += 1;
        if let Some(m) = f.mtime_ns.filter(|m| *m < racy_after) {
            next_manifest.insert(
                f.rel.clone(),
                Cached {
                    oid: oid.clone(),
                    mode: f.mode,
                    size: f.size,
                    mtime_ns: m,
                },
            );
        }
    }
    let index = shadow.join("kalcode-snapshot.index");
    let _ = std::fs::remove_file(&index);
    let tree = (|| {
        git.cmd()
            .git_dir(shadow, None)
            .env("GIT_INDEX_FILE", index.as_os_str())
            .args(["update-index", "--add", "-z", "--index-info"])
            .stdin(info)
            .timeout(Duration::from_secs(600))
            .run_ok("checkpoint")?;
        let out = git
            .cmd()
            .git_dir(shadow, None)
            .env("GIT_INDEX_FILE", index.as_os_str())
            .arg("write-tree")
            .run_ok("checkpoint")?;
        Ok::<_, kalcode_core::KalError>(out.stdout_text().trim().to_owned())
    })();
    let _ = std::fs::remove_file(&index);
    let tree = tree?;
    if !is_object_id(&tree) {
        return Err(git_error(
            "checkpoint_failed",
            "Git didn't return a snapshot.",
        ));
    }
    save_manifest(&manifest_path, &next_manifest);
    if unreadable > 0 {
        tracing::warn!(event = "checkpoint.files_unreadable", count = unreadable);
    }
    Ok(Snapshot {
        tree,
        files: count,
        large,
        skipped_links,
        unreadable,
    })
}

/// Streams the contents of `files[to_hash]` into one pack with `git fast-import` and returns
/// `(file index, object id)` for every file that could be read.
fn import_blobs(
    git: &Git,
    ws: &WorkspaceRoot,
    shadow: &Path,
    files: &[Found],
    to_hash: &[usize],
    large_limit: u64,
) -> Result<Vec<(usize, String)>> {
    let marks = shadow.join(format!("kalcode-marks-{}", uuid::Uuid::new_v4()));
    let root = ws.path().to_path_buf();
    let workspace = ws.clone();
    let jobs: Vec<(usize, Option<RelPath>, bool)> = to_hash
        .iter()
        .map(|&i| {
            let f = &files[i];
            (i, RelPath::parse(&f.rel).ok(), f.mode == 0o120000)
        })
        .collect();
    let writer = Box::new(move |pipe: &mut dyn Write| -> std::io::Result<()> {
        for (i, rel, link) in jobs {
            let Some(rel) = rel else {
                continue;
            };
            let content = if link {
                // The link's own target text is stored; the link is never followed.
                match std::fs::read_link(rel.to_native(&root)) {
                    Ok(target) => target.to_string_lossy().replace('\\', "/").into_bytes(),
                    Err(_) => continue,
                }
            } else {
                match read_capped(&workspace, &rel, large_limit) {
                    Some(bytes) => bytes,
                    None => continue,
                }
            };
            write!(pipe, "blob\nmark :{}\ndata {}\n", i + 1, content.len())?;
            pipe.write_all(&content)?;
            pipe.write_all(b"\n")?;
        }
        pipe.write_all(b"done\n")
    });
    let mut export = std::ffi::OsString::from("--export-marks=");
    export.push(plain(&marks).as_os_str());
    let result = git
        .cmd()
        .git_dir(shadow, None)
        .configs(["fastimport.unpackLimit=0".to_owned()])
        .args(["fast-import", "--quiet", "--done"])
        .arg(export)
        .stdin_stream(writer)
        .timeout(Duration::from_secs(1800))
        .run_ok("checkpoint");
    let text = std::fs::read_to_string(&marks).unwrap_or_default();
    let _ = std::fs::remove_file(&marks);
    result?;
    Ok(text
        .lines()
        .filter_map(|line| {
            let (mark, oid) = line.split_once(' ')?;
            let index: usize = mark.strip_prefix(':')?.parse().ok()?;
            (index > 0 && is_object_id(oid)).then(|| (index - 1, oid.to_owned()))
        })
        .collect())
}

/// Reads a file that must still be within the size limit (it may have grown since the walk).
/// Open-then-verify ([`WorkspaceRoot::open_verified`]): a file swapped for a link to somewhere
/// outside the workspace after the walk is refused (skipped like any unreadable file), so
/// outside content never enters a checkpoint.
fn read_capped(ws: &WorkspaceRoot, rel: &RelPath, limit: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    let file = ws.open_verified(rel).ok()?.file;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

fn repack_if_needed(git: &Git, shadow: &Path) {
    let packs = std::fs::read_dir(shadow.join("objects").join("pack"))
        .map(|dir| {
            dir.filter_map(std::result::Result::ok)
                .filter(|e| e.path().extension().is_some_and(|x| x == "pack"))
                .count()
        })
        .unwrap_or(0);
    if packs > MAX_PACKS {
        let result = git
            .cmd()
            .git_dir(shadow, None)
            // Keep unreachable objects: this snapshot's new blobs aren't referenced by any ref
            // until its checkpoint is written, and `-a -d` alone would delete them.
            .args(["repack", "-a", "-d", "--keep-unreachable", "-q"])
            .timeout(Duration::from_secs(1800))
            .run_ok("checkpoint");
        if let Err(error) = result {
            tracing::warn!(event = "checkpoint.repack_failed", error_code = error.code);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_round_trips_and_skips_garbage() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(MANIFEST);
        let mut entries = HashMap::new();
        entries.insert(
            "a b/c.txt".to_owned(),
            Cached {
                oid: "a".repeat(40),
                mode: 0o100644,
                size: 3,
                mtime_ns: 1_700_000_000_000_000_000,
            },
        );
        save_manifest(&path, &entries);
        assert_eq!(load_manifest(&path), entries);
        std::fs::write(&path, "garbage\nnot\tan\tentry\n").expect("write");
        assert!(load_manifest(&path).is_empty());
    }
}
