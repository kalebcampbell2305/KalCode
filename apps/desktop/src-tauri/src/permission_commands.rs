//! Permission IPC (campaign Z4). Names and shapes follow `docs/CONTRACTS.md`:
//! `approval_list`, `approval_decide`, `permission_profiles_list`, `thread_set_permission_mode`,
//! plus the additive `permission_settings_get` / `permission_settings_update` (default mode for
//! new threads).
//!
//! Every command runs as [`Actor::User`]: the WebView is KalCode's own UI. Agents, providers and
//! KalVoice never reach these commands; they go through `PermissionGate` in native code, which
//! can't answer requests or change modes.
//!
//! Wiring (lib.rs): [`WorkspaceRoots`] is `CoreWorkspaceRoots` over Z1's workspaces, and
//! [`ThreadModeStore`] is the thread runtime (`thread_commands::ThreadModes`, Z3), which also
//! holds the service as its `PermissionGate`. [`NoWorkspaces`] / [`NoThreads`] remain for
//! tests and a core that failed to start.

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

fn convert<T>(command: &'static str, result: Result<T>) -> std::result::Result<T, IpcError> {
    result.map_err(|e| e.log_and_convert(command))
}

/// Approval requests, newest first. `status: "pending"` lists only those awaiting an answer.
#[tauri::command(async)]
pub fn approval_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    permissions: crate::runtime_coordinator::RuntimeState<PermissionState>,
    status: Option<ApprovalStatus>,
) -> std::result::Result<Vec<ApprovalView>, IpcError> {
    _runtime_access.revalidate()?;
    let service = permissions.get(&app)?;
    convert("approval_list", service.list_approvals(status))
}

/// Records the user's answer to a pending approval request.
#[tauri::command(async)]
pub fn approval_decide(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    permissions: crate::runtime_coordinator::RuntimeState<PermissionState>,
    request_id: String,
    decision: ApprovalDecision,
) -> std::result::Result<ApprovalView, IpcError> {
    _runtime_access.revalidate()?;
    let service = permissions.get(&app)?;
    convert(
        "approval_decide",
        service.decide(&request_id, decision, Actor::User),
    )
}

/// Built-in and saved permission profiles.
#[tauri::command(async)]
pub fn permission_profiles_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    permissions: crate::runtime_coordinator::RuntimeState<PermissionState>,
) -> std::result::Result<Vec<PermissionProfile>, IpcError> {
    _runtime_access.revalidate()?;
    let service = permissions.get(&app)?;
    convert("permission_profiles_list", service.profiles())
}

/// Changes a thread's permission mode. Bypass requires `confirmBypass: true`.
#[tauri::command(async)]
pub fn thread_set_permission_mode(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    permissions: crate::runtime_coordinator::RuntimeState<PermissionState>,
    thread_id: String,
    mode: PermissionMode,
    confirm_bypass: Option<bool>,
    profile_id: Option<String>,
) -> std::result::Result<ThreadSummary, IpcError> {
    _runtime_access.revalidate()?;
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
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    permissions: crate::runtime_coordinator::RuntimeState<PermissionState>,
) -> std::result::Result<PermissionSettings, IpcError> {
    _runtime_access.revalidate()?;
    let service = permissions.get(&app)?;
    convert("permission_settings_get", service.settings())
}

/// Changes the default mode for new threads. Bypass requires `confirmBypass: true`.
#[tauri::command(async)]
pub fn permission_settings_update(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    permissions: crate::runtime_coordinator::RuntimeState<PermissionState>,
    default_mode: PermissionMode,
    profile_id: Option<String>,
    confirm_bypass: Option<bool>,
) -> std::result::Result<PermissionSettings, IpcError> {
    _runtime_access.revalidate()?;
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

/// One result of [`test_permission_probe`].
#[cfg(any(debug_assertions, feature = "e2e"))]
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub probe: &'static str,
    pub effect: kalcode_contracts::permissions::PolicyEffect,
    pub scopes: Vec<kalcode_contracts::permissions::PermissionScope>,
    pub reason: String,
}

/// **Test hook** (debug and `e2e` builds only; not compiled into, or registered by, shipped
/// builds). Evaluates two fixed actions with the real engine and the workspace's real root, in
/// Approve mode, without a thread or provider: reading `README.md` inside the workspace, and writing `outside.txt` in
/// the folder that contains it. Paths are built natively from the workspace root; the WebView
/// supplies only the workspace id. Nothing is stored, approved or run.
#[cfg(any(debug_assertions, feature = "e2e"))]
#[tauri::command(async)]
pub fn test_permission_probe(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    app: State<'_, AppState>,
    permissions: crate::runtime_coordinator::RuntimeState<PermissionState>,
    workspace_id: String,
) -> std::result::Result<Vec<ProbeResult>, IpcError> {
    _runtime_access.revalidate()?;
    use kalcode_contracts::agent::ProviderId;
    use kalcode_contracts::permissions::{ActionKind, NormalizedAction};

    if !crate::environment::TEST_HOOKS_ENABLED {
        return Err(KalError::validation(
            "test_hooks_disabled",
            "This build doesn't include test hooks.",
        )
        .to_ipc());
    }
    let service = permissions.get(&app)?;
    let workspace = convert("test_permission_probe", app.core()?.workspaces())?
        .into_iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| {
            KalError::validation("workspace_not_found", "No such workspace.").to_ipc()
        })?;
    let root = std::path::PathBuf::from(&workspace.root_path);
    let outside = root.parent().unwrap_or(&root).join("outside.txt");
    let probes = [
        (
            "read_inside",
            ActionKind::FileRead {
                path: root.join("README.md").to_string_lossy().into_owned(),
            },
        ),
        (
            "write_outside",
            ActionKind::FileWrite {
                path: outside.to_string_lossy().into_owned(),
            },
        ),
    ];
    Ok(probes
        .into_iter()
        .map(|(probe, kind)| {
            let action = NormalizedAction {
                id: kalcode_contracts::ids::new_id(),
                thread_id: kalcode_contracts::ids::new_id(),
                workspace_id: workspace.id.clone(),
                provider_id: ProviderId::new(ProviderId::CLAUDE_CODE),
                action: kind,
                summary: probe.to_owned(),
                requested_at: kalcode_core::time::now_rfc3339(),
                origin: None,
            };
            let (_, decision) = service.evaluate_detailed(&action, PermissionMode::Approve);
            ProbeResult {
                probe,
                effect: decision.effect,
                scopes: decision.scopes,
                reason: decision.reason,
            }
        })
        .collect())
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
        let core = Arc::new(Core::open(config).expect("core"));
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
