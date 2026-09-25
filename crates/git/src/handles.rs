//! Opaque file handles (docs/campaigns/ADVANCED.md §3 D4).
//!
//! The WebView never receives a path it could reuse. Native listings (the file index, status,
//! diffs) issue a **handle** per file: a random, unguessable UUID bound to one workspace and one
//! validated workspace-relative path. The WebView can only point back at files native code
//! already listed. Containment is checked when a handle is issued and again every time it is
//! used ([`WorkspaceRoot::resolve`]), so a symlink or junction swapped in afterwards cannot
//! redirect a handle outside the workspace.
//!
//! Handles are session-scoped (never persisted) and bounded: the registry keeps at most
//! `capacity` handles and forgets the oldest first; a forgotten handle fails with
//! `file_handle_unknown` and the UI simply lists again.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, PoisonError};

use kalcode_contracts::ids::is_valid_id;
use kalcode_core::{ErrorCategory, KalError, Result};

use crate::paths::{RelPath, Resolved, WorkspaceRoot};
use crate::types::{FileHandle, FileRef};

/// Default number of live handles (a 1M-file repository listed in full stays well below).
pub const DEFAULT_CAPACITY: usize = 250_000;

#[derive(Debug, Clone)]
struct Entry {
    workspace_id: String,
    rel: RelPath,
}

#[derive(Debug, Default)]
struct Inner {
    by_id: HashMap<String, Entry>,
    by_path: HashMap<(String, RelPath), String>,
    order: VecDeque<String>,
}

/// A handle resolved for use: where the file is now, checked just now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFile {
    pub rel: RelPath,
    pub location: Resolved,
}

/// Session-scoped handle registry, shared by every workspace.
#[derive(Debug)]
pub struct HandleRegistry {
    inner: Mutex<Inner>,
    capacity: usize,
}

impl Default for HandleRegistry {
    fn default() -> Self {
        Self::new(DEFAULT_CAPACITY)
    }
}

fn unknown() -> KalError {
    KalError::new(
        ErrorCategory::Validation,
        "file_handle_unknown",
        "That file reference has expired. Refresh the list and try again.",
    )
}

impl HandleRegistry {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            capacity: capacity.max(1),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Issues (or re-issues) the handle for `rel` in `workspace`. Containment is checked first:
    /// a path that resolves outside the workspace — through `..`, a symlink or a junction — gets
    /// no handle.
    pub fn issue(&self, workspace: &WorkspaceRoot, rel: &RelPath) -> Result<FileRef> {
        workspace.resolve(rel)?;
        Ok(self.issue_unchecked(workspace.id(), rel))
    }

    /// Issues a handle for a path native code just produced from a trusted listing of this
    /// workspace (the index walk or git output mapped through [`RelPath::parse`]). Use of the
    /// handle is still checked.
    pub(crate) fn issue_unchecked(&self, workspace_id: &str, rel: &RelPath) -> FileRef {
        let mut inner = self.lock();
        let key = (workspace_id.to_owned(), rel.clone());
        let id = if let Some(id) = inner.by_path.get(&key) {
            id.clone()
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            inner.by_id.insert(
                id.clone(),
                Entry {
                    workspace_id: workspace_id.to_owned(),
                    rel: rel.clone(),
                },
            );
            inner.by_path.insert(key, id.clone());
            inner.order.push_back(id.clone());
            while inner.order.len() > self.capacity {
                if let Some(old) = inner.order.pop_front()
                    && let Some(entry) = inner.by_id.remove(&old)
                {
                    inner.by_path.remove(&(entry.workspace_id, entry.rel));
                }
            }
            id
        };
        FileRef {
            handle: FileHandle { id },
            workspace_id: workspace_id.to_owned(),
            display_path: rel.as_str().to_owned(),
        }
    }

    /// Resolves a handle supplied by the WebView. It must be well-formed, known, bound to
    /// `workspace`, and still resolve inside it.
    pub fn resolve(&self, workspace: &WorkspaceRoot, handle: &FileHandle) -> Result<ResolvedFile> {
        if !is_valid_id(&handle.id) {
            return Err(KalError::validation(
                "file_handle_invalid",
                "That file reference isn't valid.",
            ));
        }
        let entry = self
            .lock()
            .by_id
            .get(&handle.id)
            .cloned()
            .ok_or_else(unknown)?;
        if entry.workspace_id != workspace.id() {
            // Never reveal that the handle exists in another workspace.
            return Err(unknown());
        }
        let location = workspace.resolve(&entry.rel)?;
        Ok(ResolvedFile {
            rel: entry.rel,
            location,
        })
    }

    /// The relative path behind a handle without touching the filesystem (for git pathspecs;
    /// git itself never leaves the repository).
    pub fn rel_path(&self, workspace_id: &str, handle: &FileHandle) -> Result<RelPath> {
        if !is_valid_id(&handle.id) {
            return Err(KalError::validation(
                "file_handle_invalid",
                "That file reference isn't valid.",
            ));
        }
        let inner = self.lock();
        match inner.by_id.get(&handle.id) {
            Some(entry) if entry.workspace_id == workspace_id => Ok(entry.rel.clone()),
            _ => Err(unknown()),
        }
    }

    /// Forgets every handle of a workspace (workspace removed or closed).
    pub fn revoke_workspace(&self, workspace_id: &str) {
        let mut inner = self.lock();
        let ids: std::collections::HashSet<String> = inner
            .by_id
            .iter()
            .filter(|(_, entry)| entry.workspace_id == workspace_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            if let Some(entry) = inner.by_id.remove(id) {
                inner.by_path.remove(&(entry.workspace_id, entry.rel));
            }
        }
        inner.order.retain(|id| !ids.contains(id));
    }

    pub fn len(&self) -> usize {
        self.lock().by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::ids::new_id;

    fn workspace() -> (tempfile::TempDir, WorkspaceRoot) {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("a.txt"), b"a").expect("write");
        let root = WorkspaceRoot::new(&new_id(), dir.path()).expect("root");
        (dir, root)
    }

    #[test]
    fn same_path_same_handle_and_capacity_is_bounded() {
        let (_dir, ws) = workspace();
        let registry = HandleRegistry::new(2);
        let a = RelPath::parse("a.txt").expect("a");
        let first = registry.issue(&ws, &a).expect("issue");
        assert_eq!(registry.issue(&ws, &a).expect("again").handle, first.handle);
        registry.issue_unchecked(ws.id(), &RelPath::parse("b").expect("b"));
        registry.issue_unchecked(ws.id(), &RelPath::parse("c").expect("c"));
        assert_eq!(registry.len(), 2);
        let err = registry.resolve(&ws, &first.handle).expect_err("evicted");
        assert_eq!(err.code, "file_handle_unknown");
    }

    #[test]
    fn handles_are_bound_to_their_workspace() {
        let (_d1, ws1) = workspace();
        let (_d2, ws2) = workspace();
        let registry = HandleRegistry::default();
        let file = registry
            .issue(&ws1, &RelPath::parse("a.txt").expect("a"))
            .expect("issue");
        assert!(registry.resolve(&ws1, &file.handle).is_ok());
        let err = registry.resolve(&ws2, &file.handle).expect_err("cross");
        assert_eq!(err.code, "file_handle_unknown");
        registry.revoke_workspace(ws1.id());
        assert!(registry.resolve(&ws1, &file.handle).is_err());
    }

    #[test]
    fn forged_and_malformed_handles_fail() {
        let (_dir, ws) = workspace();
        let registry = HandleRegistry::default();
        for bad in ["", "../a.txt", "a.txt", "C:\\Windows", &new_id()] {
            let err = registry
                .resolve(&ws, &FileHandle { id: bad.to_owned() })
                .expect_err("forged");
            assert!(
                err.code == "file_handle_invalid" || err.code == "file_handle_unknown",
                "{bad}: {}",
                err.code
            );
        }
    }
}
