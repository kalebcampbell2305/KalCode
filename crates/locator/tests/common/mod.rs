//! Shared fixtures: a real core in a temp folder (with or without schema v11) and fake Z3/Z2
//! sources.

#![allow(dead_code, clippy::expect_used, clippy::unwrap_used)]

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::PermissionMode;
use kalcode_contracts::threads::{ThreadStatus, ThreadSummary};
use kalcode_core::db::{MIGRATIONS, Migration};
use kalcode_core::flags::BuildChannel;
use kalcode_core::{Core, CoreConfig, Paths, Result};
use kalcode_locator::{LocatorSources, ProviderInfo, RAIL_LOCATOR_MIGRATION};

/// The registered migrations up to and including v11.
pub fn migrations_with_v11() -> Vec<Migration> {
    MIGRATIONS
        .iter()
        .copied()
        .filter(|m| m.version <= RAIL_LOCATOR_MIGRATION.version)
        .collect()
}

/// The registered migrations before v11 (a database from an earlier KalCode).
pub fn migrations_before_v11() -> Vec<Migration> {
    MIGRATIONS
        .iter()
        .copied()
        .filter(|m| m.version < RAIL_LOCATOR_MIGRATION.version)
        .collect()
}

pub fn core_with_v11(dir: &Path) -> Arc<Core> {
    let all: &'static [Migration] = Box::leak(migrations_with_v11().into_boxed_slice());
    Arc::new(
        Core::open_with_migrations(
            CoreConfig {
                paths: Paths::new(dir),
                app_version: "0.0.0-test".into(),
                channel: BuildChannel::Development,
            },
            all,
        )
        .expect("open core"),
    )
}

/// A core with every registered migration (the schema a current build has). Workspace removal
/// needs it: `remove_workspace` also clears v12 `provider_account_bindings`.
pub fn core_current(dir: &Path) -> Arc<Core> {
    Arc::new(
        Core::open_with_migrations(
            CoreConfig {
                paths: Paths::new(dir),
                app_version: "0.0.0-test".into(),
                channel: BuildChannel::Development,
            },
            MIGRATIONS,
        )
        .expect("open core"),
    )
}

pub fn core_without_v11(dir: &Path) -> Arc<Core> {
    let before: &'static [Migration] = Box::leak(migrations_before_v11().into_boxed_slice());
    Arc::new(
        Core::open_with_migrations(
            CoreConfig {
                paths: Paths::new(dir),
                app_version: "0.0.0-test".into(),
                channel: BuildChannel::Development,
            },
            before,
        )
        .expect("open core"),
    )
}

pub struct FakeSources {
    pub threads: Mutex<Vec<ThreadSummary>>,
    pub texts: Mutex<HashMap<String, String>>,
    pub providers: Mutex<Vec<ProviderInfo>>,
    thread_reads: ThreadReadControl,
}

#[derive(Default)]
struct ThreadReadState {
    block_next: bool,
    blocked: bool,
    released: bool,
}

#[derive(Default)]
struct ThreadReadControl {
    state: Mutex<ThreadReadState>,
    changed: Condvar,
}

impl Default for FakeSources {
    fn default() -> Self {
        Self {
            threads: Mutex::new(Vec::new()),
            texts: Mutex::new(HashMap::new()),
            providers: Mutex::new(Vec::new()),
            thread_reads: ThreadReadControl::default(),
        }
    }
}

impl FakeSources {
    pub fn new() -> Arc<Self> {
        let sources = Self::default();
        *sources.providers.lock().unwrap() = vec![
            ProviderInfo {
                id: "claude-code".into(),
                name: "Claude Code".into(),
                status: "ready".into(),
                detail: "Installed · signed in".into(),
            },
            ProviderInfo {
                id: "codex".into(),
                name: "Codex".into(),
                status: "not_installed".into(),
                detail: "Not installed".into(),
            },
        ];
        Arc::new(sources)
    }

    pub fn add(&self, thread: ThreadSummary) {
        let mut threads = self.threads.lock().unwrap();
        threads.retain(|t| t.id != thread.id);
        threads.push(thread);
    }

    pub fn set_status(&self, id: &str, status: ThreadStatus) {
        for thread in self.threads.lock().unwrap().iter_mut() {
            if thread.id == id {
                thread.status = status;
            }
        }
    }

    /// Deterministically pauses the next `threads` snapshot until `release_thread_read`.
    pub fn block_next_thread_read(&self) {
        let mut state = self.thread_reads.state.lock().unwrap();
        state.block_next = true;
        state.blocked = false;
        state.released = false;
    }

    pub fn wait_until_thread_read_blocked(&self, timeout: Duration) -> bool {
        let start = Instant::now();
        let mut state = self.thread_reads.state.lock().unwrap();
        while !state.blocked {
            let Some(left) = timeout.checked_sub(start.elapsed()) else {
                return false;
            };
            let (next, result) = self.thread_reads.changed.wait_timeout(state, left).unwrap();
            state = next;
            if result.timed_out() && !state.blocked {
                return false;
            }
        }
        true
    }

    pub fn release_thread_read(&self) {
        let mut state = self.thread_reads.state.lock().unwrap();
        state.released = true;
        self.thread_reads.changed.notify_all();
    }
}

impl LocatorSources for FakeSources {
    fn threads(&self) -> Result<Vec<ThreadSummary>> {
        let mut state = self.thread_reads.state.lock().unwrap();
        if state.block_next {
            state.block_next = false;
            state.blocked = true;
            self.thread_reads.changed.notify_all();
            while !state.released {
                state = self.thread_reads.changed.wait(state).unwrap();
            }
            state.blocked = false;
            state.released = false;
        }
        drop(state);
        Ok(self.threads.lock().unwrap().clone())
    }

    fn thread(&self, id: &str) -> Result<Option<ThreadSummary>> {
        Ok(self
            .threads
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.id == id)
            .cloned())
    }

    fn thread_text(&self, id: &str, max_bytes: usize) -> Result<String> {
        let text = self
            .texts
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_default();
        Ok(text.chars().take(max_bytes).collect())
    }

    fn providers(&self) -> Vec<ProviderInfo> {
        self.providers.lock().unwrap().clone()
    }
}

pub fn thread(
    name: &str,
    provider: &str,
    workspace_id: &str,
    workspace_name: &str,
    status: ThreadStatus,
    last_activity_at: &str,
) -> ThreadSummary {
    ThreadSummary {
        can_move_workspace: None,
        id: new_id(),
        name: name.to_owned(),
        provider_id: ProviderId::new(provider),
        provider_name: match provider {
            "claude-code" => "Claude Code".to_owned(),
            "codex" => "Codex".to_owned(),
            other => other.to_owned(),
        },
        model: None,
        effort: None,
        provider_account_id: None,
        account_label: None,
        workspace_id: workspace_id.to_owned(),
        workspace_name: workspace_name.to_owned(),
        permission_mode: PermissionMode::Approve,
        status,
        current_activity: None,
        created_at: last_activity_at.to_owned(),
        last_activity_at: last_activity_at.to_owned(),
        pending_approvals: 0,
        unread_messages: 0,
        files_changed: None,
        branch: None,
        error: None,
        archived_at: None,
        resumable: false,
        restart_recoverable: None,
        permission_profile_id: None,
        runtime_kind: None,
        terminal_id: None,
        worktree_id: None,
    }
}

/// Makes a real folder and opens it as a workspace.
pub fn workspace(core: &Core, root: &Path, name: &str) -> kalcode_core::workspaces::Workspace {
    let folder = root.join(name);
    std::fs::create_dir_all(&folder).expect("folder");
    core.open_workspace(&folder).expect("open workspace")
}
