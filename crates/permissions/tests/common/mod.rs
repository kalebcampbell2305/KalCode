//! Shared fixtures for the permission integration tests.
#![allow(dead_code, clippy::expect_used)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::events::EventEnvelope;
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::{ActionKind, NormalizedAction, PermissionMode};
use kalcode_contracts::threads::{ThreadStatus, ThreadSummary};
use kalcode_core::flags::BuildChannel;
use kalcode_core::{Core, CoreConfig, KalError, Paths, Result};
use kalcode_permissions::{Clock, PermissionService, ThreadModeStore, WorkspaceRoots};

pub struct FakeWorkspaces(pub Mutex<HashMap<String, PathBuf>>);

impl WorkspaceRoots for FakeWorkspaces {
    fn root(&self, workspace_id: &str) -> Option<PathBuf> {
        self.0.lock().expect("lock").get(workspace_id).cloned()
    }
}

#[derive(Default)]
pub struct FakeThreads {
    pub threads: Mutex<HashMap<String, ThreadSummary>>,
    pub profiles: Mutex<HashMap<String, String>>,
}

impl ThreadModeStore for FakeThreads {
    fn thread(&self, thread_id: &str) -> Result<Option<ThreadSummary>> {
        Ok(self.threads.lock().expect("lock").get(thread_id).cloned())
    }

    fn set_mode(
        &self,
        thread_id: &str,
        mode: PermissionMode,
        profile_id: Option<&str>,
    ) -> Result<ThreadSummary> {
        let mut threads = self.threads.lock().expect("lock");
        let thread = threads
            .get_mut(thread_id)
            .ok_or_else(|| KalError::validation("thread_not_found", "missing"))?;
        thread.permission_mode = mode;
        if let Some(profile) = profile_id {
            self.profiles
                .lock()
                .expect("lock")
                .insert(thread_id.to_owned(), profile.to_owned());
        }
        Ok(thread.clone())
    }

    fn custom_profile_id(&self, thread_id: &str) -> Option<String> {
        self.profiles.lock().expect("lock").get(thread_id).cloned()
    }
}

pub struct TestClock(pub AtomicI64);

impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub struct Harness {
    pub dir: tempfile::TempDir,
    pub core: Arc<Core>,
    pub service: Arc<PermissionService>,
    pub threads: Arc<FakeThreads>,
    pub workspaces: Arc<FakeWorkspaces>,
    pub clock: Arc<TestClock>,
    pub events: Arc<Mutex<Vec<EventEnvelope>>>,
    pub workspace_id: String,
    pub thread_id: String,
    pub root: PathBuf,
}

pub fn thread_summary(id: &str, workspace_id: &str, mode: PermissionMode) -> ThreadSummary {
    ThreadSummary {
        id: id.to_owned(),
        name: "Fix the login bug".into(),
        provider_id: ProviderId::new(ProviderId::CLAUDE_CODE),
        provider_name: "Claude Code".into(),
        model: None,
        account_label: None,
        workspace_id: workspace_id.to_owned(),
        workspace_name: "kalcode".into(),
        permission_mode: mode,
        status: ThreadStatus::WaitingForPermission,
        current_activity: None,
        created_at: "2026-09-24T00:00:00.000Z".into(),
        last_activity_at: "2026-09-24T00:00:00.000Z".into(),
        pending_approvals: 0,
        unread_messages: 0,
        files_changed: None,
        branch: None,
        error: None,
        archived_at: None,
        resumable: false,
        permission_profile_id: None,
        runtime_kind: None,
        terminal_id: None,
    }
}

impl Harness {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("workspace");
        std::fs::create_dir_all(root.join("src")).expect("mkdir");
        std::fs::write(root.join("src").join("main.rs"), "fn main() {}").expect("write");
        std::fs::create_dir_all(dir.path().join("outside")).expect("mkdir");
        let core = Arc::new(open_core(&dir.path().join("data")));
        let workspace_id = new_id();
        let thread_id = new_id();
        let workspaces = Arc::new(FakeWorkspaces(Mutex::new(HashMap::from([(
            workspace_id.clone(),
            root.clone(),
        )]))));
        let threads = Arc::new(FakeThreads::default());
        threads.threads.lock().expect("lock").insert(
            thread_id.clone(),
            thread_summary(&thread_id, &workspace_id, PermissionMode::Approve),
        );
        let clock = Arc::new(TestClock(AtomicI64::new(1_800_000_000_000)));
        let service = Arc::new(
            PermissionService::with_clock(
                core.clone(),
                workspaces.clone(),
                threads.clone(),
                clock.clone(),
            )
            .expect("service"),
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        core.subscribe(move |event| {
            sink.lock().expect("lock").push(event.clone());
            true
        });
        Self {
            dir,
            core,
            service,
            threads,
            workspaces,
            clock,
            events,
            workspace_id,
            thread_id,
            root,
        }
    }

    pub fn add_thread(&self, mode: PermissionMode) -> String {
        self.add_thread_in(&self.workspace_id.clone(), mode)
    }

    pub fn add_thread_in(&self, workspace_id: &str, mode: PermissionMode) -> String {
        let id = new_id();
        self.threads
            .threads
            .lock()
            .expect("lock")
            .insert(id.clone(), thread_summary(&id, workspace_id, mode));
        id
    }

    pub fn add_workspace(&self) -> String {
        let id = new_id();
        let root = self.dir.path().join(format!("ws-{id}"));
        std::fs::create_dir_all(&root).expect("mkdir");
        self.workspaces
            .0
            .lock()
            .expect("lock")
            .insert(id.clone(), root);
        id
    }

    pub fn action(&self, kind: ActionKind) -> NormalizedAction {
        self.action_for(&self.thread_id, &self.workspace_id, kind)
    }

    pub fn action_for(
        &self,
        thread_id: &str,
        workspace_id: &str,
        kind: ActionKind,
    ) -> NormalizedAction {
        NormalizedAction {
            id: format!("toolu_{}", new_id()),
            thread_id: thread_id.to_owned(),
            workspace_id: workspace_id.to_owned(),
            provider_id: ProviderId::new(ProviderId::CLAUDE_CODE),
            action: kind,
            summary: "test action".into(),
            requested_at: "2026-09-24T00:00:00.000Z".into(),
            origin: None,
        }
    }

    pub fn event_types(&self) -> Vec<String> {
        self.events
            .lock()
            .expect("lock")
            .iter()
            .map(|e| e.event.type_name().to_owned())
            .collect()
    }

    pub fn advance(&self, ms: i64) {
        self.clock.0.fetch_add(ms, Ordering::SeqCst);
    }
}

pub fn open_core(data: &Path) -> Core {
    let config = CoreConfig {
        paths: Paths::new(data),
        app_version: "0.0.0-test".into(),
        channel: BuildChannel::Development,
    };
    Core::open(config).expect("core")
}

pub fn command(text: &str) -> ActionKind {
    ActionKind::Command {
        command: text.into(),
        argv: vec![],
        cwd: String::new(),
    }
}
