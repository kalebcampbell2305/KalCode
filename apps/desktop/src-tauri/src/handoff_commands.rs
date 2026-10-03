//! Native authority for handoffs between real interactive coding-agent panes.
//!
//! Durable rows contain lifecycle metadata only. Capsules remain bounded and process-local;
//! startup and account-runtime shutdown interrupt unfinished rows rather than replaying them.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use kalcode_context::firewall::{Firewall, FirewallPolicy};
use kalcode_context::model::{ContextPurpose, ItemKind, ItemOrigin, RuleEffect};
use kalcode_context::never_share::NeverShareRules;
use kalcode_context::package::{ContextItem, ContextPackage, PackageOptions, SendCheck};
use kalcode_context::provider::TextOnlyDefaults;
use kalcode_context::store::{self as context_store, DeliveryState, PackageStatus};
use kalcode_contracts::app::FeatureId;
use kalcode_contracts::git::{ConflictKind, GitFileChange, StatusFile};
use kalcode_contracts::handoffs::{
    HandoffCompletion, HandoffPreview, HandoffRecord, HandoffStatus, HandoffTask,
};
use kalcode_contracts::threads::{ThreadRuntimeKind, ThreadStatus, ThreadSummary};
use kalcode_core::flags::SurfaceState;
use kalcode_core::handoffs::{HandoffStore, NewHandoff};
use kalcode_core::plans::PlanTier;
use kalcode_core::{Core, ErrorCategory, IpcError, KalError, Result};
use kalcode_git::{GitCore, WorkspaceRoot};
use kalcode_providers::interactive::provider::HandoffDeliveryError;
use time::OffsetDateTime;

use crate::account::runtime::AccountRuntime;
use crate::git_commands::GitState;
use crate::provider_pane_commands::ProviderPanesState;
use crate::runtime_coordinator::{RuntimeAccess, RuntimeState};
use crate::thread_commands::ThreadsState;

const PREVIEW_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_DRAFTS: usize = 64;
const MAX_INSTRUCTIONS_CHARS: usize = 16_000;
const MAX_CAPSULE_CHARS: usize = 32_000;

#[derive(Clone)]
struct Draft {
    preview: HandoffPreview,
    package: ContextPackage,
    target_instance_id: String,
    expires: Instant,
    return_of_id: Option<String>,
    source_status: Vec<SourceStatusEntry>,
    queued_at: Option<Instant>,
    next_attempt: Instant,
    retry_delay: Duration,
}

#[derive(Clone, PartialEq, Eq)]
struct SourceStatusEntry {
    path: String,
    orig_path: Option<String>,
    staged: Option<GitFileChange>,
    unstaged: Option<GitFileChange>,
    untracked: bool,
    conflict: Option<ConflictKind>,
    submodule: bool,
}

pub struct HandoffState {
    core: Arc<Core>,
    store: HandoffStore,
    threads: Arc<ThreadsState>,
    panes: Arc<ProviderPanesState>,
    git: Arc<GitCore>,
    account: Arc<AccountRuntime>,
    drafts: Mutex<HashMap<String, Draft>>,
    dispatch_gate: Mutex<()>,
    stop: Arc<(Mutex<bool>, Condvar)>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl HandoffState {
    pub(crate) fn start(
        core: Arc<Core>,
        threads: Arc<ThreadsState>,
        panes: Arc<ProviderPanesState>,
        git: Arc<GitState>,
        account: Arc<AccountRuntime>,
        app: &tauri::AppHandle,
    ) -> Result<Arc<Self>> {
        let store = HandoffStore::new(core.clone());
        store.recover_interrupted()?;
        let state = Arc::new(Self {
            core,
            store,
            threads,
            panes,
            git: git.0.clone(),
            account,
            drafts: Mutex::new(HashMap::new()),
            dispatch_gate: Mutex::new(()),
            stop: Arc::new((Mutex::new(false), Condvar::new())),
            worker: Mutex::new(None),
        });
        let weak = Arc::downgrade(&state);
        let stop = state.stop.clone();
        let app = app.clone();
        let worker = std::thread::Builder::new()
            .name("handoff-delivery".into())
            .spawn(move || {
                loop {
                    let (lock, wake) = &*stop;
                    let Ok(stopping) = lock.lock() else { break };
                    let Ok((stopping, _)) = wake.wait_timeout(stopping, Duration::from_secs(1))
                    else {
                        break;
                    };
                    if *stopping {
                        break;
                    }
                    drop(stopping);
                    let Some(state) = weak.upgrade() else { break };
                    let Ok(lease) = RuntimeState::<HandoffState>::from_app(&app) else {
                        continue;
                    };
                    if lease.revalidate_core().is_err() || state.require_entitled().is_err() {
                        continue;
                    }
                    let Ok(_gate) = state.dispatch_gate.try_lock() else {
                        continue;
                    };
                    if let Err(error) = state.dispatch_queued() {
                        tracing::warn!(event = "handoff.dispatch_failed", code = error.code);
                    }
                }
            })
            .map_err(|error| {
                KalError::internal(
                    "handoff_worker_unavailable",
                    "KalCode could not start handoff delivery.",
                )
                .with_source(error)
            })?;
        *state.worker.lock().map_err(|_| poisoned())? = Some(worker);
        Ok(state)
    }

    pub(crate) fn shutdown_checked(&self) -> bool {
        let (lock, wake) = &*self.stop;
        let Ok(mut stopping) = lock.lock() else {
            return false;
        };
        *stopping = true;
        wake.notify_all();
        drop(stopping);
        let worker_clean = self
            .worker
            .lock()
            .map(|mut worker| worker.take().is_none_or(|worker| worker.join().is_ok()))
            .unwrap_or(false);
        let drafts_clean = self.drafts.lock().map(|mut drafts| drafts.clear()).is_ok();
        worker_clean && drafts_clean && self.store.recover_interrupted().is_ok()
    }

    fn wake(&self) {
        self.stop.1.notify_all();
    }

    fn require_entitled(&self) -> Result<()> {
        let flags = self.core.app_info().flags;
        let enabled = flags.features.iter().any(|flag| {
            flag.id == FeatureId::ProviderHandoff
                && flag.visible
                && matches!(flag.state, SurfaceState::Available | SurfaceState::Preview)
        });
        if !enabled {
            return Err(KalError::validation(
                "provider_handoff_unavailable",
                "Agent Hand Off is not available in this build.",
            ));
        }
        if !plan_allows_handoff(self.account.snapshot().plan_tier()) {
            return Err(KalError::validation(
                "provider_handoff_requires_pro",
                "Agent Hand Off is available on KalCode Pro and higher plans.",
            ));
        }
        Ok(())
    }

    // Keep the validated preview fields explicit, matching the IPC contract and return path.
    #[allow(clippy::too_many_arguments)]
    fn preview(
        &self,
        source_thread_id: &str,
        target_thread_id: &str,
        task: HandoffTask,
        instructions: &str,
        edited_text: Option<&str>,
        return_of_id: Option<String>,
        prior_preview_id: Option<&str>,
    ) -> Result<HandoffPreview> {
        self.require_entitled()?;
        let instructions = normalize_newlines(instructions);
        let edited_text = edited_text.map(normalize_newlines);
        if !instructions.is_empty() {
            validate_text(
                &instructions,
                MAX_INSTRUCTIONS_CHARS,
                "invalid_handoff_instructions",
            )?;
        }
        if let Some(text) = edited_text.as_deref() {
            validate_text(text, MAX_CAPSULE_CHARS, "invalid_handoff_text")?;
        }
        let prior = prior_preview_id
            .map(|prior_id| -> Result<Draft> {
                let drafts = self.drafts.lock().map_err(|_| poisoned())?;
                let prior = drafts.get(prior_id).cloned().ok_or_else(|| {
                    KalError::validation(
                        "handoff_preview_unknown",
                        "That earlier handoff preview expired or belongs to another runtime.",
                    )
                })?;
                if prior.queued_at.is_some() {
                    return Err(KalError::validation(
                        "handoff_preview_already_sent",
                        "That handoff preview was already sent and can no longer be edited.",
                    ));
                }
                validate_prior_binding(
                    &prior.preview,
                    prior.expires,
                    source_thread_id,
                    target_thread_id,
                    task,
                )?;
                Ok(prior)
            })
            .transpose()?;
        let return_of_id = prior
            .as_ref()
            .and_then(|prior| prior.return_of_id.clone())
            .or(return_of_id);
        let (source, target, pane) =
            self.validate_pair(source_thread_id, target_thread_id, task)?;
        let root = self.source_root(&source)?;
        let status = self.git.status(&root)?;
        let source_commit = status
            .as_ref()
            .and_then(|status| status.branch.head_oid.clone());
        let source_branch = status
            .as_ref()
            .and_then(|status| status.branch.branch.clone())
            .or_else(|| source.branch.clone());
        let source_dirty = status
            .as_ref()
            .is_some_and(|status| status.summary.changed > 0 || status.summary.untracked > 0);
        let source_status = status
            .as_ref()
            .map(|status| source_status_signature(&status.files))
            .unwrap_or_default();
        if matches!(task, HandoffTask::Fix | HandoffTask::Continue)
            && !self.source_stopped_or_isolated(&source, &target, source_dirty)?
        {
            return Err(KalError::validation(
                "handoff_write_ownership_unsafe",
                "Stop the sending agent, or use separate clean agent worktrees, before handing off write ownership.",
            ));
        }

        let warnings = warnings(&source, &target, task, source_dirty);
        let firewall = self.firewall(&source.workspace_id, root.path())?;
        let changed_paths: Vec<String> = status
            .as_ref()
            .into_iter()
            .flat_map(|status| status.files.iter())
            .filter(|file| {
                let (_, reasons) = firewall.check_path(&file.path, false);
                !reasons.iter().any(|reason| {
                    matches!(
                        reason.effect,
                        RuleEffect::Block | RuleEffect::BlockOverridable
                    )
                })
            })
            .take(40)
            .map(|file| kalcode_context::package::sanitize_label(&file.path))
            .collect();
        let generated = edited_text.as_deref().map_or_else(
            || {
                capsule_text(
                    &source,
                    &target,
                    task,
                    &instructions,
                    source_commit.as_deref(),
                    source_branch.as_deref(),
                    source_dirty,
                    source.worktree_id.as_deref(),
                    &changed_paths,
                )
            },
            str::to_owned,
        );
        let mut options = PackageOptions::new(ContextPurpose::Handoff);
        options.workspace_id = Some(source.workspace_id.clone());
        options.target_thread_id = Some(target.id.clone());
        options.package_cap_bytes = 64 * 1024;
        let package = ContextPackage::build(
            &firewall,
            &TextOnlyDefaults::new(target.provider_id.as_str()),
            options,
            vec![ContextItem::text(
                ItemKind::Text,
                "Agent handoff capsule",
                ItemOrigin::User,
                generated,
            )],
        );
        let rendered = match package.check_before_send(package.content_sha256(), &firewall)? {
            SendCheck::Ready(rendered) => rendered.text(),
            SendCheck::Stale(_) => {
                return Err(KalError::internal(
                    "handoff_preview_unstable",
                    "KalCode could not create a stable handoff preview.",
                ));
            }
        };
        if rendered.trim().is_empty() {
            return Err(KalError::validation(
                "handoff_blocked_by_firewall",
                "The Context Firewall blocked this handoff text.",
            ));
        }
        let expires_at = kalcode_core::time::format_rfc3339(
            OffsetDateTime::now_utc() + time::Duration::seconds(PREVIEW_TTL.as_secs() as i64),
        );
        let preview = HandoffPreview {
            id: package.id.clone(),
            source_thread_id: source.id,
            target_thread_id: target.id,
            task,
            text: rendered,
            preview_hash: package.content_sha256().to_owned(),
            source_commit,
            source_branch,
            source_dirty,
            warnings,
            expires_at,
        };
        let prior_id = prior.as_ref().map(|prior| prior.preview.id.clone());
        let mut drafts = self.drafts.lock().map_err(|_| poisoned())?;
        prune_expired(&mut drafts);
        if let Some(prior) = prior.as_ref() {
            let current = drafts.get(&prior.preview.id).ok_or_else(|| {
                KalError::validation(
                    "handoff_preview_unknown",
                    "That earlier handoff preview expired or belongs to another runtime.",
                )
            })?;
            if current.queued_at.is_some() {
                return Err(KalError::validation(
                    "handoff_preview_already_sent",
                    "That handoff preview was already sent and can no longer be edited.",
                ));
            }
            validate_prior_binding(
                &current.preview,
                current.expires,
                source_thread_id,
                target_thread_id,
                task,
            )?;
        }
        let replacing = prior_id
            .as_ref()
            .is_some_and(|prior_id| drafts.contains_key(prior_id));
        if drafts.len() >= MAX_DRAFTS && !replacing {
            return Err(KalError::validation(
                "handoff_preview_capacity",
                "Finish or cancel an existing handoff preview before creating another.",
            ));
        }
        if let Some(prior_id) = prior_id {
            drafts.remove(&prior_id);
        }
        drafts.insert(
            preview.id.clone(),
            Draft {
                preview: preview.clone(),
                package,
                target_instance_id: pane.instance_id.ok_or_else(target_unavailable)?,
                expires: Instant::now() + PREVIEW_TTL,
                return_of_id,
                source_status,
                queued_at: None,
                next_attempt: Instant::now(),
                retry_delay: Duration::from_secs(1),
            },
        );
        Ok(preview)
    }

    fn send(&self, id: &str, preview_hash: &str) -> Result<HandoffRecord> {
        self.require_entitled()?;
        if let Some(existing) = self.store.get_if_preview(id, preview_hash)? {
            return Ok(existing);
        }
        let draft = {
            let mut drafts = self.drafts.lock().map_err(|_| poisoned())?;
            prune_expired(&mut drafts);
            drafts.get(id).cloned().ok_or_else(|| {
                KalError::validation(
                    "handoff_preview_unknown",
                    "That handoff preview expired or belongs to an earlier runtime.",
                )
            })?
        };
        if !constant_time_eq(preview_hash, &draft.preview.preview_hash) {
            return Err(KalError::validation(
                "handoff_preview_changed",
                "The handoff preview changed. Review it again before sending.",
            ));
        }
        if Instant::now() >= draft.expires {
            self.drafts.lock().map_err(|_| poisoned())?.remove(id);
            return Err(KalError::validation(
                "handoff_preview_expired",
                "That handoff preview expired. Create a new preview.",
            ));
        }
        let (source, target, pane) = self.validate_pair(
            &draft.preview.source_thread_id,
            &draft.preview.target_thread_id,
            draft.preview.task,
        )?;
        if pane.instance_id.as_deref() != Some(draft.target_instance_id.as_str()) {
            return Err(KalError::validation(
                "handoff_target_changed",
                "The receiving agent restarted. Create a new handoff preview.",
            ));
        }
        let root = self.source_root(&source)?;
        let firewall = self.firewall(&source.workspace_id, root.path())?;
        match draft.package.check_before_send(preview_hash, &firewall)? {
            SendCheck::Ready(_) => {}
            SendCheck::Stale(_) => {
                return Err(KalError::validation(
                    "handoff_preview_changed",
                    "The handoff content changed. Review a new preview before sending.",
                ));
            }
        }
        let logs = draft.package.log_entries();
        let created = self.store.create_with(
            &NewHandoff {
                id,
                context_package_id: id,
                source_thread_id: &source.id,
                target_thread_id: &target.id,
                source_workspace_id: &source.workspace_id,
                target_workspace_id: &target.workspace_id,
                source_name: &source.name,
                target_name: &target.name,
                task: draft.preview.task,
                target_instance_id: &draft.target_instance_id,
                preview_hash,
                source_commit: draft.preview.source_commit.as_deref(),
                source_branch: draft.preview.source_branch.as_deref(),
                source_dirty: draft.preview.source_dirty,
                return_of_id: draft.return_of_id.as_deref(),
            },
            |transaction| {
                context_store::save_preview_in(transaction, &draft.package)
                    .map_err(KalError::from)?;
                context_store::append_log_in(transaction, &logs).map_err(KalError::from)
            },
        );
        if let Err(original) = created {
            let Ok(Some(existing)) = self.store.get_if_preview(id, preview_hash) else {
                return Err(original);
            };
            if existing.status != HandoffStatus::Queued {
                return Ok(existing);
            }
            // A concurrent caller created this record and is delivering it. Join that attempt
            // under the dispatch gate, so every caller returns the same authoritative record;
            // `dispatch_one` writes to the terminal at most once and reports a settled record as is.
            self.mark_queued(id)?;
            let _gate = self.dispatch_gate.lock().map_err(|_| poisoned())?;
            // The winner already settled it (delivery consumes the draft): report that record.
            if !self.drafts.lock().map_err(|_| poisoned())?.contains_key(id) {
                return self.store.get(id);
            }
            return self.dispatch_one(id);
        }
        let queued = self.mark_queued(id)?;
        if queued.is_none() {
            return self.store.interrupt_pending(
                id,
                "The handoff preview changed before delivery and was not sent.",
            );
        }
        let result = {
            let _gate = self.dispatch_gate.lock().map_err(|_| poisoned())?;
            self.dispatch_one(id)
        };
        self.wake();
        result
    }

    /// Queues a sent preview for delivery (once: a later call keeps the first queue time).
    fn mark_queued(&self, id: &str) -> Result<Option<()>> {
        let mut drafts = self.drafts.lock().map_err(|_| poisoned())?;
        Ok(drafts.get_mut(id).map(|draft| {
            if draft.queued_at.is_none() {
                let now = Instant::now();
                draft.queued_at = Some(now);
                draft.next_attempt = now;
                draft.retry_delay = Duration::from_secs(1);
            }
        }))
    }

    fn cancel(&self, id: &str) -> Result<HandoffRecord> {
        self.require_entitled()?;
        let record = self.store.cancel(id)?;
        self.drafts.lock().map_err(|_| poisoned())?.remove(id);
        Ok(record)
    }

    fn list(&self, thread_id: Option<&str>) -> Result<Vec<HandoffRecord>> {
        self.require_entitled()?;
        let records = self.store.list_with_target_instances(thread_id)?;
        let Some(runtime) = self.threads.runtime_handle() else {
            return Ok(records.into_iter().map(|(record, _)| record).collect());
        };
        records
            .into_iter()
            .map(|(record, target_instance_id)| {
                if !matches!(
                    record.status,
                    HandoffStatus::Delivered | HandoffStatus::Working | HandoffStatus::NeedsYou
                ) {
                    return Ok(record);
                }
                let pane = self.panes.handoff_info(&record.target_thread_id);
                if pane.as_ref().is_none_or(|pane| {
                    !pane.running || pane.instance_id.as_deref() != Some(&target_instance_id)
                }) {
                    return self.store.interrupt_open(
                        &record.id,
                        "The receiving agent ended or restarted before an explicit outcome was recorded.",
                    );
                }
                let Ok(target) = runtime.get(&record.target_thread_id) else {
                    return self.store.interrupt_open(
                        &record.id,
                        "The receiving agent is no longer available to report this handoff.",
                    );
                };
                if target.status.is_live() {
                    if record.status == HandoffStatus::Working {
                        Ok(record)
                    } else {
                        self.store.mark_working(&record.id)
                    }
                } else if matches!(
                    target.status,
                    ThreadStatus::Idle
                        | ThreadStatus::WaitingForPermission
                        | ThreadStatus::WaitingForUser
                        | ThreadStatus::WaitingForDependency
                        | ThreadStatus::Paused
                ) {
                    if record.status == HandoffStatus::NeedsYou {
                        Ok(record)
                    } else {
                        self.store.mark_needs_you(&record.id)
                    }
                } else {
                    self.store.interrupt_open(
                        &record.id,
                        "The receiving agent ended before an explicit outcome was recorded.",
                    )
                }
            })
            .collect()
    }

    fn complete(
        &self,
        id: &str,
        outcome: HandoffCompletion,
        result: &str,
    ) -> Result<HandoffRecord> {
        self.require_entitled()?;
        let result = normalize_newlines(result);
        validate_text(&result, MAX_CAPSULE_CHARS, "invalid_handoff_result")?;
        let redacted = kalcode_core::redact::redact_text(
            &result,
            kalcode_core::redact::secrets::ScanContext::default(),
            kalcode_core::redact::PlaceholderStyle::Labelled,
        )
        .text;
        self.store.complete(
            id,
            match outcome {
                HandoffCompletion::Completed => HandoffStatus::Completed,
                HandoffCompletion::Failed => HandoffStatus::Failed,
            },
            &redacted,
        )
    }

    fn returned_preview(&self, id: &str) -> Result<HandoffPreview> {
        self.require_entitled()?;
        let record = self.store.get(id)?;
        if !matches!(
            record.status,
            HandoffStatus::Completed | HandoffStatus::Failed
        ) {
            return Err(KalError::validation(
                "handoff_result_unavailable",
                "Finish this handoff before returning its findings.",
            ));
        }
        let result = record.result.as_deref().ok_or_else(|| {
            KalError::validation(
                "handoff_result_unavailable",
                "This handoff has no explicit result to return.",
            )
        })?;
        let instructions = format!(
            "Return the explicit outcome of handoff {} to the original sending agent.\n\n{}",
            record.id, result
        );
        self.preview(
            &record.target_thread_id,
            &record.source_thread_id,
            HandoffTask::Review,
            &instructions,
            None,
            Some(record.id),
            None,
        )
    }

    fn validate_pair(
        &self,
        source_thread_id: &str,
        target_thread_id: &str,
        task: HandoffTask,
    ) -> Result<(
        ThreadSummary,
        ThreadSummary,
        kalcode_providers::interactive::PaneInfo,
    )> {
        if source_thread_id == target_thread_id {
            return Err(KalError::validation(
                "handoff_same_thread",
                "Choose another coding agent for this handoff.",
            ));
        }
        let runtime = self.threads.runtime_handle().ok_or_else(|| {
            KalError::internal(
                "threads_unavailable",
                "KalCode's coding-agent runtime is unavailable.",
            )
        })?;
        let mut source = runtime.get(source_thread_id)?;
        let mut target = runtime.get(target_thread_id)?;
        self.panes.stamp_runtime_kind(&mut source);
        self.panes.stamp_runtime_kind(&mut target);
        if source.runtime_kind != Some(ThreadRuntimeKind::InteractivePty)
            || target.runtime_kind != Some(ThreadRuntimeKind::InteractivePty)
        {
            return Err(KalError::validation(
                "handoff_requires_coding_agents",
                "Hand Off works between real coding-agent terminal panes.",
            ));
        }
        if source.archived_at.is_some() || target.archived_at.is_some() {
            return Err(KalError::validation(
                "handoff_agent_archived",
                "Open both coding agents before creating a handoff.",
            ));
        }
        if source.workspace_id != target.workspace_id {
            return Err(KalError::validation(
                "handoff_workspace_unrelated",
                "Both agents must belong to the same project. Cross-worktree handoffs are supported inside that project.",
            ));
        }
        if !matches!(
            target.provider_id.as_str(),
            kalcode_contracts::agent::ProviderId::CLAUDE_CODE
                | kalcode_contracts::agent::ProviderId::CODEX
        ) {
            return Err(KalError::validation(
                "handoff_provider_unverified",
                "KalCode cannot yet prove safe automatic delivery for this provider.",
            ));
        }
        let pane = self
            .panes
            .handoff_info(target_thread_id)
            .ok_or_else(target_unavailable)?;
        if !pane.running || pane.instance_id.is_none() {
            return Err(target_unavailable());
        }
        if matches!(task, HandoffTask::Fix | HandoffTask::Continue)
            && matches!(
                target.status,
                ThreadStatus::Completed
                    | ThreadStatus::Failed
                    | ThreadStatus::Interrupted
                    | ThreadStatus::Offline
            )
        {
            return Err(target_unavailable());
        }
        Ok((source, target, pane))
    }

    fn source_stopped_or_isolated(
        &self,
        source: &ThreadSummary,
        target: &ThreadSummary,
        source_dirty: bool,
    ) -> Result<bool> {
        let source_stopped = self
            .panes
            .handoff_info(&source.id)
            .is_none_or(|pane| !pane.running)
            || matches!(
                source.status,
                ThreadStatus::Completed
                    | ThreadStatus::Failed
                    | ThreadStatus::Interrupted
                    | ThreadStatus::Offline
            );
        if source_stopped {
            return Ok(true);
        }
        let (Some(source_worktree_id), Some(target_worktree_id)) =
            (source.worktree_id.as_deref(), target.worktree_id.as_deref())
        else {
            return Ok(false);
        };
        if source_dirty || source_worktree_id == target_worktree_id {
            return Ok(false);
        }
        self.core.read(|connection| {
            let source_worktree = kalcode_git::store::get_worktree(connection, source_worktree_id)?;
            let target_worktree = kalcode_git::store::get_worktree(connection, target_worktree_id)?;
            Ok(source_worktree.workspace_id == source.workspace_id
                && target_worktree.workspace_id == target.workspace_id
                && source_worktree.owner_ref.as_deref() == Some(source.id.as_str())
                && target_worktree.owner_ref.as_deref() == Some(target.id.as_str())
                && source_worktree.status == kalcode_contracts::git::WorktreeStatus::Active
                && target_worktree.status == kalcode_contracts::git::WorktreeStatus::Active)
        })
    }

    fn source_root(&self, source: &ThreadSummary) -> Result<WorkspaceRoot> {
        if let Some(worktree_id) = source.worktree_id.as_deref() {
            return self.core.read(|connection| {
                let row = kalcode_git::store::get_worktree(connection, worktree_id)?;
                if row.workspace_id != source.workspace_id
                    || row.owner_ref.as_deref() != Some(source.id.as_str())
                    || row.status != kalcode_contracts::git::WorktreeStatus::Active
                {
                    return Err(KalError::validation(
                        "handoff_worktree_unavailable",
                        "The sending agent's worktree is no longer available.",
                    ));
                }
                let path = kalcode_git::store::worktree_path(connection, worktree_id)?;
                WorkspaceRoot::new(worktree_id, &path)
            });
        }
        crate::git_commands::workspace_root_in(&self.core, &source.workspace_id)
    }

    fn firewall(&self, workspace_id: &str, root: &std::path::Path) -> Result<Firewall> {
        let patterns = self.core.read(|connection| {
            context_store::never_share_for_workspace(connection, workspace_id)
                .map_err(KalError::from)
        })?;
        let policy = FirewallPolicy {
            never_share: NeverShareRules::new(&patterns).map_err(KalError::from)?,
            ..FirewallPolicy::default()
        };
        Ok(Firewall::new(
            kalcode_context::WorkspaceRoot::new(root),
            policy,
        ))
    }

    fn dispatch_queued(&self) -> Result<()> {
        let now = Instant::now();
        let ids: Vec<(Instant, String)> = self
            .drafts
            .lock()
            .map_err(|_| poisoned())?
            .iter()
            .filter_map(|(id, draft)| {
                draft
                    .queued_at
                    .filter(|queued_at| draft_due(Some(*queued_at), draft.next_attempt, now))
                    .map(|queued_at| (queued_at, id.clone()))
            })
            .collect();
        if let Some(id) = next_fifo_id(ids)
            && let Err(error) = self.dispatch_one(&id)
        {
            tracing::warn!(event = "handoff.dispatch_item_failed", code = error.code);
        }
        Ok(())
    }

    fn dispatch_one(&self, id: &str) -> Result<HandoffRecord> {
        self.require_entitled()?;
        let draft = self
            .drafts
            .lock()
            .map_err(|_| poisoned())?
            .get(id)
            .cloned()
            .ok_or_else(|| {
                KalError::validation(
                    "handoff_capsule_missing",
                    "Handoff content is no longer available.",
                )
            })?;
        let current = self.store.get(id)?;
        if current.status != HandoffStatus::Queued {
            self.drafts.lock().map_err(|_| poisoned())?.remove(id);
            return Ok(current);
        }
        if Instant::now() >= draft.expires {
            self.drafts.lock().map_err(|_| poisoned())?.remove(id);
            return self.store.interrupt_pending(
                id,
                "The handoff preview expired before the receiving agent became ready.",
            );
        }
        if self.has_queued_predecessor(id, &draft)? {
            return self.defer_delivery(id, "Waiting for an earlier handoff to this agent.");
        }
        if let Err(error) = self
            .panes
            .handoff_readiness(&draft.preview.target_thread_id, &draft.target_instance_id)
        {
            return match readiness_disposition(error) {
                ReadinessDisposition::Deferred => self.defer_delivery(id, &error.to_string()),
                ReadinessDisposition::Interrupted => {
                    self.drafts.lock().map_err(|_| poisoned())?.remove(id);
                    self.store.interrupt_pending(id, &error.to_string())
                }
            };
        }
        let (source, target, pane) = match self.validate_pair(
            &draft.preview.source_thread_id,
            &draft.preview.target_thread_id,
            draft.preview.task,
        ) {
            Ok(value) => value,
            Err(error) => return self.handle_preflight_error(id, error),
        };
        if pane.instance_id.as_deref() != Some(draft.target_instance_id.as_str()) {
            self.drafts.lock().map_err(|_| poisoned())?.remove(id);
            return self.store.interrupt_pending(
                id,
                "The receiving agent restarted before this handoff was delivered.",
            );
        }
        let root = match self.source_root(&source) {
            Ok(root) => root,
            Err(error) => return self.handle_preflight_error(id, error),
        };
        let status = match self.git.status(&root) {
            Ok(status) => status,
            Err(error) => return self.handle_preflight_error(id, error),
        };
        let current_commit = status
            .as_ref()
            .and_then(|status| status.branch.head_oid.clone());
        let current_branch = status
            .as_ref()
            .and_then(|status| status.branch.branch.clone())
            .or_else(|| source.branch.clone());
        let current_dirty = status
            .as_ref()
            .is_some_and(|status| status.summary.changed > 0 || status.summary.untracked > 0);
        if current_commit != draft.preview.source_commit
            || current_branch != draft.preview.source_branch
            || current_dirty != draft.preview.source_dirty
            || !source_status_unchanged(
                &draft.source_status,
                status
                    .as_ref()
                    .map_or(&[], |status| status.files.as_slice()),
            )
        {
            self.drafts.lock().map_err(|_| poisoned())?.remove(id);
            return self.store.interrupt_pending(
                id,
                "The sending agent's Git state changed after preview. Review a new handoff.",
            );
        }
        if matches!(draft.preview.task, HandoffTask::Fix | HandoffTask::Continue) {
            let custody_safe =
                match self.source_stopped_or_isolated(&source, &target, current_dirty) {
                    Ok(custody_safe) => custody_safe,
                    Err(error) => return self.handle_preflight_error(id, error),
                };
            if !custody_safe {
                self.drafts.lock().map_err(|_| poisoned())?.remove(id);
                return self.store.interrupt_pending(
                    id,
                    "Write ownership changed after preview. Stop the sending agent or use clean isolated worktrees.",
                );
            }
        }
        let firewall = match self.firewall(&source.workspace_id, root.path()) {
            Ok(firewall) => firewall,
            Err(error) => return self.handle_preflight_error(id, error),
        };
        let text = match draft
            .package
            .check_before_send(&draft.preview.preview_hash, &firewall)
        {
            Ok(SendCheck::Ready(rendered)) => rendered.text(),
            Ok(SendCheck::Stale(_)) => {
                self.drafts.lock().map_err(|_| poisoned())?.remove(id);
                return self.store.interrupt_pending(
                    id,
                    "The handoff content changed after preview and was not delivered.",
                );
            }
            Err(error) => return self.handle_preflight_error(id, KalError::from(error)),
        };
        let claim_error = Arc::new(Mutex::new(None::<KalError>));
        let claimed = Arc::new(AtomicBool::new(false));
        let claim_error_for_callback = claim_error.clone();
        let claimed_for_callback = claimed.clone();
        let claimed_at = kalcode_core::time::now_rfc3339();
        let delivery = self.panes.deliver_handoff(
            &draft.preview.target_thread_id,
            &draft.target_instance_id,
            &text,
            || match self.store.claim_delivery(id, |transaction| {
                context_store::claim_delivery(transaction, id, None, &claimed_at)
                    .map_err(KalError::from)
            }) {
                Ok(()) => {
                    claimed_for_callback.store(true, Ordering::Release);
                    Ok(())
                }
                Err(error) => {
                    *claim_error_for_callback
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = Some(error);
                    Err(HandoffDeliveryError::Io)
                }
            },
        );
        match delivery {
            Ok(()) => {
                self.drafts.lock().map_err(|_| poisoned())?.remove(id);
                let finished_at = kalcode_core::time::now_rfc3339();
                let finalized = self.store.finish_delivery(id, |transaction| {
                    context_store::finish_delivery(
                        transaction,
                        id,
                        DeliveryState::Sent,
                        &finished_at,
                    )
                    .map_err(KalError::from)?;
                    context_store::finish_package(
                        transaction,
                        id,
                        PackageStatus::Sent,
                        &finished_at,
                    )
                    .map_err(KalError::from)
                });
                match finalized {
                    Ok(record) => Ok(record),
                    Err(original) => {
                        let failed_at = kalcode_core::time::now_rfc3339();
                        match self.store.fail_uncertain(
                            id,
                            "The terminal accepted the handoff, but KalCode could not verify its durable delivery record.",
                            |transaction| {
                                context_store::finish_delivery(
                                    transaction,
                                    id,
                                    DeliveryState::FailedUncertain,
                                    &failed_at,
                                )
                                .map_err(KalError::from)
                            },
                        ) {
                            Ok(record) => Ok(record),
                            Err(_) => Err(original),
                        }
                    }
                }
            }
            Err(error) => {
                if let Some(error) = claim_error
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take()
                {
                    return Err(error);
                }
                if claimed.load(Ordering::Acquire) {
                    self.drafts.lock().map_err(|_| poisoned())?.remove(id);
                    let finished_at = kalcode_core::time::now_rfc3339();
                    return self
                        .store
                        .fail_uncertain(id, &error.to_string(), |transaction| {
                            context_store::finish_delivery(
                                transaction,
                                id,
                                DeliveryState::FailedUncertain,
                                &finished_at,
                            )
                            .map_err(KalError::from)
                        });
                }
                match error {
                    HandoffDeliveryError::ReadyBusy
                    | HandoffDeliveryError::ProviderPrompt
                    | HandoffDeliveryError::Unverified
                    | HandoffDeliveryError::InputPending => {
                        self.defer_delivery(id, &error.to_string())
                    }
                    HandoffDeliveryError::TargetChanged
                    | HandoffDeliveryError::SessionEnded
                    | HandoffDeliveryError::InvalidText
                    | HandoffDeliveryError::Io => {
                        self.drafts.lock().map_err(|_| poisoned())?.remove(id);
                        self.store.interrupt_pending(id, &error.to_string())
                    }
                }
            }
        }
    }

    fn handle_preflight_error(&self, id: &str, error: KalError) -> Result<HandoffRecord> {
        let message = bounded_blocker(&error.message);
        if error.retryable {
            return self.store.set_queue_blocker(id, Some(&message));
        }
        if matches!(
            error.category,
            ErrorCategory::Validation
                | ErrorCategory::Provider
                | ErrorCategory::Filesystem
                | ErrorCategory::Git
                | ErrorCategory::Permission
        ) {
            self.drafts.lock().map_err(|_| poisoned())?.remove(id);
            return self.store.interrupt_pending(id, &message);
        }
        Err(error)
    }

    fn defer_delivery(&self, id: &str, blocker: &str) -> Result<HandoffRecord> {
        {
            let mut drafts = self.drafts.lock().map_err(|_| poisoned())?;
            if let Some(draft) = drafts.get_mut(id) {
                draft.next_attempt = Instant::now() + draft.retry_delay;
                draft.retry_delay = (draft.retry_delay * 2).min(Duration::from_secs(8));
            }
        }
        self.store.set_queue_blocker(id, Some(blocker))
    }

    fn has_queued_predecessor(&self, id: &str, draft: &Draft) -> Result<bool> {
        let Some(queued_at) = draft.queued_at else {
            return Ok(false);
        };
        let drafts = self.drafts.lock().map_err(|_| poisoned())?;
        Ok(drafts.iter().any(|(other_id, other)| {
            other_id != id
                && other.preview.target_thread_id == draft.preview.target_thread_id
                && other.queued_at.is_some_and(|other_queued_at| {
                    (other_queued_at, other_id.as_str()) < (queued_at, id)
                })
        }))
    }
}

#[tauri::command(async)]
// Runtime arguments are injected; the remaining arguments are the existing flat IPC contract.
#[allow(clippy::too_many_arguments)]
pub async fn handoff_preview(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<HandoffState>,
    source_thread_id: String,
    target_thread_id: String,
    task: HandoffTask,
    instructions: String,
    edited_text: Option<String>,
    prior_preview_id: Option<String>,
) -> Result<HandoffPreview, IpcError> {
    blocking(state, "handoff_preview", move |state| {
        state.preview(
            &source_thread_id,
            &target_thread_id,
            task,
            &instructions,
            edited_text.as_deref(),
            None,
            prior_preview_id.as_deref(),
        )
    })
    .await
}

#[tauri::command(async)]
pub async fn handoff_send(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<HandoffState>,
    id: String,
    preview_hash: String,
) -> Result<HandoffRecord, IpcError> {
    blocking(state, "handoff_send", move |state| {
        state.send(&id, &preview_hash)
    })
    .await
}

#[tauri::command(async)]
pub async fn handoff_list(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<HandoffState>,
    thread_id: Option<String>,
) -> Result<Vec<HandoffRecord>, IpcError> {
    blocking(state, "handoff_list", move |state| {
        state.list(thread_id.as_deref())
    })
    .await
}

#[tauri::command(async)]
pub async fn handoff_cancel(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<HandoffState>,
    id: String,
) -> Result<HandoffRecord, IpcError> {
    blocking(state, "handoff_cancel", move |state| state.cancel(&id)).await
}

#[tauri::command(async)]
pub async fn handoff_complete(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<HandoffState>,
    id: String,
    outcome: HandoffCompletion,
    result: String,
) -> Result<HandoffRecord, IpcError> {
    blocking(state, "handoff_complete", move |state| {
        state.complete(&id, outcome, &result)
    })
    .await
}

#[tauri::command(async)]
pub async fn handoff_return(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<HandoffState>,
    id: String,
) -> Result<HandoffPreview, IpcError> {
    blocking(state, "handoff_return", move |state| {
        state.returned_preview(&id)
    })
    .await
}

async fn blocking<T: Send + 'static>(
    state: RuntimeState<HandoffState>,
    command: &'static str,
    operation: impl FnOnce(&HandoffState) -> Result<T> + Send + 'static,
) -> Result<T, IpcError> {
    state.revalidate()?;
    tauri::async_runtime::spawn_blocking(move || {
        state.revalidate()?;
        let value = operation(&state).map_err(|error| error.log_and_convert(command))?;
        state.revalidate()?;
        Ok(value)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "handoff_worker_failed",
            "KalCode could not finish the handoff request.",
        )
        .to_ipc()
    })?
}

fn warnings(
    source: &ThreadSummary,
    target: &ThreadSummary,
    task: HandoffTask,
    source_dirty: bool,
) -> Vec<String> {
    let mut warnings = vec![
        "Original request: not observed for interactive provider terminals.".to_owned(),
        "Tests and results: not observed; verify repository and terminal evidence directly."
            .to_owned(),
    ];
    if matches!(task, HandoffTask::Review | HandoffTask::Test) {
        warnings.push(format!(
            "{} is instructed to work read-only, but its existing provider permission mode remains authoritative.",
            target.name
        ));
    }
    if source_dirty {
        warnings.push(format!(
            "{} has uncommitted or untracked changes in its source worktree.",
            source.name
        ));
    }
    if target.provider_id.as_str() == kalcode_contracts::agent::ProviderId::CODEX {
        warnings.push(
            "A fresh Codex pane becomes eligible only after its first authenticated completed-turn signal."
                .to_owned(),
        );
    }
    warnings
}

// Render the individually observed repository facts without introducing another stored context.
#[allow(clippy::too_many_arguments)]
fn capsule_text(
    source: &ThreadSummary,
    target: &ThreadSummary,
    task: HandoffTask,
    instructions: &str,
    source_commit: Option<&str>,
    source_branch: Option<&str>,
    source_dirty: bool,
    source_worktree_id: Option<&str>,
    changed_paths: &[String],
) -> String {
    let action = match task {
        HandoffTask::Review => {
            "Review the work and report concrete findings. Do not modify files unless the user explicitly changes the task."
        }
        HandoffTask::Test => {
            "Run the relevant tests and report exact results. Do not modify files unless the user explicitly changes the task."
        }
        HandoffTask::Fix => {
            "Fix the described issue in your assigned workspace, run relevant tests, and report the result."
        }
        HandoffTask::Continue => {
            "Continue the described implementation in your assigned workspace, run relevant tests, and report the result."
        }
    };
    let paths = if changed_paths.is_empty() {
        "- none observed or all names withheld by the Context Firewall".to_owned()
    } else {
        changed_paths
            .iter()
            .map(|path| format!("- {path}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let instructions = if instructions.trim().is_empty() {
        "(No additional instructions.)"
    } else {
        instructions
    };
    format!(
        "KalCode Agent Hand Off\n\nTask: {}\nFrom: {}\nTo: {}\nProject: {}\nSource worktree: {}\nSource branch: {}\nSource commit: {}\nSource working tree: {}\n\nChanged paths at preview (bounded; sensitive names withheld)\n{}\n\nInstructions from the user\n{}\n\nContext limits\n- Original interactive-terminal request: not observed by KalCode.\n- Prior test output and provider responses: not observed by KalCode.\n- Inspect the repository and terminal evidence yourself.\n\nRequested action\n{}\n\nWhen finished, record an explicit outcome in KalCode's Hand Off panel. An idle prompt alone is not completion.",
        task.as_str(),
        source.name,
        target.name,
        source.workspace_name,
        source_worktree_id.unwrap_or("shared project workspace"),
        source_branch.unwrap_or("not observed"),
        source_commit.unwrap_or("not observed"),
        if source_dirty {
            "changed"
        } else {
            "clean or not observed"
        },
        paths,
        instructions,
        action,
    )
}

fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n")
}

fn plan_allows_handoff(tier: PlanTier) -> bool {
    let rank = match tier {
        PlanTier::Free => 0,
        PlanTier::Pro => 1,
        PlanTier::Max | PlanTier::Max2x => 2,
        PlanTier::Owner => u8::MAX,
    };
    FeatureId::ProviderHandoff.placement().included_in(rank)
}

fn validate_prior_binding(
    prior: &HandoffPreview,
    expires: Instant,
    source_thread_id: &str,
    target_thread_id: &str,
    task: HandoffTask,
) -> Result<()> {
    if expires <= Instant::now()
        || prior.source_thread_id != source_thread_id
        || prior.target_thread_id != target_thread_id
        || prior.task != task
    {
        return Err(KalError::validation(
            "handoff_preview_binding_changed",
            "The handoff source, target, or task changed. Start a new handoff instead.",
        ));
    }
    Ok(())
}

fn validate_text(value: &str, max_chars: usize, code: &'static str) -> Result<()> {
    if value.trim().is_empty()
        || value.chars().count() > max_chars
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(KalError::validation(
            code,
            "Handoff text is empty, too long, or contains unsafe controls.",
        ));
    }
    Ok(())
}

fn prune_expired(drafts: &mut HashMap<String, Draft>) {
    let now = Instant::now();
    drafts.retain(|_, draft| retain_draft(draft.expires, draft.queued_at, now));
}

fn retain_draft(expires: Instant, queued_at: Option<Instant>, now: Instant) -> bool {
    queued_at.is_some() || expires > now
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn source_status_signature(files: &[StatusFile]) -> Vec<SourceStatusEntry> {
    files
        .iter()
        .map(|file| SourceStatusEntry {
            path: file.path.clone(),
            orig_path: file.orig_path.clone(),
            staged: file.staged,
            unstaged: file.unstaged,
            untracked: file.untracked,
            conflict: file.conflict,
            submodule: file.submodule,
        })
        .collect()
}

fn source_status_unchanged(preview: &[SourceStatusEntry], current: &[StatusFile]) -> bool {
    preview == source_status_signature(current)
}

fn draft_due(queued_at: Option<Instant>, next_attempt: Instant, now: Instant) -> bool {
    queued_at.is_some() && next_attempt <= now
}

fn fifo_ids(mut items: Vec<(Instant, String)>) -> Vec<String> {
    items.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    items.into_iter().map(|(_, id)| id).collect()
}

fn next_fifo_id(items: Vec<(Instant, String)>) -> Option<String> {
    fifo_ids(items).into_iter().next()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadinessDisposition {
    Deferred,
    Interrupted,
}

fn readiness_disposition(error: HandoffDeliveryError) -> ReadinessDisposition {
    match error {
        HandoffDeliveryError::ReadyBusy
        | HandoffDeliveryError::ProviderPrompt
        | HandoffDeliveryError::Unverified
        | HandoffDeliveryError::InputPending => ReadinessDisposition::Deferred,
        HandoffDeliveryError::TargetChanged
        | HandoffDeliveryError::SessionEnded
        | HandoffDeliveryError::InvalidText
        | HandoffDeliveryError::Io => ReadinessDisposition::Interrupted,
    }
}

fn target_unavailable() -> KalError {
    KalError::new(
        ErrorCategory::Provider,
        "handoff_target_unavailable",
        "The receiving coding agent is not running in its original terminal instance.",
    )
}

fn poisoned() -> KalError {
    KalError::internal(
        "handoff_state_unavailable",
        "KalCode could not verify handoff state. Restart KalCode before trying again.",
    )
}

fn bounded_blocker(message: &str) -> String {
    let mut value: String = message
        .chars()
        .filter(|character| !character.is_control())
        .take(800)
        .collect();
    if value.trim().is_empty() {
        value = "KalCode could not revalidate this handoff. Create a new preview.".into();
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capsule_labels_unobserved_context_and_never_claims_idle_completion() {
        let source = fixture("Claude A", "claude_code");
        let target = fixture("Codex A", "codex");
        let text = capsule_text(
            &source,
            &target,
            HandoffTask::Review,
            "Review the implementation.",
            Some("8506936"),
            Some("feat/source"),
            false,
            Some("worktree-a"),
            &["src/main.rs".into()],
        );
        assert!(text.contains("not observed by KalCode"));
        assert!(text.contains("idle prompt alone is not completion"));
        assert!(text.contains("Do not modify files"));
        assert!(text.contains("src/main.rs"));
    }

    #[test]
    fn unsafe_terminal_controls_are_rejected() {
        assert!(validate_text("safe\ntext", 100, "test").is_ok());
        assert!(validate_text("unsafe\u{1b}[2J", 100, "test").is_err());
        assert_eq!(normalize_newlines("one\r\ntwo"), "one\ntwo");
        assert!(validate_text(&normalize_newlines("one\r\ntwo"), 100, "test").is_ok());
        assert!(validate_text(&normalize_newlines("one\rtwo"), 100, "test").is_err());
    }

    #[test]
    fn free_is_denied_and_pro_or_higher_is_allowed() {
        assert!(!plan_allows_handoff(PlanTier::Free));
        assert!(plan_allows_handoff(PlanTier::Pro));
        assert!(plan_allows_handoff(PlanTier::Max));
        assert!(plan_allows_handoff(PlanTier::Owner));
    }

    #[test]
    fn edited_preview_cannot_change_its_immutable_binding() {
        let prior = HandoffPreview {
            id: "30000000-0000-4000-8000-000000000001".into(),
            source_thread_id: "10000000-0000-4000-8000-000000000001".into(),
            target_thread_id: "10000000-0000-4000-8000-000000000002".into(),
            task: HandoffTask::Review,
            text: "Review".into(),
            preview_hash: "a".repeat(64),
            source_commit: None,
            source_branch: None,
            source_dirty: false,
            warnings: vec![],
            expires_at: "2099-01-01T00:00:00.000Z".into(),
        };
        assert!(
            validate_prior_binding(
                &prior,
                Instant::now() + Duration::from_secs(60),
                &prior.source_thread_id,
                &prior.target_thread_id,
                HandoffTask::Review,
            )
            .is_ok()
        );
        assert!(
            validate_prior_binding(
                &prior,
                Instant::now() + Duration::from_secs(60),
                &prior.source_thread_id,
                &prior.target_thread_id,
                HandoffTask::Fix,
            )
            .is_err()
        );
    }

    #[test]
    fn dirty_status_with_different_paths_is_stale_even_when_both_are_dirty() {
        let changed = |path: &str| StatusFile {
            file: None,
            path: path.into(),
            orig_path: None,
            staged: None,
            unstaged: None,
            untracked: true,
            conflict: None,
            submodule: false,
        };
        let preview = source_status_signature(&[changed("src/one.rs")]);
        assert!(source_status_unchanged(&preview, &[changed("src/one.rs")]));
        assert!(!source_status_unchanged(&preview, &[changed("src/two.rs")]));
    }

    #[test]
    fn unpublished_previews_are_never_dispatched_and_submissions_are_fifo() {
        let now = Instant::now();
        assert!(!draft_due(None, now, now));
        assert!(draft_due(Some(now), now, now));
        assert!(!retain_draft(now - Duration::from_secs(1), None, now));
        assert!(retain_draft(
            now - Duration::from_secs(1),
            Some(now - Duration::from_secs(2)),
            now
        ));
        assert_eq!(
            fifo_ids(vec![
                (now + Duration::from_secs(2), "second".into()),
                (now + Duration::from_secs(1), "first".into()),
            ]),
            vec!["first", "second"]
        );
        assert_eq!(
            next_fifo_id(vec![
                (now + Duration::from_secs(2), "second".into()),
                (now + Duration::from_secs(1), "first".into()),
            ]),
            Some("first".into())
        );
    }

    #[test]
    fn readiness_defers_only_transient_agent_state() {
        assert_eq!(
            readiness_disposition(HandoffDeliveryError::ReadyBusy),
            ReadinessDisposition::Deferred
        );
        assert_eq!(
            readiness_disposition(HandoffDeliveryError::InputPending),
            ReadinessDisposition::Deferred
        );
        assert_eq!(
            readiness_disposition(HandoffDeliveryError::TargetChanged),
            ReadinessDisposition::Interrupted
        );
    }

    fn fixture(name: &str, provider: &str) -> ThreadSummary {
        ThreadSummary {
            can_move_workspace: None,
            id: "10000000-0000-4000-8000-000000000001".into(),
            name: name.into(),
            provider_id: kalcode_contracts::agent::ProviderId::new(provider),
            provider_name: provider.into(),
            model: None,
            effort: None,
            provider_account_id: None,
            account_label: None,
            workspace_id: "20000000-0000-4000-8000-000000000001".into(),
            workspace_name: "KalCode".into(),
            permission_mode: kalcode_contracts::permissions::PermissionMode::Approve,
            status: ThreadStatus::Idle,
            current_activity: None,
            created_at: kalcode_core::time::now_rfc3339(),
            last_activity_at: kalcode_core::time::now_rfc3339(),
            pending_approvals: 0,
            unread_messages: 0,
            files_changed: None,
            branch: None,
            error: None,
            archived_at: None,
            resumable: false,
            permission_profile_id: None,
            runtime_kind: Some(ThreadRuntimeKind::InteractivePty),
            terminal_id: None,
            worktree_id: None,
        }
    }
}
