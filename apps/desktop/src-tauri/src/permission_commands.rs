//! Permission IPC (campaign Z4). Names and shapes follow `docs/CONTRACTS.md`:
//! `approval_list`, `approval_decide`, `permission_profiles_list`, `thread_set_permission_mode`,
//! plus the additive `permission_settings_get` / `permission_settings_update` (default mode for
//! new threads).
//!
//! Every command runs as [`Actor::User`]: the WebView is KalCode's own UI. Agents, providers and
//! KalVoice never reach these commands; they go through `PermissionGate` in native code, which
//! can't answer requests or change modes.
//!
//! Wiring seams (see `docs/campaigns/Z4.md`):
//! * [`WorkspaceRoots`] — Z1 supplies workspace roots. Until then [`NoWorkspaces`]: every path
//!   is outside the workspace (fail closed).
//! * [`ThreadModeStore`] — Z3 supplies thread modes. Until then [`NoThreads`]:
//!   `thread_set_permission_mode` reports `thread_not_found`.

use std::sync::Arc;

use kalcode_contracts::permissions::{
    ApprovalDecision, ApprovalStatus, PermissionMode, PermissionProfile,
};
use kalcode_contracts::threads::ThreadSummary;
use kalcode_core::{Core, IpcError, KalError, Result};
use kalcode_permissions::{
    Actor, ApprovalView, NoThreads, NoWorkspaces, PermissionService, PermissionSettings,
    ThreadModeStore, WorkspaceRoots,
};
use tauri::State;

use crate::AppState;

/// Managed state: the permission service, when the core started.
pub struct PermissionState {
    service: Option<Arc<PermissionService>>,
}

impl PermissionState {
    /// Builds the service over the running core with the given integration seams.
    pub fn new(
        core: Option<Arc<Core>>,
        workspaces: Arc<dyn WorkspaceRoots>,
        threads: Arc<dyn ThreadModeStore>,
    ) -> Self {
        let service = core.and_then(|core| {
            PermissionService::new(core, workspaces, threads)
                .map(Arc::new)
                .map_err(|error| {
                    tracing::error!(event = "permissions.start_failed", error = %error.diagnostic());
                })
                .ok()
        });
        Self { service }
    }

    /// Z4 branch wiring: no workspaces (Z1) or threads (Z3) yet.
    pub fn unwired(core: Option<Arc<Core>>) -> Self {
        Self::new(core, Arc::new(NoWorkspaces), Arc::new(NoThreads))
    }

    /// The gate for the thread runtime (Z3) to hold.
    pub fn service(&self) -> Option<Arc<PermissionService>> {
        self.service.clone()
    }

    fn get(&self, app: &AppState) -> std::result::Result<&Arc<PermissionService>, IpcError> {
        // Surface the startup error first (e.g. a newer database), then a generic one.
        app.core()?;
        self.service.as_ref().ok_or_else(|| {
            KalError::internal(
                "permissions_unavailable",
                "KalCode's permission engine isn't available.",
            )
            .to_ipc()
        })
    }
}

/// Migrations for the desktop core on the Z4 branch: 0001, placeholders for 0002–0004 (owned by
/// Z1–Z3), then 0005. **Branch only** — at integration the shell goes back to `Core::open` once
/// `PERMISSIONS_MIGRATION` is registered in `kalcode_core::db::MIGRATIONS`.
pub fn branch_migrations() -> Vec<kalcode_core::db::Migration> {
    kalcode_permissions::branch::migrations_with_placeholders()
}

fn convert<T>(command: &'static str, result: Result<T>) -> std::result::Result<T, IpcError> {
    result.map_err(|e| e.log_and_convert(command))
}

/// Approval requests, newest first. `status: "pending"` lists only those awaiting an answer.
#[tauri::command(async)]
pub fn approval_list(
    app: State<'_, AppState>,
    permissions: State<'_, PermissionState>,
    status: Option<ApprovalStatus>,
) -> std::result::Result<Vec<ApprovalView>, IpcError> {
    let service = permissions.get(&app)?;
    convert("approval_list", service.list_approvals(status))
}

/// Records the user's answer to a pending approval request.
#[tauri::command(async)]
pub fn approval_decide(
    app: State<'_, AppState>,
    permissions: State<'_, PermissionState>,
    request_id: String,
    decision: ApprovalDecision,
) -> std::result::Result<ApprovalView, IpcError> {
    let service = permissions.get(&app)?;
    convert(
        "approval_decide",
        service.decide(&request_id, decision, Actor::User),
    )
}

/// Built-in and saved permission profiles.
#[tauri::command(async)]
pub fn permission_profiles_list(
    app: State<'_, AppState>,
    permissions: State<'_, PermissionState>,
) -> std::result::Result<Vec<PermissionProfile>, IpcError> {
    let service = permissions.get(&app)?;
    convert("permission_profiles_list", service.profiles())
}

/// Changes a thread's permission mode. Bypass requires `confirmBypass: true`.
#[tauri::command(async)]
pub fn thread_set_permission_mode(
    app: State<'_, AppState>,
    permissions: State<'_, PermissionState>,
    thread_id: String,
    mode: PermissionMode,
    confirm_bypass: Option<bool>,
    profile_id: Option<String>,
) -> std::result::Result<ThreadSummary, IpcError> {
    let service = permissions.get(&app)?;
    convert(
        "thread_set_permission_mode",
        service.set_thread_mode(
            &thread_id,
            mode,
            confirm_bypass == Some(true),
            profile_id.as_deref(),
            Actor::User,
        ),
    )
}

/// The default permission mode for new threads.
#[tauri::command(async)]
pub fn permission_settings_get(
    app: State<'_, AppState>,
    permissions: State<'_, PermissionState>,
) -> std::result::Result<PermissionSettings, IpcError> {
    let service = permissions.get(&app)?;
    convert("permission_settings_get", service.settings())
}

/// Changes the default mode for new threads. Bypass requires `confirmBypass: true`.
#[tauri::command(async)]
pub fn permission_settings_update(
    app: State<'_, AppState>,
    permissions: State<'_, PermissionState>,
    default_mode: PermissionMode,
    profile_id: Option<String>,
    confirm_bypass: Option<bool>,
) -> std::result::Result<PermissionSettings, IpcError> {
    let service = permissions.get(&app)?;
    convert(
        "permission_settings_update",
        service.update_settings(
            default_mode,
            profile_id.as_deref(),
            confirm_bypass == Some(true),
            Actor::User,
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwired_service_starts_over_a_real_core() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = kalcode_core::CoreConfig {
            paths: kalcode_core::Paths::new(dir.path()),
            app_version: "0.0.0-test".into(),
            channel: kalcode_core::flags::BuildChannel::Development,
        };
        let core =
            Arc::new(Core::open_with_migrations(config, &branch_migrations()).expect("core"));
        let state = PermissionState::unwired(Some(core));
        let service = state.service().expect("service");
        assert_eq!(service.list_approvals(None).expect("list").len(), 0);
        assert_eq!(
            service.settings().expect("settings").default_mode,
            PermissionMode::Approve
        );
        // Without threads (Z3), changing a thread's mode reports that the thread doesn't exist.
        let error = service
            .set_thread_mode(
                &kalcode_contracts::ids::new_id(),
                PermissionMode::Plan,
                false,
                None,
                Actor::User,
            )
            .expect_err("no threads");
        assert_eq!(error.code, "thread_not_found");
    }

    #[test]
    fn missing_core_yields_no_service() {
        assert!(PermissionState::unwired(None).service().is_none());
    }
}
