//! Developer Utility Dock IPC (UD, `kalcode_utilities`).
//!
//! Rules every command follows (ADVANCED.md §7.10, §9, `docs/UTILITY_DOCK.md`):
//! * the WebView never supplies a path: workspace files are named by file handles issued by
//!   native listings (D4), other files come from the native picker;
//! * consequential actions are evaluated by the permission engine with
//!   `ActionOrigin::Utility { tool }` — `network` (API Inspector), `process_signal` (Process
//!   Monitor), `file_write` (SQLite changes) — and a deny ends them; what the engine asks is
//!   answered by the person's own action in KalCode or, for the D8 set, by a **native**
//!   confirmation the WebView can't forge (a request to a new host, stopping a process KalCode
//!   didn't start, revealing an environment value);
//! * nothing sensitive is logged: requests are logged by method and host, environment values
//!   never, SQL never;
//! * the commands work only where the Utility Dock feature is visible (development builds until
//!   the feature is flipped), and run off the UI thread.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::app::FeatureId;
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::{
    ActionKind, NormalizedAction, PolicyEffect, ProcessSignalKind, UtilityHttpDestination,
    UtilityHttpMethod,
};
use kalcode_contracts::refs::{FileHandle, FileRef};
use kalcode_contracts::utility::UtilityTool;
use kalcode_core::confirm::{NativeConfirmation, NativeConfirmer, confirm};
use kalcode_core::{Core, ErrorCategory, IpcError, KalError};
use kalcode_git::GitCore;
use kalcode_permissions::{PermissionService, UTILITY_APPROVAL_TTL_MS};
use kalcode_utilities::http::{
    ApprovedHttpOutcome, GateVerdict, HttpSession, NetworkGate, PreparedHttpEffect,
    PreparedHttpResolution,
};
use kalcode_utilities::processes::{
    PreparedProcessSignal, ProcessContext, ProcessSampler, TerminalRoot, WorkspaceRoot,
};
use kalcode_utilities::sqlite::{PreparedSqliteWrite, SqliteSessions};
use kalcode_utilities::store::Store;
use kalcode_utilities::{
    EnvListing, EnvReveal, EnvSource, HttpDestination, HttpHistoryEntry, HttpRequestSpec,
    HttpSavedRequest, Killability, PortList, PortLookup, ProcessList, ProcessScope,
    ProcessSignalResult, RegexFlags, RegexResult, Scratchpad, ScratchpadList, SignalOutcome,
    SqliteHandle, SqliteQueryResult, TextFile, UtilityEffectOutcome, UtilityStatus, env, files,
    ports, regex_lab,
};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::AppState;
use crate::git_commands::GitState;
use crate::native_confirm::TauriConfirmer;
use crate::runtime_coordinator::{RuntimeAccess, RuntimeState};

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/// Everything the dock's native tools share. One per app.
pub struct UtilityHub {
    core: Arc<Core>,
    store: Store,
    http: HttpSession,
    sqlite: SqliteSessions,
    sampler: Mutex<ProcessSampler>,
    permissions: Arc<PermissionService>,
    confirmer: Arc<dyn NativeConfirmer>,
    git: Arc<GitCore>,
    data_dir: PathBuf,
    version: String,
    enabled: bool,
    operations: Mutex<HashMap<String, SealedOperation>>,
}

const MAX_SEALED_OPERATIONS: usize = 32;
const SEALED_OPERATION_TTL: Duration = Duration::from_millis(UTILITY_APPROVAL_TTL_MS as u64);

fn utility_enabled(flag: Option<&kalcode_core::flags::FeatureFlag>) -> bool {
    flag.is_some_and(|flag| {
        flag.visible && flag.state == kalcode_core::flags::SurfaceState::Available
    })
}

enum SealedEffect {
    HttpResolve(PreparedHttpResolution),
    HttpSend(PreparedHttpEffect),
    Process {
        prepared: PreparedProcessSignal,
        process: kalcode_utilities::ProcessInfo,
    },
    Sqlite(PreparedSqliteWrite),
}

struct SealedOperation {
    action: NormalizedAction,
    generation: u64,
    created: Instant,
    effect: SealedEffect,
}

/// Managed state. `None` when the core didn't start.
pub struct UtilityState(Option<Arc<UtilityHub>>);

impl UtilityState {
    pub fn start(
        state: &AppState,
        permissions: Option<Arc<PermissionService>>,
        git: &GitState,
        app: &AppHandle,
    ) -> Self {
        let Some(core) = state.core.clone() else {
            return Self(None);
        };
        let Some(permissions) = permissions else {
            tracing::error!(event = "utility.permissions_unavailable");
            return Self(None);
        };
        let store = match Store::open(&core) {
            Ok(store) => store,
            Err(error) => {
                // Persistent utility data is authoritative. A missing/corrupt schema disables
                // the Dock rather than silently replacing saved requests and scratchpads with
                // an empty in-memory store.
                tracing::error!(event = "utility.store_failed", error = %error.diagnostic());
                return Self(None);
            }
        };
        let enabled = utility_enabled(state.info.flags.feature(FeatureId::UtilityDock));
        Self(Some(Arc::new(UtilityHub {
            core,
            store,
            http: HttpSession::new(),
            sqlite: SqliteSessions::new(),
            sampler: Mutex::new(ProcessSampler::new()),
            permissions,
            confirmer: Arc::new(TauriConfirmer::new(app.clone())),
            git: Arc::clone(&git.0),
            data_dir: state.paths.data_dir.clone(),
            version: state.info.version.clone(),
            enabled,
            operations: Mutex::new(HashMap::new()),
        })))
    }

    fn hub(&self) -> Result<Arc<UtilityHub>, IpcError> {
        let hub = self.0.clone().ok_or_else(|| {
            KalError::internal(
                "utilities_unavailable",
                "The Utility Dock isn't available right now. Restart KalCode; if this keeps happening, export diagnostics.",
            )
            .to_ipc()
        })?;
        if !hub.enabled {
            return Err(KalError::validation(
                "not_in_this_build",
                "The Utility Dock isn't in this build yet.",
            )
            .to_ipc());
        }
        Ok(hub)
    }

    /// The hub for KalVoice (port answers, the response count); `None` when unavailable.
    pub fn handle(&self) -> Option<Arc<UtilityHub>> {
        self.0.clone().filter(|h| h.enabled)
    }

    /// Cancels every unclaimed effect and closes retained database identities. Dropping a sealed
    /// process or HTTP operation performs no external effect. This is idempotent for coordinator
    /// retry and contains no detached workers.
    pub fn shutdown_checked(&self) -> kalcode_core::Result<()> {
        if let Some(hub) = &self.0 {
            hub.operations
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clear();
            let http_result = hub.http.shutdown_checked();
            hub.sqlite.close_all();
            http_result?;
        }
        Ok(())
    }
}

/// Runs blocking work off the UI thread and converts errors for IPC.
async fn blocking<T: Send + 'static>(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    command: &'static str,
    work: impl FnOnce() -> Result<T, KalError> + Send + 'static,
) -> Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        runtime_access.revalidate_core()?;
        utilities.revalidate_core()?;
        work()
    })
    .await
    .map_err(|e| {
        KalError::internal("utility_interrupted", "That was interrupted.")
            .with_source(e)
            .log_and_convert(command)
    })?
    .map_err(|e| e.log_and_convert(command))
}

fn refused(code: &'static str, message: impl Into<String>) -> KalError {
    KalError::new(ErrorCategory::Permission, code, message)
}

fn confirmation_error(code: &'static str) -> KalError {
    refused(
        code,
        if code == "confirmation_declined" {
            "You didn't confirm, so nothing was done."
        } else {
            "KalCode couldn't show its confirmation window, so nothing was done."
        },
    )
}

impl UtilityHub {
    // Seal the complete operation and its authority together; callers supply every binding.
    #[allow(clippy::too_many_arguments)]
    fn seal_operation(
        &self,
        tool: UtilityTool,
        workspace_id: Option<&str>,
        operation_id: String,
        action: ActionKind,
        summary: String,
        generation: u64,
        effect: SealedEffect,
    ) -> Result<UtilityEffectOutcome, KalError> {
        let normalized = NormalizedAction {
            id: operation_id,
            thread_id: String::new(),
            workspace_id: workspace_id.unwrap_or_default().to_owned(),
            provider_id: ProviderId::new(""),
            action,
            summary,
            requested_at: kalcode_core::time::now_rfc3339(),
            origin: Some(tool.origin()),
        };
        let mut operations = self
            .operations
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        operations.retain(|_, operation| operation.created.elapsed() <= SEALED_OPERATION_TTL);
        if operations.len() >= MAX_SEALED_OPERATIONS {
            return Err(KalError::new(
                ErrorCategory::Validation,
                "utility_operation_limit",
                "Finish or cancel a pending Utility Dock approval before starting another action.",
            ));
        }
        let outcome = self.permissions.request_for_origin(normalized.clone())?;
        if outcome.decision.effect != PolicyEffect::Ask {
            return Err(refused(
                "blocked_by_policy",
                format!(
                    "Your permission settings didn't create an approval for this action. {}",
                    outcome.decision.reason
                ),
            ));
        }
        let approval = outcome.approval.ok_or_else(|| {
            KalError::internal(
                "utility_approval_missing",
                "KalCode couldn't create the required one-time approval.",
            )
        })?;
        let approval_id = approval.id.clone();
        operations.insert(
            approval.id,
            SealedOperation {
                action: normalized,
                generation,
                created: Instant::now(),
                effect,
            },
        );
        Ok(UtilityEffectOutcome::AwaitingApproval { approval_id })
    }

    /// Claims before removing the retained effect. Pending approvals stay retryable; every
    /// terminal refusal drops the sealed native object, and a successful claim is never restored.
    fn claim_operation(
        &self,
        approval_id: &str,
        generation: u64,
    ) -> Result<SealedEffect, KalError> {
        let mut operations = self
            .operations
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        operations.retain(|_, operation| operation.created.elapsed() <= SEALED_OPERATION_TTL);
        let Some(operation) = operations.get(approval_id) else {
            return Err(KalError::validation(
                "utility_operation_unavailable",
                "That Utility Dock action is no longer available. Start it again.",
            ));
        };
        if operation.generation != generation {
            operations.remove(approval_id);
            return Err(refused(
                "utility_runtime_changed",
                "That Utility Dock action belongs to an earlier account runtime.",
            ));
        }
        let action = operation.action.clone();
        if let Err(error) =
            self.permissions
                .claim_utility_approval(approval_id, &action, generation)
        {
            if error.code != "approval_pending" {
                operations.remove(approval_id);
            }
            return Err(error);
        }
        operations
            .remove(approval_id)
            .map(|operation| operation.effect)
            .ok_or_else(|| {
                KalError::internal(
                    "utility_operation_missing",
                    "That approved Utility Dock action couldn't be recovered.",
                )
            })
    }

    fn workspace_root(&self, workspace_id: &str) -> Result<kalcode_git::WorkspaceRoot, KalError> {
        if !kalcode_contracts::ids::is_valid_id(workspace_id) {
            return Err(KalError::validation("invalid_id", "That id isn't valid."));
        }
        let workspace = self
            .core
            .workspaces()?
            .into_iter()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| {
                KalError::validation("workspace_unknown", "That workspace no longer exists.")
            })?;
        if !workspace.available {
            return Err(KalError::new(
                ErrorCategory::Filesystem,
                "workspace_unavailable",
                "That workspace folder is unavailable.",
            ));
        }
        kalcode_git::WorkspaceRoot::new(&workspace.id, Path::new(&workspace.root_path))
    }

    fn native_confirm(&self, confirmation: &NativeConfirmation) -> Result<(), KalError> {
        confirm(self.confirmer.as_ref(), confirmation)
            .map(|_| ())
            .map_err(|e| confirmation_error(e.code()))
    }

    fn workspaces(&self) -> Vec<kalcode_core::workspaces::Workspace> {
        self.core.workspaces().unwrap_or_default()
    }

    /// What the process tools know about KalCode: open workspaces, terminal shells and (when
    /// `with_ports`) listening sockets.
    fn process_context(&self, raw_ports: Option<&[ports::RawPort]>) -> ProcessContext {
        let workspaces = self
            .workspaces()
            .into_iter()
            .filter(|w| w.available)
            .map(|w| WorkspaceRoot {
                id: w.id,
                name: w.name,
                path: PathBuf::from(w.root_path),
            })
            .collect();
        let terminals = self
            .core
            .running_terminals()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|t| {
                self.core
                    .terminal_session_identity(&t.id)
                    .map(|identity| TerminalRoot {
                        pid: identity.pid,
                        generation: identity.generation,
                        terminal_id: t.id,
                        workspace_id: t.workspace_id,
                    })
            })
            .collect();
        let listening = raw_ports
            .map(|raw| ports::owners(raw).into_iter().collect())
            .unwrap_or_default();
        ProcessContext {
            self_pid: std::process::id(),
            workspaces,
            terminals,
            listening,
        }
    }

    fn sampler(&self) -> std::sync::MutexGuard<'_, ProcessSampler> {
        self.sampler.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn ports(&self) -> Result<PortList, KalError> {
        let (raw, source) = ports::list_raw()?;
        let ctx = self.process_context(Some(&raw));
        let processes = self.sampler().list(&ctx, ProcessScope::All);
        Ok(PortList {
            ports: ports::annotate(&raw, &processes.processes),
            source: source.to_owned(),
            sampled_at: kalcode_core::time::now_rfc3339(),
        })
    }

    /// "What's using port 3000?" (the Port Inspector and KalVoice).
    pub fn port_lookup(&self, port: u16) -> Result<PortLookup, KalError> {
        Ok(ports::lookup(port, &self.ports()?.ports))
    }

    /// Completed API Inspector requests this session (for "diff these responses").
    pub fn responses_this_session(&self) -> usize {
        self.http
            .history()
            .iter()
            .filter(|h| h.status.is_some())
            .count()
    }

    fn workspace_env_note(provider: &str, prefixes: &[&str]) -> String {
        format!(
            "What {provider} receives: only what every CLI needs (paths, locale, temporary folders, proxies and certificates) plus its own variables ({}). Nothing from other providers or from KalCode itself.",
            prefixes.join(", ")
        )
    }

    fn env_for(&self, source: &EnvSource) -> Result<(BTreeMap<String, String>, String), KalError> {
        let kalcode = env::from_os(std::env::vars_os());
        match source {
            EnvSource::KalCode => Ok((
                kalcode,
                "KalCode's own environment. Terminals and provider CLIs receive filtered copies (choose them above).".into(),
            )),
            EnvSource::Terminal => Ok((
                env::terminal_env(&kalcode, &self.version),
                "What a new terminal receives: KalCode's environment without KalCode's own settings (KALCODE_*) and browser-runtime overrides, plus TERM, COLORTERM, TERM_PROGRAM and TERM_PROGRAM_VERSION.".into(),
            )),
            EnvSource::Provider { provider_id } => {
                let spec = kalcode_providers::catalog::specs()
                    .into_iter()
                    .find(|s| s.provider_id == provider_id.as_str())
                    .ok_or_else(|| {
                        KalError::validation("provider_unknown", "KalCode doesn't know that provider.")
                    })?;
                let sanitized =
                    kalcode_providers::env::sanitized_env(std::env::vars_os(), &spec.env_policy);
                Ok((
                    env::from_os(sanitized),
                    Self::workspace_env_note(spec.display_name, spec.env_policy.provider_prefixes),
                ))
            }
        }
    }

    /// Refuses KalCode's own data folder (its database, backups and logs).
    fn check_not_kalcode_data(&self, path: &Path) -> Result<(), KalError> {
        let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let data = std::fs::canonicalize(&self.data_dir).unwrap_or_else(|_| self.data_dir.clone());
        if canonical.starts_with(&data) {
            return Err(refused(
                "sqlite_kalcode_data",
                "The SQLite Viewer doesn't open KalCode's own data.",
            ));
        }
        Ok(())
    }
}

/// The permission engine and native confirmations, as the API Inspector's gate.
struct EngineGate<'a> {
    hub: &'a UtilityHub,
}

impl NetworkGate for EngineGate<'_> {
    fn evaluate(&self, _host: &str, _origin_url: &str) -> GateVerdict {
        // `HttpSession::send` is the legacy combined prepare/effect API. Production commands use
        // separate durable one-time DNS and send claims; deny any accidental return to the
        // combined path.
        GateVerdict::Deny {
            reason: "This request was not claimed through the one-time Utility approval path."
                .into(),
        }
    }

    fn confirm(&self, host: &str, destination: HttpDestination) -> Result<(), &'static str> {
        let confirmation = if destination == HttpDestination::LinkLocal {
            NativeConfirmation::link_local_request(host)
        } else {
            NativeConfirmation::new_host_request(host)
        };
        confirm(self.hub.confirmer.as_ref(), &confirmation)
            .map(|_| ())
            .map_err(|e| e.code())
    }
}

fn command_hub(
    runtime_access: &RuntimeAccess,
    utilities: &RuntimeState<UtilityState>,
) -> Result<Arc<UtilityHub>, IpcError> {
    runtime_access.revalidate()?;
    utilities.revalidate()?;
    utilities.hub()
}

fn permission_http_method(method: kalcode_utilities::HttpMethod) -> UtilityHttpMethod {
    match method {
        kalcode_utilities::HttpMethod::Get => UtilityHttpMethod::Get,
        kalcode_utilities::HttpMethod::Head => UtilityHttpMethod::Head,
        kalcode_utilities::HttpMethod::Post => UtilityHttpMethod::Post,
        kalcode_utilities::HttpMethod::Put => UtilityHttpMethod::Put,
        kalcode_utilities::HttpMethod::Patch => UtilityHttpMethod::Patch,
        kalcode_utilities::HttpMethod::Delete => UtilityHttpMethod::Delete,
        kalcode_utilities::HttpMethod::Options => UtilityHttpMethod::Options,
    }
}

fn permission_destination(destination: HttpDestination) -> UtilityHttpDestination {
    match destination {
        HttpDestination::Loopback => UtilityHttpDestination::Loopback,
        HttpDestination::Private => UtilityHttpDestination::Private,
        HttpDestination::External => UtilityHttpDestination::External,
        HttpDestination::LinkLocal => UtilityHttpDestination::LinkLocal,
    }
}

fn seal_http(
    hub: &UtilityHub,
    prepared: PreparedHttpEffect,
    generation: u64,
) -> Result<UtilityEffectOutcome, KalError> {
    let operation_id = new_id();
    let method = prepared.method();
    let origin = prepared.origin();
    let destination = prepared.destination();
    let redirect_hop = prepared.redirect_hop();
    let body_bytes = prepared.body_bytes();
    hub.seal_operation(
        UtilityTool::ApiInspector,
        None,
        operation_id.clone(),
        ActionKind::UtilityHttp {
            operation_id,
            method: permission_http_method(method),
            origin: origin.clone(),
            destination: permission_destination(destination),
            redirect_hop,
            body_bytes,
        },
        format!(
            "API Inspector {} to {origin} (redirect hop {redirect_hop})",
            method.as_str()
        ),
        generation,
        SealedEffect::HttpSend(prepared),
    )
}

fn seal_http_resolution(
    hub: &UtilityHub,
    prepared: PreparedHttpResolution,
    generation: u64,
) -> Result<UtilityEffectOutcome, KalError> {
    let operation_id = new_id();
    let host = prepared.host();
    let redirect_hop = prepared.redirect_hop();
    hub.seal_operation(
        UtilityTool::ApiInspector,
        None,
        operation_id.clone(),
        ActionKind::UtilityDnsResolve {
            operation_id,
            host: host.clone(),
        },
        format!("Resolve {host} for API Inspector (redirect hop {redirect_hop})"),
        generation,
        SealedEffect::HttpResolve(prepared),
    )
}

fn process_result(
    info: &kalcode_utilities::ProcessInfo,
    signal: ProcessSignalKind,
    outcome: SignalOutcome,
) -> ProcessSignalResult {
    ProcessSignalResult {
        pid: info.pid,
        signal,
        outcome,
        message: match outcome {
            SignalOutcome::Stopped => format!("{} stopped.", info.name),
            SignalOutcome::AlreadyExited => format!("{} had already exited.", info.name),
            SignalOutcome::StillRunning => format!(
                "{} was asked to stop and is still running. Use Force stop to end it.",
                info.name
            ),
            SignalOutcome::Restarted => String::new(),
        },
    }
}

// ---------------------------------------------------------------------------------------------
// Commands: status
// ---------------------------------------------------------------------------------------------

#[tauri::command(async)]
pub fn utility_status(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
) -> Result<UtilityStatus, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    Ok(UtilityStatus {
        persistent: hub.store.persistent(),
        port_source: ports::tool_name().map(str::to_owned),
    })
}

// ---------------------------------------------------------------------------------------------
// API Inspector
// ---------------------------------------------------------------------------------------------

/// Sends a request from native code through the permission engine (see the module comment).
#[tauri::command]
pub async fn utility_http_send(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    request: HttpRequestSpec,
) -> Result<UtilityEffectOutcome, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    let generation = utilities.generation();
    blocking(runtime_access, utilities, "utility_http_send", move || {
        let effect = hub.http.prepare_resolution(&request)?;
        seal_http_resolution(&hub, effect, generation)
    })
    .await
}

#[tauri::command(async)]
pub fn utility_http_history(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
) -> Result<Vec<HttpHistoryEntry>, IpcError> {
    Ok(command_hub(&runtime_access, &utilities)?.http.history())
}

#[tauri::command(async)]
pub fn utility_http_history_clear(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
) -> Result<(), IpcError> {
    command_hub(&runtime_access, &utilities)?
        .http
        .clear_history();
    Ok(())
}

#[tauri::command(async)]
pub fn utility_http_saved_list(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
) -> Result<Vec<HttpSavedRequest>, IpcError> {
    command_hub(&runtime_access, &utilities)?
        .store
        .saved_requests()
        .map_err(|e| e.log_and_convert("utility_http_saved_list"))
}

#[tauri::command(async)]
pub fn utility_http_saved_save(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    id: Option<String>,
    name: String,
    request: HttpRequestSpec,
) -> Result<HttpSavedRequest, IpcError> {
    command_hub(&runtime_access, &utilities)?
        .store
        .save_request(id.as_deref(), &name, &request)
        .map_err(|e| e.log_and_convert("utility_http_saved_save"))
}

#[tauri::command(async)]
pub fn utility_http_saved_delete(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    id: String,
) -> Result<(), IpcError> {
    command_hub(&runtime_access, &utilities)?
        .store
        .delete_request(&id)
        .map_err(|e| e.log_and_convert("utility_http_saved_delete"))
}

/// Consumes one exact approval. The WebView supplies only the opaque approval id; every
/// consequential parameter remains in the authenticated runtime's sealed operation.
#[tauri::command]
pub async fn utility_effect_continue(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    approval_id: String,
) -> Result<UtilityEffectOutcome, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    let generation = utilities.generation();
    blocking(
        runtime_access,
        utilities,
        "utility_effect_continue",
        move || {
            let effect = hub.claim_operation(&approval_id, generation)?;
            match effect {
                SealedEffect::HttpResolve(prepared) => {
                    let pinned = hub.http.resolve_approved(prepared)?;
                    seal_http(&hub, pinned, generation)
                }
                SealedEffect::HttpSend(prepared) => {
                    match hub
                        .http
                        .execute_approved(prepared, &EngineGate { hub: &hub })?
                    {
                        ApprovedHttpOutcome::Completed(response) => {
                            Ok(UtilityEffectOutcome::HttpCompleted { response })
                        }
                        ApprovedHttpOutcome::Redirect(next) => {
                            seal_http_resolution(&hub, next, generation)
                        }
                    }
                }
                SealedEffect::Process { prepared, process } => {
                    match &process.killable {
                        Killability::Confirm => {}
                        Killability::NativeConfirm => {
                            hub.native_confirm(&NativeConfirmation::terminate_foreign_process(
                                &process.name,
                                process.pid,
                            ))?
                        }
                        Killability::Refused { reason } => {
                            return Err(refused(
                                "process_refused",
                                format!("KalCode won't stop {}: {reason}", process.name),
                            ));
                        }
                    }
                    let signal = prepared.signal();
                    let outcome = prepared.execute()?;
                    tracing::info!(
                        event = "utility.process_signaled",
                        pid = process.pid,
                        process = %process.name,
                        signal = ?signal,
                        owner = ?process.owner,
                        outcome = ?outcome
                    );
                    Ok(UtilityEffectOutcome::ProcessCompleted {
                        result: process_result(&process, signal, outcome),
                    })
                }
                SealedEffect::Sqlite(prepared) => {
                    let result = prepared.execute()?;
                    Ok(UtilityEffectOutcome::SqliteCompleted { result })
                }
            }
        },
    )
    .await
}

// ---------------------------------------------------------------------------------------------
// Process Monitor and Port Inspector
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn utility_processes(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    scope: ProcessScope,
) -> Result<ProcessList, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    blocking(runtime_access, utilities, "utility_processes", move || {
        // Port owners count as related; a missing port tool only loses that hint.
        let raw = ports::list_raw().map(|(raw, _)| raw).ok();
        let ctx = hub.process_context(raw.as_deref());
        Ok(hub.sampler().list(&ctx, scope))
    })
    .await
}

/// Seals a process signal against a retained pid/start-time handle and creates an exact one-time
/// approval. The effect happens only through `utility_effect_continue` after a durable claim.
#[tauri::command]
pub async fn utility_process_signal(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    pid: u32,
    start_time: String,
    signal: ProcessSignalKind,
) -> Result<UtilityEffectOutcome, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    let generation = utilities.generation();
    blocking(
        runtime_access,
        utilities,
        "utility_process_signal",
        move || {
            let start_time = parse_process_identity(&start_time)?;
            let ctx = hub.process_context(None);
            let (info, prepared) = hub.sampler().prepare_stop(&ctx, pid, start_time, signal)?;
            if let Killability::Refused { reason } = &info.killable {
                return Err(refused(
                    "process_refused",
                    format!("KalCode won't stop {}: {reason}", info.name),
                ));
            }
            let operation_id = new_id();
            let workspace_id = info.workspace_id.clone();
            hub.seal_operation(
                UtilityTool::Processes,
                workspace_id.as_deref(),
                operation_id.clone(),
                ActionKind::UtilityProcessSignal {
                    operation_id,
                    pid: info.pid,
                    process_start_time: info.start_time.clone(),
                    process_name: info.name.clone(),
                    signal,
                },
                format!("Signal {} (process {})", info.name, info.pid),
                generation,
                SealedEffect::Process {
                    prepared,
                    process: info,
                },
            )
        },
    )
    .await
}

fn parse_process_identity(value: &str) -> Result<u64, KalError> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(KalError::validation(
            "invalid_process_identity",
            "That process identity is invalid. Refresh the process list.",
        ));
    }
    value.parse::<u64>().map_err(|_| {
        KalError::validation(
            "invalid_process_identity",
            "That process identity is invalid. Refresh the process list.",
        )
    })
}

/// Restarts a KalCode terminal from its shell's row (Z1 restart), after the same checks as a
/// stop.
#[tauri::command]
pub async fn utility_process_restart(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    pid: u32,
    start_time: String,
) -> Result<UtilityEffectOutcome, IpcError> {
    command_hub(&runtime_access, &utilities)?;
    let _ = (
        pid,
        parse_process_identity(&start_time).map_err(|e| e.to_ipc())?,
    );
    Err(KalError::validation(
        "restart_authority_unavailable",
        "Terminal restart needs its own typed one-time authority and is unavailable here.",
    )
    .to_ipc())
}

#[tauri::command]
pub async fn utility_ports(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
) -> Result<PortList, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    blocking(runtime_access, utilities, "utility_ports", move || {
        hub.ports()
    })
    .await
}

#[tauri::command]
pub async fn utility_port_lookup(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    port: u16,
) -> Result<PortLookup, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    blocking(
        runtime_access,
        utilities,
        "utility_port_lookup",
        move || hub.port_lookup(port),
    )
    .await
}

// ---------------------------------------------------------------------------------------------
// Environment Viewer
// ---------------------------------------------------------------------------------------------

#[tauri::command(async)]
pub fn utility_env_list(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    source: EnvSource,
) -> Result<EnvListing, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    let kalcode = env::from_os(std::env::vars_os());
    let (vars, note) = hub
        .env_for(&source)
        .map_err(|e| e.log_and_convert("utility_env_list"))?;
    Ok(env::listing(source, &vars, &kalcode, note))
}

/// Reveals one value after a native confirmation. The value is never logged.
#[tauri::command]
pub async fn utility_env_reveal(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    source: EnvSource,
    name: String,
) -> Result<EnvReveal, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
        return Err(
            KalError::validation("env_name_invalid", "That variable name isn't valid.").to_ipc(),
        );
    }
    blocking(runtime_access, utilities, "utility_env_reveal", move || {
        let (vars, _) = hub.env_for(&source)?;
        let value = env::value_of(&vars, &name).ok_or_else(|| {
            KalError::validation("env_not_found", "That variable isn't set for this source.")
        })?;
        hub.native_confirm(&NativeConfirmation::reveal_env_value(&name))?;
        tracing::info!(event = "utility.env_revealed");
        Ok(EnvReveal { name, value })
    })
    .await
}

// ---------------------------------------------------------------------------------------------
// SQLite Viewer
// ---------------------------------------------------------------------------------------------

fn find_in_index(
    git: &GitCore,
    root: &kalcode_git::WorkspaceRoot,
    queries: &[&str],
    keep: impl Fn(&str) -> bool,
    limit: usize,
) -> Result<Vec<FileRef>, KalError> {
    let index = git.index(root)?;
    let mut out: Vec<FileRef> = Vec::new();
    for query in queries {
        for rel in index.find(query, 2_000) {
            if out.len() >= limit {
                return Ok(out);
            }
            if keep(rel.as_str()) && !out.iter().any(|f| f.display_path == rel.as_str()) {
                out.push(git.handles().issue(root, &rel)?);
            }
        }
    }
    Ok(out)
}

/// SQLite files in a workspace (by extension), as handles.
#[tauri::command]
pub async fn utility_sqlite_candidates(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    workspace_id: String,
) -> Result<Vec<FileRef>, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    let root = hub
        .workspace_root(&workspace_id)
        .map_err(|e| e.log_and_convert("utility_sqlite_candidates"))?;
    blocking(
        runtime_access,
        utilities,
        "utility_sqlite_candidates",
        move || {
            find_in_index(
                &hub.git,
                &root,
                &[".db", ".sqlite", ".s3db", ".sl3"],
                files::is_sqlite_name,
                100,
            )
        },
    )
    .await
}

/// Opens a workspace file (by handle) read-only.
#[tauri::command]
pub async fn utility_sqlite_open(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    workspace_id: String,
    handle: FileHandle,
) -> Result<SqliteHandle, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    let root = hub
        .workspace_root(&workspace_id)
        .map_err(|e| e.log_and_convert("utility_sqlite_open"))?;
    blocking(
        runtime_access,
        utilities,
        "utility_sqlite_open",
        move || {
            // Open-then-verify: the path is proven to be the handle's file inside the workspace.
            let (resolved, _file) = hub.git.handles().open(&root, &handle)?;
            let path = resolved.location.path.clone();
            hub.check_not_kalcode_data(&path)?;
            let opened = hub.sqlite.open(
                &path,
                resolved.rel.as_str().to_owned(),
                Some(workspace_id.clone()),
            )?;
            // Re-check after SQLite opened it: a link swapped in between is refused.
            let (again, _) = hub.git.handles().open(&root, &handle)?;
            if again.location.path != path {
                let _ = hub.sqlite.close(&opened.id);
                return Err(refused(
                    "file_changed",
                    "That file changed while it was being opened. Try again.",
                ));
            }
            Ok(opened)
        },
    )
    .await
}

/// Opens a database chosen in the native file picker (read-only). `None` when cancelled.
#[tauri::command]
pub async fn utility_sqlite_pick(
    window: WebviewWindow,
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
) -> Result<Option<SqliteHandle>, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    let dialog = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Open a SQLite database (read-only)")
        .add_filter(
            "SQLite database",
            &["db", "sqlite", "sqlite3", "db3", "s3db", "sl3"],
        )
        .add_filter("All files", &["*"]);
    blocking(
        runtime_access,
        utilities,
        "utility_sqlite_pick",
        move || {
            let Some(picked) = dialog.blocking_pick_file() else {
                return Ok(None);
            };
            let path = picked.into_path().map_err(|e| {
                KalError::validation("unsupported_file", "KalCode can't open that location.")
                    .with_source(e)
            })?;
            hub.check_not_kalcode_data(&path)?;
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "database".into());
            hub.sqlite.open(&path, name, None).map(Some)
        },
    )
    .await
}

#[tauri::command]
pub async fn utility_sqlite_describe(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    db_id: String,
) -> Result<SqliteHandle, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    blocking(
        runtime_access,
        utilities,
        "utility_sqlite_describe",
        move || hub.sqlite.describe(&db_id),
    )
    .await
}

/// One page of a read-only statement (at most 500 rows, 5 seconds).
#[tauri::command]
pub async fn utility_sqlite_query(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    db_id: String,
    sql: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<SqliteQueryResult, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    blocking(
        runtime_access,
        utilities,
        "utility_sqlite_query",
        move || {
            hub.sqlite.query(
                &db_id,
                &sql,
                cursor.as_deref(),
                limit.unwrap_or(kalcode_utilities::sqlite::DEFAULT_PAGE_ROWS),
            )
        },
    )
    .await
}

/// Seals one fixed-catalog change against the retained database identity and creates an exact
/// one-time approval. Raw SQL stays only in native memory.
#[tauri::command]
pub async fn utility_sqlite_write(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    db_id: String,
    sql: String,
) -> Result<UtilityEffectOutcome, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    let generation = utilities.generation();
    blocking(
        runtime_access,
        utilities,
        "utility_sqlite_write",
        move || {
            let prepared = hub.sqlite.prepare_write(&db_id, &sql)?;
            let operation_id = new_id();
            let workspace_id = prepared.workspace_id().map(str::to_owned);
            let database_id = prepared.database_id().to_owned();
            let database_name = prepared.database_name().to_owned();
            let statement = prepared.operation();
            hub.seal_operation(
                UtilityTool::Sqlite,
                workspace_id.as_deref(),
                operation_id.clone(),
                ActionKind::UtilitySqliteWrite {
                    operation_id,
                    database_id,
                    database_name: database_name.clone(),
                    statement,
                },
                format!("Run a {statement:?} change on {database_name}"),
                generation,
                SealedEffect::Sqlite(prepared),
            )
        },
    )
    .await
}

#[tauri::command(async)]
pub fn utility_sqlite_close(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    db_id: String,
) -> Result<(), IpcError> {
    command_hub(&runtime_access, &utilities)?
        .sqlite
        .close(&db_id)
        .map_err(|e| e.log_and_convert("utility_sqlite_close"))
}

// ---------------------------------------------------------------------------------------------
// Regex Lab, Diff Tool files, scratchpads
// ---------------------------------------------------------------------------------------------

/// Linear-time matching (Rust `regex`): no pattern can hang KalCode.
#[tauri::command]
pub async fn utility_regex(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    pattern: String,
    flags: RegexFlags,
    text: String,
) -> Result<RegexResult, IpcError> {
    command_hub(&runtime_access, &utilities)?;
    blocking(runtime_access, utilities, "utility_regex", move || {
        Ok(regex_lab::run(&pattern, flags, &text))
    })
    .await
}

/// Workspace files whose path contains `query`, as handles (the Diff Tool's file picker).
#[tauri::command]
pub async fn utility_file_find(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    workspace_id: String,
    query: String,
) -> Result<Vec<FileRef>, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    let query = query.trim().to_owned();
    if query.is_empty() || query.len() > 256 {
        return Ok(Vec::new());
    }
    let root = hub
        .workspace_root(&workspace_id)
        .map_err(|e| e.log_and_convert("utility_file_find"))?;
    blocking(runtime_access, utilities, "utility_file_find", move || {
        find_in_index(
            &hub.git,
            &root,
            &[query.as_str()],
            |_| true,
            files::MAX_FIND,
        )
    })
    .await
}

/// Reads a workspace text file by handle (open-then-verify), for the Diff Tool.
#[tauri::command]
pub async fn utility_file_read(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    workspace_id: String,
    handle: FileHandle,
) -> Result<TextFile, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    let root = hub
        .workspace_root(&workspace_id)
        .map_err(|e| e.log_and_convert("utility_file_read"))?;
    blocking(runtime_access, utilities, "utility_file_read", move || {
        let (resolved, file) = hub.git.handles().open(&root, &handle)?;
        files::read_text(
            file,
            FileRef {
                handle,
                workspace_id,
                display_path: resolved.rel.as_str().to_owned(),
            },
        )
    })
    .await
}

#[tauri::command(async)]
pub fn utility_scratchpad_list(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    workspace_id: Option<String>,
) -> Result<ScratchpadList, IpcError> {
    let hub = command_hub(&runtime_access, &utilities)?;
    let items = hub
        .store
        .scratchpads(workspace_id.as_deref())
        .map_err(|e| e.log_and_convert("utility_scratchpad_list"))?;
    Ok(ScratchpadList {
        items,
        persistent: hub.store.persistent(),
    })
}

#[tauri::command(async)]
pub fn utility_scratchpad_save(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    id: Option<String>,
    workspace_id: Option<String>,
    title: String,
    content: String,
) -> Result<Scratchpad, IpcError> {
    command_hub(&runtime_access, &utilities)?
        .store
        .save_scratchpad(id.as_deref(), workspace_id.as_deref(), &title, &content)
        .map_err(|e| e.log_and_convert("utility_scratchpad_save"))
}

#[tauri::command(async)]
pub fn utility_scratchpad_delete(
    runtime_access: RuntimeAccess,
    utilities: RuntimeState<UtilityState>,
    id: String,
) -> Result<(), IpcError> {
    command_hub(&runtime_access, &utilities)?
        .store
        .delete_scratchpad(&id)
        .map_err(|e| e.log_and_convert("utility_scratchpad_delete"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_availability_matches_the_utility_pane() {
        use kalcode_core::flags::{FeatureFlag, SurfaceState};
        assert!(!utility_enabled(None));
        for state in [
            SurfaceState::Gated,
            SurfaceState::Preview,
            SurfaceState::Available,
        ] {
            for visible in [false, true] {
                let flag = FeatureFlag {
                    id: FeatureId::UtilityDock,
                    state,
                    visible,
                };
                assert_eq!(
                    utility_enabled(Some(&flag)),
                    visible && state == SurfaceState::Available
                );
            }
        }
    }

    #[test]
    fn exact_decimal_process_identities_are_bounded_and_validated() {
        assert_eq!(
            parse_process_identity("18446744073709551615").expect("u64 max"),
            u64::MAX
        );
        for invalid in ["", "1.5", "-1", " 1", "18446744073709551616", "1\n"] {
            assert_eq!(
                parse_process_identity(invalid)
                    .expect_err("invalid identity")
                    .code,
                "invalid_process_identity"
            );
        }
    }
}
