//! Fixed, version-bound Doctor repairs. No caller supplies a path, command or file content.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::ids::{is_valid_id, new_id};
use kalcode_contracts::permissions::{ActionKind, ActionOrigin, NormalizedAction};
use kalcode_core::{ErrorCategory, KalError, Result};
use serde::{Deserialize, Serialize};

use crate::checks::project::{MAX_ENV_FILES, is_env_file};
use crate::context::ProjectFacts;
use crate::gate::{FixGate, GateDecision};
use crate::store::{NewFixLog, Store};
use crate::types::{DoctorFinding, FixOutcome, FixPreview, FixRequest, RevertRequest};

pub const GITIGNORE_ENV: &str = "file.gitignore_env";
const MAX_GITIGNORE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoPayload {
    relative_path: String,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
}

#[derive(Clone)]
struct PendingApply {
    request: FixRequest,
    action: NormalizedAction,
    project_root: PathBuf,
    workspace_id: String,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
    summary: String,
}

#[derive(Clone)]
struct PendingRevert {
    request: RevertRequest,
    action: NormalizedAction,
    project_root: PathBuf,
    stored: crate::store::StoredFix,
    undo: UndoPayload,
}

pub struct FixExecutor {
    store: Arc<Store>,
    gate: Arc<dyn FixGate>,
    pending_apply: Mutex<HashMap<String, PendingApply>>,
    pending_revert: Mutex<HashMap<String, PendingRevert>>,
}

impl FixExecutor {
    pub fn new(store: Arc<Store>, gate: Arc<dyn FixGate>) -> Self {
        Self {
            store,
            gate,
            pending_apply: Mutex::new(HashMap::new()),
            pending_revert: Mutex::new(HashMap::new()),
        }
    }

    /// Reconciles journal rows left between the durable intent and completion records. It never
    /// writes a project file: current bytes decide whether the recorded change completed, never
    /// started, or became ambiguous while KalCode was stopped.
    pub fn reconcile(&self, project: &ProjectFacts) -> Result<usize> {
        let interrupted = self.store.interrupted(&project.workspace_id)?;
        if interrupted.is_empty() {
            return Ok(0);
        }
        let root = canonical_project(project)?;
        let target = checked_gitignore(&root)?;
        let mut reconciled = 0;
        for stored in interrupted {
            let id =
                stored.view.id.as_deref().ok_or_else(|| {
                    KalError::internal("fix_log_invalid", "The fix log is invalid.")
                })?;
            if stored.target_ref != "workspace:.gitignore" {
                self.store.mark_interrupted_failed(
                    id,
                    stored.view.status,
                    "recovery_target_invalid",
                )?;
                reconciled += 1;
                continue;
            }
            let undo: UndoPayload = match serde_json::from_str(&stored.undo_json) {
                Ok(undo) => undo,
                Err(_) => {
                    self.store.mark_interrupted_failed(
                        id,
                        stored.view.status,
                        "recovery_metadata_invalid",
                    )?;
                    reconciled += 1;
                    continue;
                }
            };
            if undo.relative_path != ".gitignore" {
                self.store.mark_interrupted_failed(
                    id,
                    stored.view.status,
                    "recovery_target_invalid",
                )?;
                reconciled += 1;
                continue;
            }
            let current = read_optional(&target)?;
            let matches_after = current.as_deref() == Some(undo.after.as_slice());
            let matches_before = current.as_deref() == undo.before.as_deref();
            match stored.view.status {
                crate::types::FixStatus::Applying if matches_after => {
                    self.store.mark_applied(id)?;
                }
                crate::types::FixStatus::Applying if matches_before => {
                    self.store.mark_interrupted_failed(
                        id,
                        crate::types::FixStatus::Applying,
                        "interrupted_before_write",
                    )?;
                }
                crate::types::FixStatus::Reverting if matches_before => {
                    self.store.mark_reverted(id)?;
                }
                crate::types::FixStatus::Reverting if matches_after => {
                    self.store.restore_applied_after_interrupted_revert(id)?;
                }
                status => {
                    self.store.mark_interrupted_failed(
                        id,
                        status,
                        "interrupted_target_ambiguous",
                    )?;
                }
            }
            reconciled += 1;
        }
        Ok(reconciled)
    }

    pub fn preview(
        &self,
        request: &FixRequest,
        finding: &DoctorFinding,
        project: Option<&ProjectFacts>,
    ) -> Result<FixPreview> {
        validate_request(request, finding)?;
        let option = finding
            .fixes
            .iter()
            .find(|option| option.fix_code == request.fix_code)
            .cloned()
            .ok_or_else(|| validation("unknown_fix", "That finding does not offer this fix."))?;
        if option.show_command_only {
            return Ok(FixPreview {
                run_id: request.run_id.clone(),
                finding_code: finding.code.clone(),
                fix: option,
                changes: vec!["Displays a recovery instruction. Nothing runs or changes.".into()],
                target: None,
                undo: "Nothing changes, so there is nothing to undo.".into(),
                needs_approval: false,
            });
        }
        let project = mutable_project(finding, project)?;
        let _pending = self.plan_apply(request, finding, project)?;
        Ok(FixPreview {
            run_id: request.run_id.clone(),
            finding_code: finding.code.clone(),
            fix: option,
            changes: finding
                .subjects
                .iter()
                .map(|subject| format!("Adds /{subject} to .gitignore."))
                .collect(),
            target: Some(".gitignore in this workspace".into()),
            undo: "Undo restores the exact bytes reviewed before the fix.".into(),
            needs_approval: true,
        })
    }

    pub fn apply(
        &self,
        request: &FixRequest,
        finding: &DoctorFinding,
        project: Option<&ProjectFacts>,
    ) -> Result<FixOutcome> {
        validate_request(request, finding)?;
        if let Some(option) = finding
            .fixes
            .iter()
            .find(|option| option.fix_code == request.fix_code)
        {
            if option.show_command_only {
                let command = option.command.clone().ok_or_else(|| {
                    KalError::internal(
                        "invalid_fix_catalog",
                        "That recovery instruction is unavailable.",
                    )
                })?;
                return Ok(FixOutcome::ShowCommand { command });
            }
        } else {
            return Err(validation(
                "unknown_fix",
                "That finding does not offer this fix.",
            ));
        }
        let project = mutable_project(finding, project)?;

        match request.approval_id.as_deref() {
            None => {
                let pending = self.plan_apply(request, finding, project)?;
                match self
                    .gate
                    .request(pending.action.clone())
                    .map_err(gate_error)?
                {
                    GateDecision::Allowed => self.execute_apply(pending, None),
                    GateDecision::Denied { reason } => Ok(FixOutcome::Denied {
                        reason: crate::checks::clean(&reason, 300),
                    }),
                    GateDecision::Asked { approval_id } => {
                        if !is_valid_id(&approval_id) {
                            return Err(KalError::internal(
                                "invalid_approval",
                                "The permission engine returned an invalid approval.",
                            ));
                        }
                        self.pending_apply
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .insert(approval_id.clone(), pending);
                        Ok(FixOutcome::AwaitingApproval { approval_id })
                    }
                }
            }
            Some(approval_id) => {
                let pending = self
                    .pending_apply
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get(approval_id)
                    .cloned();
                let pending = match pending {
                    Some(pending) => pending,
                    None if self.store.approval_claimed(approval_id)? => {
                        return Err(permission(
                            "fix_replayed",
                            "That exact fix approval was already used.",
                        ));
                    }
                    None => {
                        return Err(validation(
                            "approval_not_pending",
                            "That approval no longer belongs to a pending Doctor fix.",
                        ));
                    }
                };
                if pending.request.run_id != request.run_id
                    || pending.request.finding_code != request.finding_code
                    || pending.request.finding_version != request.finding_version
                    || pending.request.fix_code != request.fix_code
                {
                    return Err(permission(
                        "approval_object_changed",
                        "That approval belongs to a different finding or version.",
                    ));
                }
                match self
                    .gate
                    .confirm(approval_id, &pending.action)
                    .map_err(gate_error)?
                {
                    GateDecision::Allowed => {
                        let outcome = self.execute_apply(pending, Some(approval_id.to_owned()))?;
                        self.pending_apply
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .remove(approval_id);
                        Ok(outcome)
                    }
                    GateDecision::Asked { .. } => Ok(FixOutcome::AwaitingApproval {
                        approval_id: approval_id.to_owned(),
                    }),
                    GateDecision::Denied { reason } => Ok(FixOutcome::Denied {
                        reason: crate::checks::clean(&reason, 300),
                    }),
                }
            }
        }
    }

    pub fn revert(&self, request: &RevertRequest, project: &ProjectFacts) -> Result<FixOutcome> {
        match request.approval_id.as_deref() {
            None => {
                let pending = self.plan_revert(request, project)?;
                match self
                    .gate
                    .request(pending.action.clone())
                    .map_err(gate_error)?
                {
                    GateDecision::Allowed => self.execute_revert(pending, None),
                    GateDecision::Denied { reason } => Ok(FixOutcome::Denied {
                        reason: crate::checks::clean(&reason, 300),
                    }),
                    GateDecision::Asked { approval_id } => {
                        if !is_valid_id(&approval_id) {
                            return Err(KalError::internal(
                                "invalid_approval",
                                "The permission engine returned an invalid approval.",
                            ));
                        }
                        self.pending_revert
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .insert(approval_id.clone(), pending);
                        Ok(FixOutcome::AwaitingApproval { approval_id })
                    }
                }
            }
            Some(approval_id) => {
                let pending = self
                    .pending_revert
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get(approval_id)
                    .cloned()
                    .ok_or_else(|| {
                        validation(
                            "approval_not_pending",
                            "That approval no longer belongs to a pending Doctor undo.",
                        )
                    })?;
                if pending.request.fix_log_id != request.fix_log_id {
                    return Err(permission(
                        "approval_object_changed",
                        "That approval belongs to a different fix log entry.",
                    ));
                }
                match self
                    .gate
                    .confirm(approval_id, &pending.action)
                    .map_err(gate_error)?
                {
                    GateDecision::Allowed => {
                        let outcome = self.execute_revert(pending, Some(approval_id.to_owned()))?;
                        self.pending_revert
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .remove(approval_id);
                        Ok(outcome)
                    }
                    GateDecision::Asked { .. } => Ok(FixOutcome::AwaitingApproval {
                        approval_id: approval_id.to_owned(),
                    }),
                    GateDecision::Denied { reason } => Ok(FixOutcome::Denied {
                        reason: crate::checks::clean(&reason, 300),
                    }),
                }
            }
        }
    }

    fn plan_apply(
        &self,
        request: &FixRequest,
        finding: &DoctorFinding,
        project: &ProjectFacts,
    ) -> Result<PendingApply> {
        if request.fix_code != GITIGNORE_ENV {
            return Err(validation(
                "unknown_fix",
                "That mutable fix is not in the catalog.",
            ));
        }
        let root = canonical_project(project)?;
        let target = checked_gitignore(&root)?;
        let before = read_optional(&target)?;
        let after = gitignore_after(before.as_deref(), &finding.subjects)?;
        let action = action(
            &request.run_id,
            &request.fix_code,
            &project.workspace_id,
            &finding.version,
            false,
        );
        Ok(PendingApply {
            request: request.clone(),
            action,
            project_root: root,
            workspace_id: project.workspace_id.clone(),
            before,
            after,
            summary: "Add the detected environment files to .gitignore".into(),
        })
    }

    fn execute_apply(
        &self,
        pending: PendingApply,
        approval_id: Option<String>,
    ) -> Result<FixOutcome> {
        let target = checked_gitignore(&pending.project_root)?;
        if read_optional(&target)? != pending.before {
            return Err(conflict(
                "stale_target",
                ".gitignore changed after the fix was reviewed. Run the Doctor again.",
            ));
        }
        let undo = UndoPayload {
            relative_path: ".gitignore".into(),
            before: pending.before.clone(),
            after: pending.after.clone(),
        };
        let undo_json = serde_json::to_string(&undo).map_err(|_| {
            KalError::internal("undo_encode_failed", "KalCode couldn't record undo data.")
        })?;
        let log_id = self.store.reserve_fix(&NewFixLog {
            run_id: pending.request.run_id,
            finding_code: pending.request.finding_code,
            finding_version: pending.request.finding_version,
            fix_code: pending.request.fix_code,
            workspace_id: Some(pending.workspace_id),
            summary: pending.summary,
            target_ref: "workspace:.gitignore".into(),
            approval_id,
            undo_json,
        })?;
        if let Err(error) = atomic_replace(&pending.project_root, &target, &pending.after) {
            let _ = self.store.mark_failed(&log_id, error.code);
            return Err(error);
        }
        if read_optional(&target)? != Some(pending.after) {
            let _ = self.store.mark_failed(&log_id, "postcondition_failed");
            return Err(conflict(
                "postcondition_failed",
                "The file did not match the reviewed change after writing.",
            ));
        }
        self.store.mark_applied(&log_id)?;
        Ok(FixOutcome::Done {
            fix_log_id: log_id,
            message: "Added the detected environment files to .gitignore.".into(),
        })
    }

    fn plan_revert(
        &self,
        request: &RevertRequest,
        project: &ProjectFacts,
    ) -> Result<PendingRevert> {
        let stored = self
            .store
            .fix(&request.fix_log_id)?
            .ok_or_else(|| validation("fix_not_found", "That fix log entry doesn't exist."))?;
        if stored.view.status != crate::types::FixStatus::Applied || !stored.view.can_undo {
            return Err(conflict(
                "fix_not_reversible",
                "That fix cannot be undone now.",
            ));
        }
        if stored.view.workspace_id.as_deref() != Some(&project.workspace_id) {
            return Err(permission(
                "workspace_mismatch",
                "That fix belongs to a different workspace.",
            ));
        }
        let undo: UndoPayload = serde_json::from_str(&stored.undo_json).map_err(|_| {
            KalError::internal("undo_invalid", "The recorded undo data is invalid.")
        })?;
        if undo.relative_path != ".gitignore" {
            return Err(KalError::internal(
                "undo_invalid",
                "The recorded target is invalid.",
            ));
        }
        let root = canonical_project(project)?;
        let target = checked_gitignore(&root)?;
        if read_optional(&target)? != Some(undo.after.clone()) {
            return Err(conflict(
                "stale_target",
                ".gitignore changed after the fix. Undo would overwrite newer work.",
            ));
        }
        let action = action(
            &stored.run_id,
            &format!("undo.{}", stored.view.fix_code),
            &project.workspace_id,
            &stored.finding_version,
            true,
        );
        Ok(PendingRevert {
            request: request.clone(),
            action,
            project_root: root,
            stored,
            undo,
        })
    }

    fn execute_revert(
        &self,
        pending: PendingRevert,
        approval_id: Option<String>,
    ) -> Result<FixOutcome> {
        let target = checked_gitignore(&pending.project_root)?;
        if read_optional(&target)? != Some(pending.undo.after.clone()) {
            return Err(conflict(
                "stale_target",
                ".gitignore changed after Undo was reviewed.",
            ));
        }
        self.store.begin_revert(
            pending
                .stored
                .view
                .id
                .as_deref()
                .ok_or_else(|| KalError::internal("fix_log_invalid", "The fix log is invalid."))?,
            approval_id.as_deref(),
        )?;
        match pending.undo.before {
            Some(before) => atomic_replace(&pending.project_root, &target, &before)?,
            None => std::fs::remove_file(&target).map_err(|_| {
                storage(
                    "undo_write_failed",
                    "KalCode couldn't remove the file it created.",
                )
            })?,
        }
        let id = pending.stored.view.id.unwrap_or_default();
        self.store.mark_reverted(&id)?;
        Ok(FixOutcome::Done {
            fix_log_id: id,
            message: "Restored .gitignore to its exact earlier contents.".into(),
        })
    }
}

fn validate_request(request: &FixRequest, finding: &DoctorFinding) -> Result<()> {
    if !is_valid_id(&request.run_id) || !is_valid_id(&request.finding_version) {
        return Err(validation(
            "invalid_id",
            "The run or finding version is invalid.",
        ));
    }
    if request.finding_code != finding.code || request.finding_version != finding.version {
        return Err(conflict(
            "stale_finding",
            "That finding is no longer the current reviewed finding.",
        ));
    }
    Ok(())
}

fn mutable_project<'a>(
    finding: &DoctorFinding,
    project: Option<&'a ProjectFacts>,
) -> Result<&'a ProjectFacts> {
    let project = project
        .ok_or_else(|| conflict("doctor_no_project", "This fix requires an open workspace."))?;
    if finding.workspace_id.as_deref() != Some(&project.workspace_id) {
        return Err(conflict(
            "stale_finding",
            "That finding belongs to a different workspace.",
        ));
    }
    Ok(project)
}

fn action(
    run_id: &str,
    fix_code: &str,
    workspace_id: &str,
    finding_version: &str,
    undo: bool,
) -> NormalizedAction {
    NormalizedAction {
        id: new_id(),
        thread_id: String::new(),
        workspace_id: workspace_id.to_owned(),
        provider_id: ProviderId::new(""),
        action: ActionKind::DoctorFix {
            fix_code: fix_code.to_owned(),
            target: format!("workspace:.gitignore@{finding_version}"),
        },
        summary: if undo {
            "Undo the reviewed Environment Doctor .gitignore fix".into()
        } else {
            "Apply the reviewed Environment Doctor .gitignore fix".into()
        },
        requested_at: kalcode_core::time::now_rfc3339(),
        origin: Some(ActionOrigin::Doctor {
            run_id: run_id.to_owned(),
            fix_code: fix_code.to_owned(),
        }),
    }
}

fn canonical_project(project: &ProjectFacts) -> Result<PathBuf> {
    if !is_valid_id(&project.workspace_id) {
        return Err(validation("invalid_id", "The workspace id is invalid."));
    }
    let root = std::fs::canonicalize(&project.root).map_err(|_| {
        conflict(
            "workspace_unavailable",
            "The workspace folder is unavailable.",
        )
    })?;
    if !root.is_dir() || !root.join(".git").exists() {
        return Err(conflict(
            "workspace_not_repository",
            "The selected workspace is not a Git repository.",
        ));
    }
    Ok(root)
}

fn checked_gitignore(root: &Path) -> Result<PathBuf> {
    let workspace = kalcode_permissions::paths::Workspace::new(Some(root));
    let info = kalcode_permissions::paths::resolve(&workspace, None, ".gitignore");
    if info.outside || info.opaque || info.network || info.git_internal {
        return Err(permission(
            "unsafe_target",
            "KalCode couldn't prove that .gitignore is a normal file inside this workspace.",
        ));
    }
    let target = root.join(".gitignore");
    match std::fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_dir() => Err(permission(
            "unsafe_target",
            "KalCode won't replace a link or folder named .gitignore.",
        )),
        Ok(_) => Ok(target),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(target),
        Err(_) => Err(storage(
            "target_unreadable",
            "KalCode couldn't inspect .gitignore.",
        )),
    }
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) if bytes.len() <= MAX_GITIGNORE_BYTES => Ok(Some(bytes)),
        Ok(_) => Err(validation(
            "target_too_large",
            ".gitignore is too large for this bounded fix.",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(storage(
            "target_unreadable",
            "KalCode couldn't read .gitignore.",
        )),
    }
}

fn gitignore_after(before: Option<&[u8]>, subjects: &[String]) -> Result<Vec<u8>> {
    if subjects.is_empty() || subjects.len() > MAX_ENV_FILES {
        return Err(conflict(
            "stale_finding",
            "The finding no longer contains a bounded set of environment files.",
        ));
    }
    let mut entries = Vec::new();
    for subject in subjects {
        if subject.starts_with(['/', '\\'])
            || subject.contains('\0')
            || subject
                .split(['/', '\\'])
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(permission(
                "unsafe_subject",
                "The finding contains an unsafe file name.",
            ));
        }
        let file_name = subject.rsplit(['/', '\\']).next().unwrap_or("");
        if !is_env_file(file_name) {
            return Err(permission(
                "unsafe_subject",
                "The finding contains a file outside the fixed environment-file catalog.",
            ));
        }
        entries.push(format!("/{}", subject.replace('\\', "/")));
    }
    entries.sort();
    entries.dedup();

    let mut after = before.unwrap_or_default().to_vec();
    let current = std::str::from_utf8(&after)
        .map_err(|_| validation("target_not_text", ".gitignore is not UTF-8 text."))?;
    let existing: std::collections::HashSet<&str> = current.lines().map(str::trim).collect();
    entries.retain(|entry| !existing.contains(entry.as_str()));
    if entries.is_empty() {
        return Err(conflict(
            "finding_no_longer_current",
            "The environment files are already ignored.",
        ));
    }
    if !after.is_empty() && !after.ends_with(b"\n") {
        after.push(b'\n');
    }
    for entry in entries {
        after.extend_from_slice(entry.as_bytes());
        after.push(b'\n');
    }
    if after.len() > MAX_GITIGNORE_BYTES {
        return Err(validation(
            "target_too_large",
            "The resulting .gitignore would exceed the fix limit.",
        ));
    }
    Ok(after)
}

fn atomic_replace(root: &Path, target: &Path, bytes: &[u8]) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(root).map_err(|_| {
        storage(
            "target_write_failed",
            "KalCode couldn't create a temporary file.",
        )
    })?;
    temp.write_all(bytes)
        .and_then(|_| temp.flush())
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| {
            storage(
                "target_write_failed",
                "KalCode couldn't write the replacement file.",
            )
        })?;
    temp.persist(target).map_err(|_| {
        storage(
            "target_write_failed",
            "KalCode couldn't atomically replace .gitignore.",
        )
    })?;
    #[cfg(unix)]
    {
        if let Ok(directory) = std::fs::File::open(root) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

fn gate_error(_: String) -> KalError {
    permission(
        "permission_unavailable",
        "The permission engine couldn't authorize this fix.",
    )
}

fn validation(code: &'static str, message: &'static str) -> KalError {
    KalError::validation(code, message)
}

fn conflict(code: &'static str, message: &'static str) -> KalError {
    KalError::new(ErrorCategory::Verification, code, message)
}

fn permission(code: &'static str, message: &'static str) -> KalError {
    KalError::new(ErrorCategory::Permission, code, message)
}

fn storage(code: &'static str, message: &'static str) -> KalError {
    KalError::new(ErrorCategory::Filesystem, code, message)
}
