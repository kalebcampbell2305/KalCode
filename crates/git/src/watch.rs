//! Filesystem watching for incremental index updates.
//!
//! One recursive OS watcher per workspace feeds a debounce thread. After `debounce` without new
//! events, the collected paths are applied to the [`FileIndex`] and one [`ChangeBatch`] is
//! reported (the host turns batches into the debounced `git.diff_changed` event, ≥ 1 s). Changes
//! inside `.git` never touch the index; they only set [`ChangeBatch::git_state_changed`]. If the
//! OS reports lost events, the index is rebuilt.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread::JoinHandle;
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use kalcode_core::{ErrorCategory, KalError, Result};

use crate::index::{ChangeSummary, FileIndex};
use crate::paths::plain;

/// What one debounced batch changed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChangeBatch {
    pub index: ChangeSummary,
    /// Paths the batch covered (before de-duplication by folder).
    pub paths: usize,
    /// Something under `.git` changed (HEAD, index, refs): status may differ.
    pub git_state_changed: bool,
    /// The OS dropped events and the index was rebuilt.
    pub rescanned: bool,
}

/// Keeps a workspace's index current until dropped.
pub struct IndexWatcher {
    watcher: Option<RecommendedWatcher>,
    thread: Option<JoinHandle<()>>,
}

impl IndexWatcher {
    pub fn start(
        index: Arc<FileIndex>,
        debounce: Duration,
        on_batch: impl Fn(ChangeBatch) + Send + 'static,
    ) -> Result<Self> {
        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = tx.send(event);
        })
        .map_err(|e| {
            KalError::new(
                ErrorCategory::Filesystem,
                "watch_unavailable",
                "KalCode couldn't watch this workspace for changes.",
            )
            .with_source(e)
        })?;
        let root = plain(index.workspace().path());
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| {
                KalError::new(
                    ErrorCategory::Filesystem,
                    "watch_unavailable",
                    "KalCode couldn't watch this workspace for changes.",
                )
                .with_source(e)
            })?;
        let thread = std::thread::Builder::new()
            .name("kalcode-index-watch".into())
            .spawn(move || run(index, rx, debounce, on_batch))
            .map_err(|e| {
                KalError::internal(
                    "watch_unavailable",
                    "KalCode couldn't watch this workspace.",
                )
                .with_source(e)
            })?;
        Ok(Self {
            watcher: Some(watcher),
            thread: Some(thread),
        })
    }
}

impl Drop for IndexWatcher {
    fn drop(&mut self) {
        // Dropping the OS watcher drops the channel's sender, which ends the thread.
        self.watcher.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run(
    index: Arc<FileIndex>,
    rx: mpsc::Receiver<notify::Result<notify::Event>>,
    debounce: Duration,
    on_batch: impl Fn(ChangeBatch),
) {
    let root = index.workspace().clone();
    let mut pending = HashSet::new();
    let mut git_changed = false;
    let mut rescan = false;
    loop {
        let wait = if pending.is_empty() && !git_changed && !rescan {
            Duration::from_secs(3600)
        } else {
            debounce
        };
        match rx.recv_timeout(wait) {
            Ok(Ok(event)) => {
                if event.need_rescan() {
                    rescan = true;
                }
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                for path in &event.paths {
                    if path.components().any(|c| {
                        c.as_os_str()
                            .to_str()
                            .is_some_and(|n| n.eq_ignore_ascii_case(".git"))
                    }) {
                        git_changed = true;
                    } else if let Some(rel) = root.relativize(path) {
                        pending.insert(rel);
                    }
                }
            }
            Ok(Err(_)) => rescan = true,
            Err(RecvTimeoutError::Timeout) => {
                if pending.is_empty() && !git_changed && !rescan {
                    continue;
                }
                let paths: Vec<_> = pending.drain().collect();
                let mut batch = ChangeBatch {
                    paths: paths.len(),
                    git_state_changed: git_changed,
                    rescanned: rescan,
                    ..ChangeBatch::default()
                };
                if rescan {
                    if let Err(error) = index.rebuild() {
                        tracing::warn!(event = "index.rebuild_failed", error_code = error.code);
                    }
                } else if !paths.is_empty() {
                    match index.apply_changes(&paths) {
                        Ok(summary) => batch.index = summary,
                        Err(error) => {
                            tracing::warn!(event = "index.update_failed", error_code = error.code)
                        }
                    }
                }
                git_changed = false;
                rescan = false;
                on_batch(batch);
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}
