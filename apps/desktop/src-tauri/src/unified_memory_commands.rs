//! Shared project memory. Local retrieval is bounded; extraction runs on a bounded worker.
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex, OnceLock, Weak, mpsc};
use std::time::{Duration, Instant};

use kalcode_context::memory;
use kalcode_contracts::agent::{
    AgentEvent, AgentEventSink, AgentInput, AgentProvider, AgentSession, ProviderCapabilities,
    ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::permissions::ApprovalDecision;
use kalcode_contracts::unified_memory::{
    MemoryInput, MemoryRecord, MemorySettings, MemorySourceKind,
};
use kalcode_core::{Core, IpcError, KalError, Result};

use crate::account::runtime::{AccountRuntime, AuthorityLease};
use crate::runtime_coordinator::{RuntimeAccess, RuntimeState};
use crate::thread_commands::ThreadsState;

enum Work {
    Refresh(String),
    Capture {
        workspace: String,
        source: MemorySourceKind,
        source_id: String,
        text: String,
    },
}

pub struct MemoryService {
    core: Arc<Core>,
    account: Weak<AccountRuntime>,
    owner: String,
    authority: AuthorityLease,
    work: mpsc::SyncSender<Work>,
    refreshed: Mutex<HashMap<String, Instant>>,
}

impl MemoryService {
    pub fn start(core: Arc<Core>, account: &Arc<AccountRuntime>) -> Option<Arc<Self>> {
        let authority = account.acquire_active_lease().ok()?;
        let owner = account.snapshot().account?.id;
        let (work, receiver) = mpsc::sync_channel(64);
        let service = Arc::new(Self {
            core,
            account: Arc::downgrade(account),
            owner,
            authority,
            work,
            refreshed: Mutex::new(HashMap::new()),
        });
        let weak = Arc::downgrade(&service);
        std::thread::Builder::new()
            .name("project-memory".into())
            .spawn(move || {
                while let Ok(work) = receiver.recv() {
                    let Some(service) = weak.upgrade() else { break };
                    if service.require().is_err() {
                        continue;
                    }
                    let result = match work {
                        Work::Refresh(workspace) => service.refresh(&workspace),
                        Work::Capture {
                            workspace,
                            source,
                            source_id,
                            text,
                        } => service
                            .capture_now(&workspace, source, Some(&source_id), &text)
                            .map(|_| ()),
                    };
                    if let Err(error) = result {
                        tracing::debug!(event = "memory.background_skipped", code = error.code);
                    }
                }
            })
            .ok()?;
        if let Ok(workspaces) = service.core.workspaces() {
            for workspace in workspaces {
                service.schedule_refresh(&workspace.id);
            }
        }
        Some(service)
    }

    fn require(&self) -> Result<()> {
        let account = self.account.upgrade().ok_or_else(unavailable)?;
        let current = account.acquire_active_lease().map_err(|_| unavailable())?;
        if current.generation() != self.authority.generation() {
            return Err(unavailable());
        }
        let snapshot = account.snapshot();
        if snapshot.account.as_ref().map(|a| a.id.as_str()) != Some(self.owner.as_str()) {
            return Err(unavailable());
        }
        let rank = match snapshot.plan_tier() {
            kalcode_core::plans::PlanTier::Free => 0,
            kalcode_core::plans::PlanTier::Pro => 1,
            kalcode_core::plans::PlanTier::Max | kalcode_core::plans::PlanTier::Max2x => 2,
            kalcode_core::plans::PlanTier::Owner => 3,
        };
        if !kalcode_contracts::app::FeatureId::Memory
            .placement()
            .included_in(rank)
        {
            return Err(KalError::validation(
                "memory_plan_required",
                "Unified Memory is included with KalCode Pro and higher plans.",
            ));
        }
        Ok(())
    }

    pub fn retrieve(&self, workspace: &str, query: &str) -> Result<String> {
        self.require()?;
        let root = crate::git_commands::workspace_root_in(&self.core, workspace)?;
        let result = memory::retrieve(
            &self.core.reader(),
            &self.owner,
            workspace,
            query,
            4096,
            root.path(),
        )
        .map_err(KalError::from)?;
        self.require()?;
        Ok(result)
    }

    pub fn recall(&self, workspace: &str, query: &str) -> Result<String> {
        self.require()?;
        let root = crate::git_commands::workspace_root_in(&self.core, workspace)?;
        let result = memory::retrieve_relevant(
            &self.core.reader(),
            &self.owner,
            workspace,
            query,
            4096,
            root.path(),
        )
        .map_err(KalError::from)?;
        self.require()?;
        Ok(result)
    }

    fn startup_context(&self, workspace: &str) -> Result<String> {
        self.require()?;
        let root = crate::git_commands::workspace_root_in(&self.core, workspace)?;
        let context = memory::retrieve_startup(
            &self.core.reader(),
            &self.owner,
            workspace,
            2048,
            root.path(),
        )?;
        self.require()?;
        Ok(context)
    }

    pub fn capture(&self, workspace: &str, source: MemorySourceKind, source_id: &str, text: &str) {
        if text.len() > 64 * 1024 || self.require().is_err() {
            return;
        }
        // A full queue skips optional capture, never stalls a terminal or provider callback.
        let _ = self.work.try_send(Work::Capture {
            workspace: workspace.into(),
            source,
            source_id: source_id.into(),
            text: text.into(),
        });
    }

    fn capture_now(
        &self,
        workspace: &str,
        source: MemorySourceKind,
        source_id: Option<&str>,
        text: &str,
    ) -> Result<usize> {
        self.require()?;
        let root = crate::git_commands::workspace_root_in(&self.core, workspace)?;
        self.core
            .transact(|tx| {
                self.require()?;
                let count = memory::capture(
                    tx,
                    &self.owner,
                    workspace,
                    source,
                    source_id,
                    text,
                    root.path(),
                )?;
                Ok((count, vec![]))
            })
            .map(|(count, _)| count)
    }

    fn schedule_refresh(&self, workspace: &str) {
        let mut refreshed = self
            .refreshed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if refreshed
            .get(workspace)
            .is_some_and(|last| last.elapsed() < Duration::from_secs(30))
        {
            return;
        }
        if self.work.try_send(Work::Refresh(workspace.into())).is_ok() {
            if refreshed.len() >= 128 {
                refreshed.clear();
            }
            refreshed.insert(workspace.into(), Instant::now());
        }
    }

    fn refresh(&self, workspace: &str) -> Result<()> {
        let root = crate::git_commands::workspace_root_in(&self.core, workspace)?;
        let records = memory::list(&self.core.reader(), &self.owner, workspace, "")?;
        // File inspection holds neither SQLite connection nor a provider/runtime lock.
        let stale = memory::inspect_staleness(&records, root.path());
        self.core.transact(|tx| {
            self.require()?;
            memory::mark_stale(tx, &self.owner, workspace, &stale)?;
            Ok(((), vec![]))
        })?;
        for name in ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] {
            let Ok(path) = root.path().join(name).canonicalize() else {
                continue;
            };
            if !path.starts_with(root.path()) {
                continue;
            }
            let Ok(file) = std::fs::File::open(path) else {
                continue;
            };
            if !file
                .metadata()
                .is_ok_and(|meta| meta.is_file() && meta.len() <= 64 * 1024)
            {
                continue;
            }
            let mut text = String::new();
            if file.take(64 * 1024).read_to_string(&mut text).is_ok() {
                self.capture_now(workspace, MemorySourceKind::Instructions, Some(name), &text)?;
            }
        }
        Ok(())
    }
}

fn unavailable() -> KalError {
    KalError::validation(
        "memory_unavailable",
        "Sign in and wait for your workspace to finish opening, then try again.",
    )
}

fn service(
    threads: &RuntimeState<ThreadsState>,
) -> std::result::Result<&Arc<MemoryService>, IpcError> {
    threads.revalidate()?;
    let memory = threads.memory().ok_or_else(|| unavailable().to_ipc())?;
    memory.require().map_err(|e| e.to_ipc())?;
    Ok(memory)
}

#[tauri::command(async)]
pub fn unified_memory_list(
    threads: RuntimeAccess,
    workspace_id: String,
    query: Option<String>,
) -> std::result::Result<Vec<MemoryRecord>, IpcError> {
    let service = service(&threads)?;
    crate::git_commands::workspace_root_in(&service.core, &workspace_id).map_err(|e| e.to_ipc())?;
    service.schedule_refresh(&workspace_id);
    let records = memory::list(
        &service.core.reader(),
        &service.owner,
        &workspace_id,
        query.as_deref().unwrap_or(""),
    )
    .map_err(|e| KalError::from(e).to_ipc())?;
    threads.revalidate()?;
    Ok(records)
}

#[tauri::command(async)]
pub fn unified_memory_save(
    threads: RuntimeAccess,
    workspace_id: String,
    id: Option<String>,
    mut input: MemoryInput,
) -> std::result::Result<MemoryRecord, IpcError> {
    let service = service(&threads)?;
    let root = crate::git_commands::workspace_root_in(&service.core, &workspace_id)
        .map_err(|e| e.to_ipc())?;
    // User edits have truthful provenance; the renderer cannot impersonate a completed run.
    input.source_kind = MemorySourceKind::User;
    input.source_id = None;
    input.commit_id = None;
    service
        .core
        .transact(|tx| {
            threads.revalidate_core()?;
            service.require()?;
            Ok((
                memory::save(
                    tx,
                    &service.owner,
                    &workspace_id,
                    id.as_deref(),
                    &input,
                    root.path(),
                )?,
                vec![],
            ))
        })
        .map(|(record, _)| record)
        .map_err(|e| e.to_ipc())
}

#[tauri::command(async)]
pub fn unified_memory_review(
    threads: RuntimeAccess,
    workspace_id: String,
    id: String,
) -> std::result::Result<MemoryRecord, IpcError> {
    let service = service(&threads)?;
    let root = crate::git_commands::workspace_root_in(&service.core, &workspace_id)
        .map_err(|e| e.to_ipc())?;
    service
        .core
        .transact(|tx| {
            threads.revalidate_core()?;
            service.require()?;
            Ok((
                memory::review(tx, &service.owner, &workspace_id, &id, root.path())?,
                vec![],
            ))
        })
        .map(|(record, _)| record)
        .map_err(|e| e.to_ipc())
}

#[tauri::command(async)]
pub fn unified_memory_delete(
    threads: RuntimeAccess,
    workspace_id: String,
    id: String,
) -> std::result::Result<bool, IpcError> {
    let service = service(&threads)?;
    service
        .core
        .transact(|tx| {
            threads.revalidate_core()?;
            service.require()?;
            Ok((
                memory::remove(tx, &service.owner, &workspace_id, &id)?,
                vec![],
            ))
        })
        .map(|(removed, _)| removed)
        .map_err(|e| e.to_ipc())
}

#[tauri::command(async)]
pub fn unified_memory_preferences(
    threads: RuntimeAccess,
    workspace_id: String,
) -> std::result::Result<MemorySettings, IpcError> {
    let service = service(&threads)?;
    crate::git_commands::workspace_root_in(&service.core, &workspace_id).map_err(|e| e.to_ipc())?;
    let settings = memory::get_settings(&service.core.reader(), &service.owner, &workspace_id)
        .map_err(|e| KalError::from(e).to_ipc())?;
    threads.revalidate()?;
    Ok(settings)
}

#[tauri::command(async)]
pub fn unified_memory_set_preferences(
    threads: RuntimeAccess,
    workspace_id: String,
    settings: MemorySettings,
) -> std::result::Result<MemorySettings, IpcError> {
    let service = service(&threads)?;
    crate::git_commands::workspace_root_in(&service.core, &workspace_id).map_err(|e| e.to_ipc())?;
    service
        .core
        .transact(|tx| {
            threads.revalidate_core()?;
            service.require()?;
            memory::set_settings(tx, &service.owner, &workspace_id, &settings)?;
            Ok((settings, vec![]))
        })
        .map(|(settings, _)| settings)
        .map_err(|e| e.to_ipc())
}

#[tauri::command(async)]
pub fn unified_memory_retrieve(
    threads: RuntimeAccess,
    workspace_id: String,
    query: String,
) -> std::result::Result<String, IpcError> {
    service(&threads)?
        .retrieve(&workspace_id, &query)
        .map_err(|e| e.to_ipc())
}

/// Provider-neutral wrapper also covers providers added to the registry in future.
pub struct MemoryProvider {
    pub inner: Arc<dyn AgentProvider>,
    pub memory: Arc<OnceLock<Arc<MemoryService>>>,
}

struct MemorySink {
    inner: Box<dyn AgentEventSink>,
    memory: Arc<MemoryService>,
    workspace: String,
    thread: String,
}

impl AgentEventSink for MemorySink {
    fn project_context_for(&self, query: &str) -> Option<String> {
        self.memory
            .retrieve(&self.workspace, query)
            .ok()
            .filter(|text| !text.is_empty())
    }
    fn project_context(&self) -> Option<String> {
        let query = self
            .memory
            .core
            .read(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT name FROM threads WHERE id=?1",
                        [&self.thread],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap_or_default())
            })
            .unwrap_or_default();
        self.project_context_for(&query).or_else(|| {
            self.memory
                .startup_context(&self.workspace)
                .ok()
                .filter(|text| !text.is_empty())
        })
    }
    fn remember(&self, text: &str) {
        self.memory
            .capture(&self.workspace, MemorySourceKind::Agent, &self.thread, text);
    }
    fn remember_user(&self, text: &str) {
        self.memory
            .capture(&self.workspace, MemorySourceKind::User, &self.thread, text);
    }
    fn emit(&self, event: AgentEvent) {
        if let AgentEvent::MessageCompleted { text, .. } = &event {
            self.remember(text);
        }
        if matches!(event, AgentEvent::TurnCompleted { .. }) {
            self.memory.schedule_refresh(&self.workspace);
        }
        self.inner.emit(event);
    }
}

impl AgentProvider for MemoryProvider {
    fn id(&self) -> ProviderId {
        self.inner.id()
    }
    fn display_name(&self) -> &str {
        self.inner.display_name()
    }
    fn detect(&self) -> ProviderDetection {
        self.inner.detect()
    }
    fn capabilities(&self) -> ProviderCapabilities {
        self.inner.capabilities()
    }
    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> std::result::Result<Box<dyn AgentSession>, ProviderError> {
        let Some(memory) = self
            .memory
            .get()
            .filter(|memory| memory.require().is_ok())
            .cloned()
        else {
            return self.inner.start_session(config, sink);
        };
        memory.schedule_refresh(&config.workspace_id);
        let workspace = config.workspace_id.clone();
        let thread = config.thread_id.clone();
        let sink = Box::new(MemorySink {
            inner: sink,
            memory: memory.clone(),
            workspace: workspace.clone(),
            thread: thread.clone(),
        });
        let inner = self.inner.start_session(config, sink)?;
        Ok(Box::new(MemorySession {
            inner,
            memory,
            workspace,
            thread,
        }))
    }
}

struct MemorySession {
    inner: Box<dyn AgentSession>,
    memory: Arc<MemoryService>,
    workspace: String,
    thread: String,
}
impl AgentSession for MemorySession {
    fn provider_session_id(&self) -> Option<String> {
        self.inner.provider_session_id()
    }
    fn send(&self, input: AgentInput) -> std::result::Result<(), ProviderError> {
        let AgentInput::Text { text } = input;
        self.memory
            .capture(&self.workspace, MemorySourceKind::User, &self.thread, &text);
        let context = self
            .memory
            .retrieve(&self.workspace, &text)
            .unwrap_or_default();
        let text = if context.is_empty() {
            text
        } else {
            format!("{context}\n\nCurrent user request:\n{text}")
        };
        self.inner.send(AgentInput::Text { text })
    }
    fn interrupt(&self) -> std::result::Result<(), ProviderError> {
        self.inner.interrupt()
    }
    fn terminate(&self) -> std::result::Result<(), ProviderError> {
        self.inner.terminate()
    }
    fn respond_to_approval(
        &self,
        id: &str,
        decision: ApprovalDecision,
    ) -> std::result::Result<(), ProviderError> {
        self.inner.respond_to_approval(id, decision)
    }
}
