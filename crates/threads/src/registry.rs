//! Integration seams: the providers a thread can use and the workspaces it can run in.
//!
//! Both are owned by other campaigns. The thread runtime depends only on these boundaries:
//! - [`ProviderRegistry`] holds `Arc<dyn AgentProvider>` adapters (Z2 registers Claude Code,
//!   Codex, …). Nothing is registered until an adapter exists; tests register fakes.
//! - [`WorkspaceResolver`] maps a workspace id to its name and canonical root (Z1 implements it
//!   over its `workspaces` table). Until then [`NoWorkspaces`] reports that none exist.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use kalcode_contracts::agent::{AgentProvider, ProviderId};
use kalcode_core::{ErrorCategory, KalError, Result};

/// A registered provider adapter and the account it uses.
#[derive(Clone)]
pub struct ProviderEntry {
    pub provider: Arc<dyn AgentProvider>,
    /// Display label of the connected account ("Personal"); never a credential.
    pub account_label: Option<String>,
    /// Opaque secure-store reference passed to sessions for API-key accounts; never the key.
    pub secret_ref: Option<String>,
}

/// The provider adapters available to threads.
#[derive(Default)]
pub struct ProviderRegistry {
    providers: RwLock<BTreeMap<ProviderId, ProviderEntry>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers (or replaces) the adapter for its provider id.
    pub fn register(&self, provider: Arc<dyn AgentProvider>) {
        self.register_entry(ProviderEntry {
            provider,
            account_label: None,
            secret_ref: None,
        });
    }

    pub fn register_entry(&self, entry: ProviderEntry) {
        let id = entry.provider.id();
        self.write().insert(id, entry);
    }

    /// Removes a provider (e.g. disconnected). Its running threads keep their sessions.
    pub fn unregister(&self, id: &ProviderId) -> bool {
        self.write().remove(id).is_some()
    }

    pub fn get(&self, id: &ProviderId) -> Option<ProviderEntry> {
        self.read().get(id).cloned()
    }

    pub fn entries(&self) -> Vec<ProviderEntry> {
        self.read().values().cloned().collect()
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, BTreeMap<ProviderId, ProviderEntry>> {
        self.providers
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, BTreeMap<ProviderId, ProviderEntry>> {
        self.providers
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A workspace as the thread runtime needs it. `root` is canonical and native-resolved; it
/// never comes from the WebView and never crosses IPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedWorkspace {
    pub id: String,
    pub name: String,
    pub root: PathBuf,
}

/// Resolves workspaces for the thread runtime. Implemented by Z1 over its workspace store.
///
/// Implementations must not call back into the thread runtime, and must be safe to call from
/// any thread. They may read the database through `Core` (the runtime never holds the
/// database lock while calling a resolver).
pub trait WorkspaceResolver: Send + Sync {
    /// Workspaces a new thread may use, in display order.
    fn list(&self) -> Result<Vec<ResolvedWorkspace>>;
    /// The workspace with this id; `workspace_not_found` when it no longer exists.
    fn resolve(&self, workspace_id: &str) -> Result<ResolvedWorkspace>;
}

/// The resolver used until workspaces exist (Z1): there are none.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoWorkspaces;

impl WorkspaceResolver for NoWorkspaces {
    fn list(&self) -> Result<Vec<ResolvedWorkspace>> {
        Ok(Vec::new())
    }

    fn resolve(&self, _workspace_id: &str) -> Result<ResolvedWorkspace> {
        Err(workspace_not_found())
    }
}

pub fn workspace_not_found() -> KalError {
    KalError::new(
        ErrorCategory::Filesystem,
        "workspace_not_found",
        "That workspace isn't available. It may have been removed from KalCode.",
    )
}
