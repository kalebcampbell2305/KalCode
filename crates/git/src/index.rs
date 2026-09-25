//! The workspace file index: every non-ignored file and folder, with incremental updates.
//!
//! Ignore rules are Git's: `.gitignore` files (in every folder and its parents), the
//! repository's `info/exclude` and the user's global excludes file. They apply in folders that
//! aren't Git repositories too. `.git` folders are never entered, symlinks and junctions are
//! never followed, and names that aren't valid workspace paths are skipped.
//!
//! Destructiveness: **read-only** (the index lives in memory).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{RwLock, mpsc};

use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};

use kalcode_core::{ErrorCategory, KalError, Result};

use crate::handles::HandleRegistry;
use crate::paths::{RelPath, WorkspaceRoot, plain};
use crate::types::{FileEntry, Page, PageRequest, page_of};

/// Most entries indexed per workspace; beyond this the index is marked truncated.
pub const DEFAULT_MAX_ENTRIES: usize = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Meta {
    pub is_dir: bool,
    pub bytes: u64,
}

/// What an incremental update changed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSummary {
    pub added: u32,
    pub removed: u32,
    pub updated: u32,
}

impl ChangeSummary {
    pub fn is_empty(&self) -> bool {
        self.added == 0 && self.removed == 0 && self.updated == 0
    }
}

pub struct FileIndex {
    root: WorkspaceRoot,
    walk_root: PathBuf,
    entries: RwLock<BTreeMap<String, Meta>>,
    max_entries: usize,
    truncated: AtomicBool,
}

impl std::fmt::Debug for FileIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileIndex")
            .field("workspace", &self.root.id())
            .field("entries", &self.len())
            .finish()
    }
}

/// The walker every workspace listing uses (index, listings, checkpoints): Git's ignore rules,
/// hidden files included, `.git` never entered, links never followed.
pub(crate) fn walker(dir: &Path, max_depth: Option<usize>) -> WalkBuilder {
    let mut builder = WalkBuilder::new(dir);
    builder
        .hidden(false)
        .ignore(false)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .max_depth(max_depth)
        .filter_entry(|entry| !is_git_dir(entry.file_name()));
    builder
}

pub(crate) fn is_git_dir(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .is_some_and(|n| n.eq_ignore_ascii_case(".git"))
}

fn meta_of(file_type: Option<std::fs::FileType>, metadata: Option<std::fs::Metadata>) -> Meta {
    let is_dir = file_type.is_some_and(|t| t.is_dir());
    Meta {
        is_dir,
        bytes: if is_dir {
            0
        } else {
            metadata.map_or(0, |m| m.len())
        },
    }
}

impl FileIndex {
    /// Walks the whole workspace (in parallel).
    pub fn build(root: WorkspaceRoot) -> Result<Self> {
        Self::build_with(root, DEFAULT_MAX_ENTRIES)
    }

    pub fn build_with(root: WorkspaceRoot, max_entries: usize) -> Result<Self> {
        let walk_root = plain(root.path());
        let index = Self {
            root,
            walk_root,
            entries: RwLock::new(BTreeMap::new()),
            max_entries,
            truncated: AtomicBool::new(false),
        };
        let entries = index.walk_subtree(None)?;
        *index.write() = entries;
        Ok(index)
    }

    pub fn workspace(&self) -> &WorkspaceRoot {
        &self.root
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, BTreeMap<String, Meta>> {
        self.entries
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, BTreeMap<String, Meta>> {
        self.entries
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn native(&self, rel: Option<&RelPath>) -> PathBuf {
        match rel {
            Some(rel) => rel.to_native(&self.walk_root),
            None => self.walk_root.clone(),
        }
    }

    fn rel_of(&self, path: &Path) -> Option<RelPath> {
        let rest = path.strip_prefix(&self.walk_root).ok()?;
        let mut parts = Vec::new();
        for component in rest.components() {
            parts.push(component.as_os_str().to_str()?);
        }
        if parts.is_empty() {
            return None;
        }
        RelPath::parse(&parts.join("/")).ok()
    }

    /// Every non-ignored entry below `dir` (or the whole workspace).
    fn walk_subtree(&self, dir: Option<&RelPath>) -> Result<BTreeMap<String, Meta>> {
        let start = self.native(dir);
        let (tx, rx) = mpsc::channel::<(String, Meta)>();
        let limit = self.max_entries;
        let count = std::sync::atomic::AtomicUsize::new(0);
        let truncated = &self.truncated;
        let this = self;
        let threads = std::thread::available_parallelism().map_or(4, |n| n.get().min(8));
        walker(&start, None)
            .threads(threads)
            .build_parallel()
            .run(|| {
                let tx = tx.clone();
                let count = &count;
                Box::new(move |entry| {
                    let Ok(entry) = entry else {
                        return WalkState::Continue;
                    };
                    if entry.depth() == 0 {
                        return WalkState::Continue;
                    }
                    let Some(rel) = this.rel_of(entry.path()) else {
                        return if entry.file_type().is_some_and(|t| t.is_dir()) {
                            WalkState::Skip
                        } else {
                            WalkState::Continue
                        };
                    };
                    if count.fetch_add(1, Ordering::Relaxed) >= limit {
                        truncated.store(true, Ordering::Relaxed);
                        return WalkState::Quit;
                    }
                    let meta = meta_of(entry.file_type(), entry.metadata().ok());
                    if tx.send((rel.as_str().to_owned(), meta)).is_err() {
                        return WalkState::Quit;
                    }
                    WalkState::Continue
                })
            });
        drop(tx);
        Ok(rx.into_iter().collect())
    }

    /// Non-ignored direct children of `dir` (name → meta), by walking one level with the full
    /// ignore stack of its parents.
    fn visible_children(&self, dir: Option<&RelPath>) -> HashMap<String, Meta> {
        let start = self.native(dir);
        walker(&start, Some(1))
            .build()
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.depth() == 1)
            .filter_map(|entry| {
                let name = entry.file_name().to_str()?.to_owned();
                Some((name, meta_of(entry.file_type(), entry.metadata().ok())))
            })
            .collect()
    }

    pub fn len(&self) -> usize {
        self.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.read().is_empty()
    }

    /// More entries existed than the index keeps.
    pub fn truncated(&self) -> bool {
        self.truncated.load(Ordering::Relaxed)
    }

    pub fn get(&self, rel: &RelPath) -> Option<Meta> {
        self.read().get(rel.as_str()).copied()
    }

    /// Lists a folder (default: the workspace root): folders first, then files, by name; ignored
    /// entries are included and flagged. Refreshes the index for that folder as a side effect.
    pub fn list_dir(
        &self,
        dir: Option<&RelPath>,
        page: &PageRequest,
        handles: &HandleRegistry,
    ) -> Result<Page<FileEntry>> {
        page.offset()?;
        if let Some(dir) = dir {
            let resolved = self.root.resolve(dir)?;
            if !resolved.exists || !resolved.path.is_dir() {
                return Err(KalError::new(
                    ErrorCategory::Filesystem,
                    "folder_unavailable",
                    "That folder no longer exists.",
                ));
            }
        }
        let native = self.native(dir);
        let visible = self.visible_children(dir);
        let listing = std::fs::read_dir(&native).map_err(|e| {
            KalError::new(
                ErrorCategory::Filesystem,
                "folder_unavailable",
                "KalCode couldn't read that folder.",
            )
            .with_source(e)
        })?;
        let mut rows: Vec<(RelPath, Meta, bool)> = Vec::new();
        for entry in listing.filter_map(std::result::Result::ok) {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if is_git_dir(entry.file_name().as_os_str()) {
                continue;
            }
            let rel = match dir {
                Some(d) => d.join(&name),
                None => RelPath::parse(&name),
            };
            let Ok(rel) = rel else { continue };
            let (meta, ignored) = match visible.get(&name) {
                Some(meta) => (*meta, false),
                None => (meta_of(entry.file_type().ok(), entry.metadata().ok()), true),
            };
            rows.push((rel, meta, ignored));
        }
        let (_, new_dirs) = self.reconcile_children(dir, &visible);
        self.fill_new_dirs(new_dirs)?;
        rows.sort_by(|a, b| {
            b.1.is_dir
                .cmp(&a.1.is_dir)
                .then_with(|| {
                    a.0.file_name()
                        .to_lowercase()
                        .cmp(&b.0.file_name().to_lowercase())
                })
                .then_with(|| a.0.cmp(&b.0))
        });
        let page = page_of(&rows, page)?;
        Ok(Page {
            items: page
                .items
                .into_iter()
                .map(|(rel, meta, ignored)| FileEntry {
                    file: handles.issue_unchecked(self.root.id(), &rel),
                    is_dir: meta.is_dir,
                    bytes: (!meta.is_dir).then_some(meta.bytes),
                    ignored,
                })
                .collect(),
            next_cursor: page.next_cursor,
            total_estimate: page.total_estimate,
        })
    }

    /// Makes the index's direct children of `dir` match `visible`; returns what changed and the
    /// folders that appeared (their contents still need a walk).
    fn reconcile_children(
        &self,
        dir: Option<&RelPath>,
        visible: &HashMap<String, Meta>,
    ) -> (ChangeSummary, Vec<RelPath>) {
        let prefix = dir.map(|d| format!("{d}/")).unwrap_or_default();
        let mut summary = ChangeSummary::default();
        let mut new_dirs = Vec::new();
        let mut entries = self.write();
        let existing: Vec<String> = children_of(&entries, &prefix);
        for key in existing {
            let name = &key[prefix.len()..];
            if !visible.contains_key(name) {
                remove_subtree(&mut entries, &key);
                summary.removed += 1;
            }
        }
        for (name, meta) in visible {
            let key = format!("{prefix}{name}");
            let Ok(rel) = RelPath::parse(&key) else {
                continue;
            };
            match entries.insert(key, *meta) {
                None => {
                    summary.added += 1;
                    if meta.is_dir {
                        new_dirs.push(rel);
                    }
                }
                Some(old) if old != *meta => {
                    summary.updated += 1;
                    if meta.is_dir && !old.is_dir {
                        new_dirs.push(rel);
                    }
                }
                Some(_) => {}
            }
        }
        (summary, new_dirs)
    }

    /// Applies filesystem changes at `paths` (from a watcher, hook reports or a thread's file
    /// list). Cost is proportional to the affected folders, not the workspace.
    pub fn apply_changes(&self, paths: &[RelPath]) -> Result<ChangeSummary> {
        let mut parents: HashSet<Option<RelPath>> = HashSet::new();
        let mut rewalk: HashSet<Option<RelPath>> = HashSet::new();
        for path in paths {
            let parent = path.parent();
            if path.file_name().eq_ignore_ascii_case(".gitignore") {
                rewalk.insert(parent.clone());
            }
            parents.insert(parent);
        }
        let mut total = ChangeSummary::default();
        for dir in &rewalk {
            // Ignore rules changed: rebuild everything below that folder.
            let fresh = self.walk_subtree(dir.as_ref())?;
            let prefix = dir.as_ref().map(|d| format!("{d}/")).unwrap_or_default();
            let mut entries = self.write();
            let before: Vec<String> = entries
                .range(prefix.clone()..)
                .take_while(|(k, _)| k.starts_with(&prefix))
                .map(|(k, _)| k.clone())
                .collect();
            for key in &before {
                if !fresh.contains_key(key) {
                    entries.remove(key);
                    total.removed += 1;
                }
            }
            for (key, meta) in fresh {
                match entries.insert(key, meta) {
                    None => total.added += 1,
                    Some(old) if old != meta => total.updated += 1,
                    Some(_) => {}
                }
            }
        }
        for dir in parents {
            if rewalk.iter().any(|r| match (r, &dir) {
                (None, _) => true,
                (Some(r), Some(d)) => d.starts_with(r),
                (Some(_), None) => false,
            }) {
                continue;
            }
            let exists = self.native(dir.as_ref()).is_dir();
            if !exists {
                if let Some(d) = &dir {
                    let mut entries = self.write();
                    if entries.contains_key(d.as_str()) {
                        remove_subtree(&mut entries, d.as_str());
                        total.removed += 1;
                    }
                }
                continue;
            }
            let visible = self.visible_children(dir.as_ref());
            let (summary, new_dirs) = self.reconcile_children(dir.as_ref(), &visible);
            total.added += summary.added;
            total.removed += summary.removed;
            total.updated += summary.updated;
            total.added += self.fill_new_dirs(new_dirs)?;
        }
        Ok(total)
    }

    /// Walks folders that just appeared (or stopped being ignored) and adds their contents.
    fn fill_new_dirs(&self, new_dirs: Vec<RelPath>) -> Result<u32> {
        let mut added = 0;
        for new_dir in new_dirs {
            let fresh = self.walk_subtree(Some(&new_dir))?;
            let mut entries = self.write();
            for (key, meta) in fresh {
                if entries.insert(key, meta).is_none() {
                    added += 1;
                }
            }
        }
        Ok(added)
    }

    /// Re-walks the whole workspace (after a watcher overflow).
    pub fn rebuild(&self) -> Result<()> {
        self.truncated.store(false, Ordering::Relaxed);
        let fresh = self.walk_subtree(None)?;
        *self.write() = fresh;
        Ok(())
    }

    /// Files whose path contains `query` (case-insensitive), in path order.
    pub fn find(&self, query: &str, limit: usize) -> Vec<RelPath> {
        let needle = query.to_lowercase();
        self.read()
            .iter()
            .filter(|(path, meta)| !meta.is_dir && path.to_lowercase().contains(&needle))
            .take(limit)
            .filter_map(|(path, _)| RelPath::parse(path).ok())
            .collect()
    }
}

fn children_of(entries: &BTreeMap<String, Meta>, prefix: &str) -> Vec<String> {
    entries
        .range(prefix.to_owned()..)
        .take_while(|(k, _)| k.starts_with(prefix))
        .filter(|(k, _)| !k[prefix.len()..].contains('/'))
        .map(|(k, _)| k.clone())
        .collect()
}

fn remove_subtree(entries: &mut BTreeMap<String, Meta>, key: &str) {
    entries.remove(key);
    let prefix = format!("{key}/");
    let doomed: Vec<String> = entries
        .range(prefix.clone()..)
        .take_while(|(k, _)| k.starts_with(&prefix))
        .map(|(k, _)| k.clone())
        .collect();
    for k in doomed {
        entries.remove(&k);
    }
}
