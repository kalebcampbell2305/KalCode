//! Universal Context Drop IPC. The WebView supplies explicit text/URL inputs or opaque file
//! handles; native code resolves files, evaluates the Context Firewall, persists content-free
//! facts, pins the preview hash, and sends at most once to the exact thread/account target.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, PoisonError};

use kalcode_context::events::ContextEvent;
use kalcode_context::firewall::{Firewall, FirewallPolicy};
use kalcode_context::model::{ContextPurpose, ItemKind, ItemOrigin};
use kalcode_context::never_share::NeverShareRules;
use kalcode_context::package::{ContextItem, ContextPackage, PackageOptions, SendCheck};
use kalcode_context::provider::TextOnlyDefaults;
use kalcode_context::store::{self, PackageStatus};
use kalcode_context::{ContextError, ContextPreview};
use kalcode_contracts::app::FeatureId;
use kalcode_contracts::events::{Correlation, EventPayload, NewEvent};
use kalcode_contracts::refs::FileHandle;
use kalcode_contracts::threads::{ThreadStatus, ThreadSummary};
use kalcode_core::flags::SurfaceState;
use kalcode_core::{ErrorCategory, IpcError, KalError};
use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::AppState;
use crate::git_commands::{GitState, workspace_root};
use crate::provider_pane_commands::ProviderPanesState;
use crate::thread_commands::ThreadsState;

const MAX_PACKAGES: usize = 64;
const MAX_INPUTS: usize = 24;
const MAX_TEXT_CHARS: usize = 256_000;
const MAX_LABEL_CHARS: usize = 120;
const MAX_URL_CHARS: usize = 2_048;
const MAIN_WEBVIEW: &str = "main";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    Draft,
    Validating,
    Sending,
    FailedUncertain,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TargetSnapshot {
    thread_id: String,
    provider_id: String,
    provider_account_id: Option<String>,
    workspace_id: String,
}

#[derive(Debug, Clone)]
struct PackageRecord {
    owner: String,
    generation: u64,
    target: TargetSnapshot,
    lifecycle: Lifecycle,
    package: ContextPackage,
}

#[derive(Debug, Default)]
struct Registry {
    packages: HashMap<String, PackageRecord>,
    order: VecDeque<String>,
}

/// Account-bound, bounded in-memory package registry. Source content is never persisted.
#[derive(Debug, Default)]
pub struct ContextState {
    inner: Mutex<Registry>,
}

impl ContextState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn insert(&self, record: PackageRecord) -> Result<(), KalError> {
        let mut registry = self.lock();
        if registry.packages.len() >= MAX_PACKAGES {
            return Err(KalError::new(
                ErrorCategory::Internal,
                "context_capacity",
                "Finish or clear an existing context preview before creating another.",
            ));
        }
        let id = record.package.id.clone();
        registry.packages.insert(id.clone(), record);
        registry.order.retain(|existing| existing != &id);
        registry.order.push_back(id);
        Ok(())
    }

    fn remove(&self, package_id: &str) {
        let mut registry = self.lock();
        registry.packages.remove(package_id);
        registry.order.retain(|id| id != package_id);
    }

    pub(crate) fn clear(&self) {
        let mut registry = self.lock();
        registry.packages.clear();
        registry.order.clear();
    }

    fn begin_validation(
        &self,
        owner: &str,
        generation: u64,
        package_id: &str,
        current: &TargetSnapshot,
    ) -> Result<PackageRecord, KalError> {
        let mut registry = self.lock();
        let record = registry.packages.get_mut(package_id).ok_or_else(|| {
            KalError::validation(
                "context_package_unknown",
                "That context preview is no longer available.",
            )
        })?;
        if record.owner != owner || record.generation != generation {
            return Err(KalError::validation(
                "context_package_unknown",
                "That context preview is no longer available.",
            ));
        }
        match record.lifecycle {
            Lifecycle::Validating | Lifecycle::Sending => {
                return Err(KalError::validation(
                    "context_send_in_progress",
                    "This context is already being sent.",
                ));
            }
            Lifecycle::FailedUncertain => {
                return Err(KalError::new(
                    ErrorCategory::Provider,
                    "context_send_uncertain",
                    "The provider outcome is unknown. Review the thread before sending again.",
                ));
            }
            Lifecycle::Draft => {}
        }
        if &record.target != current {
            return Err(KalError::validation(
                "context_target_changed",
                "The context target changed. Create a new preview.",
            ));
        }
        record.lifecycle = Lifecycle::Validating;
        Ok(record.clone())
    }

    fn claim_validated(
        &self,
        owner: &str,
        generation: u64,
        package_id: &str,
        current: &TargetSnapshot,
    ) -> Result<PackageRecord, KalError> {
        let mut registry = self.lock();
        let record = registry.packages.get_mut(package_id).ok_or_else(|| {
            KalError::validation(
                "context_package_unknown",
                "That context preview is no longer available.",
            )
        })?;
        if record.owner != owner || record.generation != generation {
            return Err(KalError::validation(
                "context_package_unknown",
                "That context preview is no longer available.",
            ));
        }
        match record.lifecycle {
            Lifecycle::Validating => {}
            Lifecycle::Draft => {
                return Err(KalError::validation(
                    "context_preview_changed",
                    "The context preview changed. Review it before sending.",
                ));
            }
            Lifecycle::Sending => {
                return Err(KalError::validation(
                    "context_send_in_progress",
                    "This context is already being sent.",
                ));
            }
            Lifecycle::FailedUncertain => {
                return Err(KalError::new(
                    ErrorCategory::Provider,
                    "context_send_uncertain",
                    "The provider outcome is unknown. Review the thread before sending again.",
                ));
            }
        }
        if &record.target != current {
            record.lifecycle = Lifecycle::Draft;
            return Err(KalError::validation(
                "context_target_changed",
                "The context target changed. Create a new preview.",
            ));
        }
        record.lifecycle = Lifecycle::Sending;
        Ok(record.clone())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ContextInput {
    File { handle: FileHandle },
    Text { label: String, text: String },
    Selection { label: String, text: String },
    LogOutput { label: String, text: String },
    Url { url: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextFileChoice {
    pub handle: FileHandle,
    /// Filename only. Workspace-relative and absolute paths never cross this IPC response.
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ContextSendResult {
    Sent { thread: Box<ThreadSummary> },
    Stale { preview: Box<ContextPreview> },
}

fn validation(code: &'static str, message: &'static str) -> IpcError {
    KalError::validation(code, message).to_ipc()
}

fn owner(window: &WebviewWindow) -> Result<&str, IpcError> {
    if window.label() != MAIN_WEBVIEW {
        return Err(KalError::new(
            ErrorCategory::Permission,
            "context_owner_invalid",
            "Context Drop is available only in the main KalCode window.",
        )
        .to_ipc());
    }
    Ok(window.label())
}

fn context_error(command: &'static str, error: ContextError) -> IpcError {
    KalError::from(error).log_and_convert(command)
}

fn safe_text(value: &str, max: usize, code: &'static str) -> Result<(), IpcError> {
    if value.trim().is_empty() || value.chars().count() > max || value.chars().any(char::is_control)
    {
        return Err(validation(code, "That context value isn't valid."));
    }
    Ok(())
}

fn target(summary: &ThreadSummary) -> Result<TargetSnapshot, IpcError> {
    let inactive = summary.archived_at.is_some()
        || matches!(
            summary.status,
            ThreadStatus::WaitingForPermission
                | ThreadStatus::Paused
                | ThreadStatus::Completed
                | ThreadStatus::Failed
                | ThreadStatus::Interrupted
                | ThreadStatus::Offline
        );
    if inactive {
        return Err(validation(
            "context_target_inactive",
            "Context can only be sent to an active thread.",
        ));
    }
    Ok(TargetSnapshot {
        thread_id: summary.id.clone(),
        provider_id: summary.provider_id.as_str().to_owned(),
        provider_account_id: summary.provider_account_id.clone(),
        workspace_id: summary.workspace_id.clone(),
    })
}

fn current_target(threads: &ThreadsState, thread_id: &str) -> Result<TargetSnapshot, IpcError> {
    current_target_with_runtime(threads.runtime()?, thread_id)
}

fn current_target_with_runtime(
    runtime: &kalcode_threads::ThreadRuntime,
    thread_id: &str,
) -> Result<TargetSnapshot, IpcError> {
    target(
        &runtime
            .get(thread_id)
            .map_err(|error| error.log_and_convert("context_target"))?,
    )
}

fn delivery_is_uncertain(status: ThreadStatus) -> bool {
    matches!(
        status,
        ThreadStatus::Failed | ThreadStatus::Offline | ThreadStatus::Interrupted
    )
}

fn correlation(target: &TargetSnapshot) -> Correlation {
    Correlation {
        workspace_id: Some(target.workspace_id.clone()),
        thread_id: Some(target.thread_id.clone()),
        provider_id: Some(target.provider_id.clone()),
        ..Correlation::default()
    }
}

fn events(target: &TargetSnapshot, facts: Vec<ContextEvent>) -> Vec<NewEvent> {
    let correlation = correlation(target);
    facts
        .into_iter()
        .map(|event| {
            NewEvent::core(EventPayload::from(event)).with_correlation(correlation.clone())
        })
        .collect()
}

fn firewall(
    core: &kalcode_core::Core,
    workspace_id: &str,
    root: &std::path::Path,
) -> Result<Firewall, IpcError> {
    let patterns = core
        .read(|connection| {
            store::never_share_for_workspace(connection, workspace_id).map_err(KalError::from)
        })
        .map_err(|error| error.log_and_convert("context_firewall"))?;
    let policy = FirewallPolicy {
        never_share: NeverShareRules::new(&patterns)
            .map_err(|error| context_error("context_firewall", error))?,
        ..FirewallPolicy::default()
    };
    Ok(Firewall::new(
        kalcode_context::WorkspaceRoot::new(root),
        policy,
    ))
}

fn persist_preview(
    core: &kalcode_core::Core,
    target: &TargetSnapshot,
    package: &ContextPackage,
    include_facts: bool,
) -> Result<(), IpcError> {
    let facts = if include_facts {
        package.created_events()
    } else {
        Vec::new()
    };
    let logs = if include_facts {
        package.log_entries()
    } else {
        Vec::new()
    };
    core.write_with_events(|transaction| {
        store::save_preview_in(transaction, package).map_err(KalError::from)?;
        store::append_log_in(transaction, &logs).map_err(KalError::from)?;
        Ok(((), events(target, facts)))
    })
    .map(|_| ())
    .map_err(|error| error.log_and_convert("context_preview"))
}

fn persist_refresh(
    core: &kalcode_core::Core,
    target: &TargetSnapshot,
    package: &ContextPackage,
) -> Result<(), IpcError> {
    let facts = package.created_events().into_iter().skip(1).collect();
    let logs = package.log_entries();
    core.write_with_events(|transaction| {
        store::save_preview_in(transaction, package).map_err(KalError::from)?;
        store::append_log_in(transaction, &logs).map_err(KalError::from)?;
        Ok(((), events(target, facts)))
    })
    .map(|_| ())
    .map_err(|error| error.log_and_convert("context_refresh"))
}

fn fail_before_send(state: &ContextState, package_id: &str) {
    if let Some(record) = state.lock().packages.get_mut(package_id)
        && matches!(record.lifecycle, Lifecycle::Validating | Lifecycle::Sending)
    {
        record.lifecycle = Lifecycle::Draft;
    }
}

fn provider_payload(user_text: &str, rendered_context: &str) -> Result<(String, String), KalError> {
    let user_text = kalcode_threads::validate::prompt(user_text)?;
    let combined = format!("{user_text}\n\nContext supplied by you:\n{rendered_context}");
    let combined = kalcode_threads::validate::prompt(&combined)?;
    Ok((user_text, combined))
}

fn fail_uncertain(state: &ContextState, package_id: &str) -> IpcError {
    if let Some(record) = state.lock().packages.get_mut(package_id) {
        record.lifecycle = Lifecycle::FailedUncertain;
    }
    uncertain_error()
}

fn clear_failed_uncertain(
    core: &kalcode_core::Core,
    state: &ContextState,
    owner: &str,
    generation: u64,
    package_id: &str,
) -> Result<(), IpcError> {
    let (delivery, package) = {
        let connection = core.reader();
        let delivery = store::delivery_state(&connection, package_id)
            .map_err(|error| context_error("context_discard", error))?;
        let package = store::package_status(&connection, package_id)
            .map_err(|error| context_error("context_discard", error))?;
        (delivery, package)
    };
    if delivery != Some(store::DeliveryState::FailedUncertain)
        || package.as_deref() != Some("blocked")
    {
        return Err(context_error(
            "context_discard",
            ContextError::DeliveryState,
        ));
    }

    let mut registry = state.lock();
    let record = registry.packages.get(package_id).ok_or_else(|| {
        validation(
            "context_package_unknown",
            "That context preview is no longer available.",
        )
    })?;
    if record.owner != owner || record.generation != generation {
        return Err(validation(
            "context_package_unknown",
            "That context preview is no longer available.",
        ));
    }
    if record.lifecycle != Lifecycle::FailedUncertain {
        return Err(validation(
            "context_package_locked",
            "That context preview can no longer be changed.",
        ));
    }
    registry.packages.remove(package_id);
    registry.order.retain(|id| id != package_id);
    Ok(())
}

fn require_context_available(app: &AppState) -> Result<(), IpcError> {
    let available = [FeatureId::ContextDrop, FeatureId::ContextFirewall]
        .into_iter()
        .all(|feature| {
            app.info
                .flags
                .feature(feature)
                .is_some_and(|flag| flag.visible && matches!(flag.state, SurfaceState::Available))
        });
    if available {
        Ok(())
    } else {
        Err(validation(
            "context_unavailable",
            "Context Drop isn't available in this build yet.",
        ))
    }
}

fn persist_delivery_uncertain(core: &kalcode_core::Core, package_id: &str) {
    let finished_at = kalcode_core::time::now_rfc3339();
    if let Err(error) = core.write_with_events(|transaction| {
        store::finish_delivery(
            transaction,
            package_id,
            store::DeliveryState::FailedUncertain,
            &finished_at,
        )
        .map_err(KalError::from)?;
        Ok(((), Vec::new()))
    }) {
        tracing::error!(
            event = "context.delivery_uncertain_persist_failed",
            error_code = error.code
        );
    }
}

/// Reconciles attempts that were still sending when the process stopped. Native startup calls
/// this after migrations and before exposing Context Drop.
pub fn recover_deliveries(core: &kalcode_core::Core) -> Result<usize, KalError> {
    let finished_at = kalcode_core::time::now_rfc3339();
    core.write_with_events(|transaction| {
        let recovered =
            store::recover_sending_deliveries(transaction, &finished_at).map_err(KalError::from)?;
        Ok((recovered, Vec::new()))
    })
    .map(|(recovered, _)| recovered)
}

fn uncertain_error() -> IpcError {
    KalError::new(
        ErrorCategory::Provider,
        "context_send_uncertain",
        "The provider outcome is unknown. Review the thread before sending again.",
    )
    .to_ipc()
}

#[tauri::command(async)]
pub async fn context_file_pick(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    app: State<'_, AppState>,
    threads: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    git: crate::runtime_coordinator::RuntimeState<GitState>,
    thread_id: String,
) -> Result<Vec<ContextFileChoice>, IpcError> {
    _runtime_access.revalidate()?;
    require_context_available(&app)?;
    owner(&window)?;
    let target = current_target(&threads, &thread_id)?;
    let root = workspace_root(&app, &target.workspace_id)
        .map_err(|error| error.log_and_convert("context_file_pick"))?;
    let dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Add workspace files as context")
        .set_directory(root.path());
    let selected = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_files())
        .await
        .map_err(|error| {
            KalError::internal(
                "context_picker_interrupted",
                "The file picker was interrupted.",
            )
            .with_source(error)
            .log_and_convert("context_file_pick")
        })?
        .unwrap_or_default();
    if selected.len() > MAX_INPUTS {
        return Err(validation(
            "context_items_invalid",
            "Choose at most 24 context items.",
        ));
    }
    selected
        .into_iter()
        .map(|selected| {
            let path = selected.into_path().map_err(|error| {
                KalError::validation("context_path_rejected", "That file can't be shared.")
                    .with_source(error)
                    .log_and_convert("context_file_pick")
            })?;
            let relative = root.relativize(&path).ok_or_else(|| {
                validation(
                    "context_path_rejected",
                    "Choose a file inside this thread's workspace.",
                )
            })?;
            let file = git
                .0
                .handles()
                .issue(&root, &relative)
                .map_err(|error| error.log_and_convert("context_file_pick"))?;
            let label = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(kalcode_context::package::sanitize_label)
                .filter(|label| !label.is_empty())
                .unwrap_or_else(|| "Workspace file".to_owned());
            Ok(ContextFileChoice {
                handle: file.handle,
                label,
            })
        })
        .collect()
}

// Tauri injects native authority/services separately from the existing flat IPC payload.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn context_preview_create(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    app: State<'_, AppState>,
    threads: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    git: crate::runtime_coordinator::RuntimeState<GitState>,
    context: crate::runtime_coordinator::RuntimeState<ContextState>,
    thread_id: String,
    inputs: Vec<ContextInput>,
) -> Result<ContextPreview, IpcError> {
    _runtime_access.revalidate()?;
    require_context_available(&app)?;
    let owner = owner(&window)?.to_owned();
    if inputs.is_empty() || inputs.len() > MAX_INPUTS {
        return Err(validation(
            "context_items_invalid",
            "Add between 1 and 24 context items.",
        ));
    }
    let target = current_target(&threads, &thread_id)?;
    if panes
        .is_interactive_thread(&thread_id)
        .map_err(|error| error.log_and_convert("context_preview_create"))?
    {
        return Err(validation(
            "context_interactive_thread_unsupported",
            "Context Drop can't send through an interactive provider pane. Use a standard thread instead.",
        ));
    }
    let root = workspace_root(&app, &target.workspace_id)
        .map_err(|error| error.log_and_convert("context_preview_create"))?;
    let firewall = firewall(app.core()?, &target.workspace_id, root.path())?;
    let mut items = Vec::with_capacity(inputs.len());
    for input in inputs {
        items.push(match input {
            ContextInput::File { handle } => {
                let resolved = git
                    .0
                    .handles()
                    .resolve(&root, &handle)
                    .map_err(|error| error.log_and_convert("context_preview_create"))?;
                let mut item = ContextItem::file(resolved.rel.as_str());
                item.label = resolved
                    .location
                    .path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(kalcode_context::package::sanitize_label)
                    .filter(|label| !label.is_empty())
                    .unwrap_or_else(|| "Workspace file".to_owned());
                item
            }
            ContextInput::Text { label, text } => {
                safe_text(&label, MAX_LABEL_CHARS, "context_label_invalid")?;
                if text.chars().count() > MAX_TEXT_CHARS || text.is_empty() {
                    return Err(validation(
                        "context_item_too_large",
                        "That context item is empty or too large.",
                    ));
                }
                ContextItem::text(ItemKind::Text, label, ItemOrigin::User, text)
            }
            ContextInput::Selection { label, text } => {
                safe_text(&label, MAX_LABEL_CHARS, "context_label_invalid")?;
                if text.chars().count() > MAX_TEXT_CHARS || text.is_empty() {
                    return Err(validation(
                        "context_item_too_large",
                        "That context item is empty or too large.",
                    ));
                }
                ContextItem::text(ItemKind::Selection, label, ItemOrigin::User, text)
            }
            ContextInput::LogOutput { label, text } => {
                safe_text(&label, MAX_LABEL_CHARS, "context_label_invalid")?;
                if text.chars().count() > MAX_TEXT_CHARS || text.is_empty() {
                    return Err(validation(
                        "context_item_too_large",
                        "That context item is empty or too large.",
                    ));
                }
                ContextItem::text(ItemKind::LogOutput, label, ItemOrigin::User, text)
            }
            ContextInput::Url { url } => {
                safe_text(&url, MAX_URL_CHARS, "context_url_invalid")?;
                ContextItem::url(url)
            }
        });
    }
    let mut options = PackageOptions::new(ContextPurpose::Drop);
    options.workspace_id = Some(target.workspace_id.clone());
    options.target_thread_id = Some(target.thread_id.clone());
    let package = ContextPackage::build(
        &firewall,
        &TextOnlyDefaults::new(target.provider_id.clone()),
        options,
        items,
    );
    let preview = package.preview();
    let id = package.id.clone();
    context
        .insert(PackageRecord {
            owner,
            generation: context.generation(),
            target: target.clone(),
            lifecycle: Lifecycle::Draft,
            package: package.clone(),
        })
        .map_err(|error| error.log_and_convert("context_preview_create"))?;
    if let Err(error) = persist_preview(app.core()?, &target, &package, true) {
        context.remove(&id);
        return Err(error);
    }
    Ok(preview)
}

#[tauri::command(async)]
pub fn context_item_set(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    app: State<'_, AppState>,
    context: crate::runtime_coordinator::RuntimeState<ContextState>,
    package_id: String,
    position: u32,
    included: bool,
) -> Result<ContextPreview, IpcError> {
    _runtime_access.revalidate()?;
    require_context_available(&app)?;
    let owner = owner(&window)?;
    let mut registry = context.lock();
    let record = registry.packages.get_mut(&package_id).ok_or_else(|| {
        validation(
            "context_package_unknown",
            "That context preview is no longer available.",
        )
    })?;
    if record.owner != owner || record.generation != context.generation() {
        return Err(validation(
            "context_package_unknown",
            "That context preview is no longer available.",
        ));
    }
    if record.lifecycle != Lifecycle::Draft {
        return Err(validation(
            "context_package_locked",
            "That context preview can no longer be changed.",
        ));
    }
    let original = record.package.clone();
    record
        .package
        .set_included(position, included)
        .map_err(|error| context_error("context_item_set", error))?;
    if let Err(error) = persist_preview(app.core()?, &record.target, &record.package, false) {
        record.package = original;
        return Err(error);
    }
    Ok(record.package.preview())
}

#[tauri::command(async)]
pub fn context_item_confirm(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    app: State<'_, AppState>,
    context: crate::runtime_coordinator::RuntimeState<ContextState>,
    package_id: String,
    position: u32,
) -> Result<ContextPreview, IpcError> {
    _runtime_access.revalidate()?;
    require_context_available(&app)?;
    let owner = owner(&window)?;
    let mut registry = context.lock();
    let record = registry.packages.get_mut(&package_id).ok_or_else(|| {
        validation(
            "context_package_unknown",
            "That context preview is no longer available.",
        )
    })?;
    if record.owner != owner || record.generation != context.generation() {
        return Err(validation(
            "context_package_unknown",
            "That context preview is no longer available.",
        ));
    }
    if record.lifecycle != Lifecycle::Draft {
        return Err(validation(
            "context_package_locked",
            "That context preview can no longer be changed.",
        ));
    }
    let original = record.package.clone();
    let entry = record
        .package
        .confirm_override(position)
        .map_err(|error| context_error("context_item_confirm", error))?;
    let fact = ContextEvent::OverrideConfirmed {
        package_id: package_id.clone(),
        position,
        rule: entry.rule.clone(),
    };
    let persisted = app.core()?.write_with_events(|transaction| {
        store::save_preview_in(transaction, &record.package).map_err(KalError::from)?;
        store::append_log_in(transaction, &[entry]).map_err(KalError::from)?;
        Ok(((), events(&record.target, vec![fact])))
    });
    if let Err(error) = persisted {
        record.package = original;
        return Err(error.log_and_convert("context_item_confirm"));
    }
    Ok(record.package.preview())
}

#[tauri::command(async)]
pub fn context_discard(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    app: State<'_, AppState>,
    context: crate::runtime_coordinator::RuntimeState<ContextState>,
    package_id: String,
) -> Result<(), IpcError> {
    _runtime_access.revalidate()?;
    require_context_available(&app)?;
    let owner = owner(&window)?;
    let mut registry = context.lock();
    let record = registry.packages.get(&package_id).ok_or_else(|| {
        validation(
            "context_package_unknown",
            "That context preview is no longer available.",
        )
    })?;
    if record.owner != owner || record.generation != context.generation() {
        return Err(validation(
            "context_package_unknown",
            "That context preview is no longer available.",
        ));
    }
    if matches!(record.lifecycle, Lifecycle::Validating | Lifecycle::Sending) {
        return Err(validation(
            "context_send_in_progress",
            "This context is already being sent.",
        ));
    }
    if record.lifecycle == Lifecycle::FailedUncertain {
        drop(registry);
        return clear_failed_uncertain(
            app.core()?,
            &context,
            owner,
            context.generation(),
            &package_id,
        );
    }
    let target = record.target.clone();
    let fact = record.package.discarded_event();
    app.core()?
        .write_with_events(|transaction| {
            store::finish_package(
                transaction,
                &package_id,
                PackageStatus::Discarded,
                &kalcode_core::time::now_rfc3339(),
            )
            .map_err(KalError::from)?;
            Ok(((), events(&target, vec![fact])))
        })
        .map_err(|error| error.log_and_convert("context_discard"))?;
    registry.packages.remove(&package_id);
    registry.order.retain(|id| id != &package_id);
    Ok(())
}

// Tauri maps these flat camelCase IPC fields directly; a wrapper would change the public wire
// shape to `{ args: ... }` and break the shared native/memory transport contract.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn context_send(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    window: WebviewWindow,
    app: State<'_, AppState>,
    threads: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    panes: crate::runtime_coordinator::RuntimeState<ProviderPanesState>,
    context: crate::runtime_coordinator::RuntimeState<ContextState>,
    package_id: String,
    thread_id: String,
    previewed_sha256: String,
    text: String,
    prompt_review_id: Option<String>,
) -> Result<ContextSendResult, IpcError> {
    _runtime_access.revalidate()?;
    require_context_available(&app)?;
    let owner = owner(&window)?;
    let text = kalcode_threads::validate::prompt(&text)
        .map_err(|error| error.log_and_convert("context_send"))?;
    let core = app.core()?;
    // Acquire the runtime before any lifecycle reservation. Failure is deterministic and leaves
    // the package Draft; after the one-shot claim no fallible runtime lookup remains.
    let runtime = threads.runtime()?.clone();
    if panes
        .is_interactive_thread(&thread_id)
        .map_err(|error| error.log_and_convert("context_send"))?
    {
        return Err(validation(
            "context_interactive_thread_unsupported",
            "Context Drop can't send through an interactive provider pane. Use a standard thread instead.",
        ));
    }
    let current = current_target_with_runtime(&runtime, &thread_id)?;
    let record = context
        .begin_validation(owner, context.generation(), &package_id, &current)
        .map_err(|error| error.log_and_convert("context_send"))?;

    let root = match workspace_root(&app, &record.target.workspace_id) {
        Ok(root) => root,
        Err(error) => {
            fail_before_send(&context, &package_id);
            return Err(error.log_and_convert("context_send"));
        }
    };
    let firewall = match firewall(core, &record.target.workspace_id, root.path()) {
        Ok(firewall) => firewall,
        Err(error) => {
            fail_before_send(&context, &package_id);
            return Err(error);
        }
    };
    let rendered = match record
        .package
        .check_before_send(&previewed_sha256, &firewall)
    {
        Ok(SendCheck::Ready(rendered)) => rendered,
        Ok(SendCheck::Stale(refreshed)) => {
            let preview = refreshed.preview();
            if let Err(error) = persist_refresh(core, &record.target, &refreshed) {
                fail_before_send(&context, &package_id);
                return Err(error);
            }
            if let Some(live) = context.lock().packages.get_mut(&package_id) {
                live.package = *refreshed;
                live.lifecycle = Lifecycle::Draft;
            }
            return Ok(ContextSendResult::Stale {
                preview: Box::new(preview),
            });
        }
        Err(error) => {
            fail_before_send(&context, &package_id);
            return Err(context_error("context_send", error));
        }
    };

    if let Err(error) = provider_payload(&text, &rendered.text()) {
        fail_before_send(&context, &package_id);
        return Err(error.log_and_convert("context_send"));
    }
    let current = match current_target_with_runtime(&runtime, &thread_id) {
        Ok(current) => current,
        Err(error) => {
            fail_before_send(&context, &package_id);
            return Err(error);
        }
    };
    // Admit only after file revalidation, immediately before the durable one-shot claim. A
    // warning or expired confirmation is deterministic and restores the package to Draft.
    let prompt_admission =
        match runtime.admit_thread_prompt(&thread_id, &text, prompt_review_id.as_deref()) {
            Ok(admission) => admission,
            Err(error) => {
                fail_before_send(&context, &package_id);
                return Err(error.log_and_convert("context_send"));
            }
        };
    if let Err(error) = threads.revalidate() {
        fail_before_send(&context, &package_id);
        return Err(error);
    }
    let record = context
        .claim_validated(owner, context.generation(), &package_id, &current)
        .map_err(|error| error.log_and_convert("context_send"))?;

    let claimed_at = kalcode_core::time::now_rfc3339();
    if let Err(error) = core.write_with_events(|transaction| {
        store::claim_delivery(
            transaction,
            &package_id,
            record.target.provider_account_id.as_deref(),
            &claimed_at,
        )
        .map_err(KalError::from)?;
        Ok(((), Vec::new()))
    }) {
        fail_before_send(&context, &package_id);
        return Err(error.log_and_convert("context_send"));
    }
    if let Err(error) = threads.revalidate() {
        persist_delivery_uncertain(core, &package_id);
        let _ = fail_uncertain(&context, &package_id);
        return Err(error);
    }

    // This is the only external runtime call. The Sending claim above makes it one-shot.
    let thread = match runtime.send_with_context_admitted(prompt_admission, &rendered) {
        Ok(thread) if !delivery_is_uncertain(thread.status) => thread,
        Ok(thread) => {
            tracing::error!(
                event = "context.send_uncertain",
                thread_status = ?thread.status
            );
            persist_delivery_uncertain(core, &package_id);
            return Err(fail_uncertain(&context, &package_id));
        }
        Err(error) => {
            tracing::error!(event = "context.send_uncertain", error_code = error.code);
            persist_delivery_uncertain(core, &package_id);
            return Err(fail_uncertain(&context, &package_id));
        }
    };

    let fact = record.package.shared_event(&rendered);
    let finished_at = kalcode_core::time::now_rfc3339();
    let stored = core.write_with_events(|transaction| {
        store::finish_delivery(
            transaction,
            &package_id,
            store::DeliveryState::Sent,
            &finished_at,
        )
        .map_err(KalError::from)?;
        store::finish_package(transaction, &package_id, PackageStatus::Sent, &finished_at)
            .map_err(KalError::from)?;
        Ok(((), events(&record.target, vec![fact])))
    });
    if let Err(error) = stored {
        tracing::error!(
            event = "context.send_persist_uncertain",
            error_code = error.code
        );
        return Err(fail_uncertain(&context, &package_id));
    }
    context.remove(&package_id);
    Ok(ContextSendResult::Sent {
        thread: Box::new(thread),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GENERATION: u64 = 7;

    fn fixture_record(lifecycle: Lifecycle) -> PackageRecord {
        PackageRecord {
            owner: MAIN_WEBVIEW.into(),
            generation: GENERATION,
            target: TargetSnapshot {
                thread_id: "thread".into(),
                provider_id: "codex".into(),
                provider_account_id: Some("account".into()),
                workspace_id: "workspace".into(),
            },
            lifecycle,
            package: ContextPackage::build(
                &Firewall::new(
                    kalcode_context::WorkspaceRoot::none(),
                    FirewallPolicy::default(),
                ),
                &TextOnlyDefaults::new("codex"),
                PackageOptions::new(ContextPurpose::Drop),
                vec![ContextItem::text(
                    ItemKind::Text,
                    "note",
                    ItemOrigin::User,
                    "bounded",
                )],
            ),
        }
    }

    #[test]
    fn registry_is_bounded_without_evicting_uncertain_sends() {
        let state = ContextState::default();
        {
            let mut registry = state.lock();
            for index in 0..MAX_PACKAGES {
                registry.packages.insert(
                    format!("p-{index}"),
                    fixture_record(Lifecycle::FailedUncertain),
                );
                registry.order.push_back(format!("p-{index}"));
            }
        }
        let error = state
            .insert(fixture_record(Lifecycle::Draft))
            .expect_err("uncertain sends are retained");
        assert_eq!(error.code, "context_capacity");
    }

    #[test]
    fn send_claim_is_one_shot_and_bound_to_the_exact_target() {
        let state = ContextState::default();
        let record = fixture_record(Lifecycle::Draft);
        let id = record.package.id.clone();
        let target = record.target.clone();
        state.insert(record).expect("insert");

        state
            .begin_validation(MAIN_WEBVIEW, GENERATION, &id, &target)
            .expect("begin validation");
        let duplicate = state
            .begin_validation(MAIN_WEBVIEW, GENERATION, &id, &target)
            .expect_err("concurrent duplicate");
        assert_eq!(duplicate.code, "context_send_in_progress");
        state
            .claim_validated(MAIN_WEBVIEW, GENERATION, &id, &target)
            .expect("one-shot claim after validation");

        assert_eq!(fail_uncertain(&state, &id).code, "context_send_uncertain");
        let retry = state
            .begin_validation(MAIN_WEBVIEW, GENERATION, &id, &target)
            .expect_err("uncertain sends never replay");
        assert_eq!(retry.code, "context_send_uncertain");

        let other = ContextState::default();
        let record = fixture_record(Lifecycle::Draft);
        let id = record.package.id.clone();
        let mut changed = record.target.clone();
        changed.provider_account_id = Some("different-account".into());
        other.insert(record).expect("insert target");
        let mismatch = other
            .begin_validation(MAIN_WEBVIEW, GENERATION, &id, &changed)
            .expect_err("account identity changed");
        assert_eq!(mismatch.code, "context_target_changed");
    }

    #[test]
    fn account_generation_change_hides_and_drain_clears_raw_packages() {
        let state = ContextState::default();
        let record = fixture_record(Lifecycle::Draft);
        let id = record.package.id.clone();
        let target = record.target.clone();
        state.insert(record).expect("insert generation N package");

        let stale = state
            .begin_validation(MAIN_WEBVIEW, GENERATION + 1, &id, &target)
            .expect_err("generation N+1 cannot access generation N package");
        assert_eq!(stale.code, "context_package_unknown");
        assert!(state.lock().packages.contains_key(&id));

        state.clear();
        assert!(state.lock().packages.is_empty());
        let cleared = state
            .begin_validation(MAIN_WEBVIEW, GENERATION, &id, &target)
            .expect_err("drain drops source-bearing packages");
        assert_eq!(cleared.code, "context_package_unknown");
    }

    #[test]
    fn uncertain_delivery_can_be_cleared_without_rewriting_durable_truth() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let core = kalcode_core::Core::open(kalcode_core::CoreConfig {
            paths: kalcode_core::Paths::new(directory.path()),
            app_version: "0.0.0-context-test".into(),
            channel: kalcode_core::flags::BuildChannel::Development,
        })
        .expect("open core");
        let state = ContextState::default();
        let record = fixture_record(Lifecycle::FailedUncertain);
        let id = record.package.id.clone();
        let claimed = "2026-09-25T12:00:00.000Z";
        let finished = "2026-09-25T12:00:01.000Z";
        core.write_with_events(|transaction| {
            store::save_preview_in(transaction, &record.package).map_err(KalError::from)?;
            Ok(((), Vec::new()))
        })
        .expect("persist preview");
        state.insert(record).expect("retain source-bearing package");
        assert!(
            clear_failed_uncertain(&core, &state, MAIN_WEBVIEW, GENERATION, &id).is_err(),
            "memory is retained until durable uncertain truth exists"
        );
        assert!(state.lock().packages.contains_key(&id));

        core.write_with_events(|transaction| {
            store::claim_delivery(transaction, &id, None, claimed).map_err(KalError::from)?;
            store::finish_delivery(
                transaction,
                &id,
                store::DeliveryState::FailedUncertain,
                finished,
            )
            .map_err(KalError::from)?;
            Ok(((), Vec::new()))
        })
        .expect("persist uncertain delivery");

        clear_failed_uncertain(&core, &state, MAIN_WEBVIEW, GENERATION, &id)
            .expect("acknowledge uncertain outcome");
        assert!(!state.lock().packages.contains_key(&id));
        core.read(|connection| {
            assert_eq!(
                store::delivery_state(connection, &id).map_err(KalError::from)?,
                Some(store::DeliveryState::FailedUncertain)
            );
            assert_eq!(
                store::package_status(connection, &id)
                    .map_err(KalError::from)?
                    .as_deref(),
                Some("blocked")
            );
            assert!(store::claim_delivery(connection, &id, None, claimed).is_err());
            Ok(())
        })
        .expect("append-only uncertain truth remains");
        core.shutdown();
    }

    #[test]
    fn payload_validation_uses_the_canonical_thread_limit_before_claim() {
        let prefix = "x\n\nContext supplied by you:\n";
        let exact =
            "a".repeat(kalcode_threads::validate::MAX_PROMPT_CHARS - prefix.chars().count());
        let (_, accepted) = provider_payload("x", &exact).expect("exact boundary");
        assert_eq!(
            accepted.chars().count(),
            kalcode_threads::validate::MAX_PROMPT_CHARS
        );

        let too_large = format!("{exact}a");
        let oversized = provider_payload("x", &too_large).expect_err("over limit");
        assert_eq!(oversized.code, "invalid_prompt");
        let nul = provider_payload("x", "safe\0unsafe").expect_err("nul");
        assert_eq!(nul.code, "invalid_prompt");

        let state = ContextState::default();
        let record = fixture_record(Lifecycle::Draft);
        let id = record.package.id.clone();
        let target = record.target.clone();
        state.insert(record).expect("insert");
        state
            .begin_validation(MAIN_WEBVIEW, GENERATION, &id, &target)
            .expect("validation reservation");
        fail_before_send(&state, &id);
        state
            .begin_validation(MAIN_WEBVIEW, GENERATION, &id, &target)
            .expect("deterministic validation failure remains retryable");
    }

    #[test]
    fn failed_delivery_statuses_are_never_finalized_as_shared() {
        for status in [
            ThreadStatus::Failed,
            ThreadStatus::Offline,
            ThreadStatus::Interrupted,
        ] {
            assert!(delivery_is_uncertain(status));
        }
        for status in [
            ThreadStatus::Active,
            ThreadStatus::Idle,
            ThreadStatus::Completed,
            ThreadStatus::WaitingForPermission,
        ] {
            assert!(!delivery_is_uncertain(status));
        }

        let state = ContextState::default();
        let record = fixture_record(Lifecycle::Sending);
        let id = record.package.id.clone();
        state.insert(record).expect("insert sending record");
        assert_eq!(fail_uncertain(&state, &id).code, "context_send_uncertain");
        assert_eq!(
            state
                .lock()
                .packages
                .get(&id)
                .map(|record| record.lifecycle),
            Some(Lifecycle::FailedUncertain)
        );
    }
}
