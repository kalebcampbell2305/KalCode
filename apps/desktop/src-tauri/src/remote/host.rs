//! The desktop's [`RemoteHost`]: the canonical state a device mirrors and the operations it may
//! run. Each call borrows the account's services briefly (never holding a lease between calls).

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use kalcode_contracts::permissions::{ApprovalDecision, ApprovalStatus};
use kalcode_remote::ops::Op;
use kalcode_remote::registry::Device;
use kalcode_remote::server::RemoteHost;
use kalcode_remote::wire::{ErrorCode, RemoteError, RemoteState, Workstation};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use time::OffsetDateTime;

use super::snapshot::{self, Inputs, Operations, PendingApproval};
use super::{actions, entitled};
use crate::AppState;
use crate::operations_commands::OperationsState;
use crate::permission_commands::PermissionState;
use crate::provider_pane_commands::ProviderPanesState;
use crate::runtime_coordinator::RuntimeState;
use crate::thread_commands::ThreadsState;

/// What every connection shares: the workstation identity and the Operations part of the state,
/// which the Remote worker refreshes on its own cadence (it is too heavy for every patch).
pub struct DesktopHost {
    pub app: AppHandle,
    /// Its id is set once the workstation identity exists (first Remote use).
    pub workstation: Mutex<Workstation>,
    pub operations: Mutex<Operations>,
}

impl DesktopHost {
    pub fn workstation(&self) -> Workstation {
        self.workstation
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn operations(&self) -> Operations {
        self.operations
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Re-reads Operations; returns the previous and the new value when they differ.
    pub fn refresh_operations(&self) -> Option<(Operations, Operations)> {
        let next = read_operations(&self.app)?;
        let mut current = self
            .operations
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if *current == next {
            return None;
        }
        let previous = std::mem::replace(&mut *current, next.clone());
        Some((previous, next))
    }
}

impl RemoteHost for DesktopHost {
    fn snapshot(&self) -> RemoteState {
        collect(&self.app, &self.workstation(), self.operations())
    }

    async fn handle(&self, device: &Device, op: &str, args: Value) -> Result<Value, RemoteError> {
        if !entitled(&self.app) {
            return Err(RemoteError::new(
                ErrorCode::NotEntitled,
                "KalCode Remote isn't included in this account's plan.",
            ));
        }
        let op = Op::parse(op, args)?;
        let (app, device) = (self.app.clone(), device.clone());
        tauri::async_runtime::spawn_blocking(move || actions::run(&app, &device, op))
            .await
            .unwrap_or_else(|_| Err(RemoteError::internal("The operation failed.")))
    }
}

/// The current canonical state. Services that are not running (signing out, recovering) read
/// as empty rather than failing the connection.
pub fn collect(app: &AppHandle, base: &Workstation, operations: Operations) -> RemoteState {
    let now = OffsetDateTime::now_utc();
    let core = app.state::<AppState>().core.clone();
    let mut workstation = base.clone();
    let workspaces = core
        .as_deref()
        .and_then(|core| actions::workspaces(core).ok())
        .unwrap_or_default();
    workstation.active_workspace_id = core
        .as_deref()
        .and_then(|core| core.active_workspace().ok().flatten())
        .map(|w| w.id);
    let threads = (|| {
        let threads = RuntimeState::<ThreadsState>::from_app(app).ok()?;
        let mut list = threads.runtime().ok()?.list(None, false).ok()?;
        drop(threads);
        if let Ok(panes) = RuntimeState::<ProviderPanesState>::from_app(app) {
            for thread in &mut list {
                panes.stamp_runtime_kind(thread);
            }
        }
        Some(list)
    })()
    .unwrap_or_default();
    let approvals = (|| {
        let permissions = RuntimeState::<PermissionState>::from_app(app).ok()?;
        let service = permissions.service()?;
        let pending = service
            .list_approvals(Some(ApprovalStatus::Pending))
            .ok()?
            .into_iter()
            .map(|a| PendingApproval {
                approvable: a.allowed_decisions.contains(&ApprovalDecision::ApproveOnce),
                id: a.id,
                thread_id: a.action.thread_id,
                summary: a.action.summary,
                requested_at: a.action.requested_at,
            })
            .collect();
        Some(pending)
    })()
    .unwrap_or_default();
    snapshot::build(Inputs {
        workstation,
        workspaces,
        threads,
        approvals,
        sign_outs: actions::sign_outs(app),
        operations,
        now,
    })
}

fn read_operations(app: &AppHandle) -> Option<Operations> {
    let operations = RuntimeState::<OperationsState>::from_app(app).ok()?;
    let snapshot = operations.snapshot().ok()?;
    drop(operations);
    let names: HashMap<String, String> = app
        .state::<AppState>()
        .core
        .as_deref()?
        .workspaces()
        .ok()?
        .into_iter()
        .map(|w| (w.id, w.name))
        .collect();
    Some(snapshot::operations(
        &snapshot,
        &names,
        OffsetDateTime::now_utc(),
    ))
}
