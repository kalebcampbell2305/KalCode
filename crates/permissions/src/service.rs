//! `PermissionService`: the engine plus persistence. Implements the shared `PermissionGate`
//! contract for the thread runtime (Z3) and the operations behind the permission IPC commands.
//!
//! Authority model:
//! * Only [`Actor::User`] can answer approval requests or enable Bypass, and Bypass also needs
//!   an explicit confirmation. Agents, KalVoice and automations are refused and audited.
//! * `open_request` never trusts the decision it is handed: it re-evaluates the action and
//!   refuses to open a request the policy would not ask about.
//! * Every consequential change (request, answer, expiry, grant, mode change, refusal) writes an
//!   immutable audit row and its event in the same transaction.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use kalcode_contracts::events::{Correlation, EventPayload, EventSource, NewEvent};
use kalcode_contracts::ids::{is_valid_id, new_id};
use kalcode_contracts::permissions::{
    ActionKind, ActionOrigin, ApprovalDecision, ApprovalRequest, ApprovalStatus, NormalizedAction,
    PermissionGate, PermissionMode, PermissionProfile, PermissionRule, PolicyDecision,
    PolicyEffect, UtilityHttpMethod,
};
use kalcode_contracts::threads::ThreadSummary;
use kalcode_core::logging::redact;
use kalcode_core::{Core, ErrorCategory, KalError, Result};
use serde_json::json;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::classify::{Classification, classify};
use crate::grants::{self, Grant, GrantKind, THREAD_GRANT_TTL_MS, WORKSPACE_GRANT_TTL_MS};
use crate::paths::Workspace;
use crate::policy::{self, PolicyInput, mode_name};
use crate::profiles;
use crate::store::{
    self, ApprovalContext, ApprovalView, AuditEntry, NewApproval, PermissionSettings,
};

/// Who is asking for a permission change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Actor {
    /// A person acting through KalCode's own UI.
    User,
    /// KalCode itself (expiry on thread stop or process exit).
    System,
    /// An AI agent or provider.
    Agent,
    /// The KalVoice assistant. Subject to the same rules as any agent.
    KalVoice,
    /// A scheduled or event-triggered automation.
    Automation,
}

impl Actor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::System => "system",
            Self::Agent => "agent",
            Self::KalVoice => "kalvoice",
            Self::Automation => "automation",
        }
    }
}

/// Resolves a workspace id to its root folder. Implemented by the workspace runtime (Z1).
pub trait WorkspaceRoots: Send + Sync {
    fn root(&self, workspace_id: &str) -> Option<PathBuf>;
}

/// The thread runtime's (Z3) storage of each thread's permission mode.
pub trait ThreadModeStore: Send + Sync {
    /// The thread, or `None` if it does not exist.
    fn thread(&self, thread_id: &str) -> Result<Option<ThreadSummary>>;
    /// Persists a new mode (and, for Custom, the profile) and returns the updated thread.
    fn set_mode(
        &self,
        thread_id: &str,
        mode: PermissionMode,
        profile_id: Option<&str>,
    ) -> Result<ThreadSummary>;
    /// The Custom profile a thread uses, if it has its own.
    fn custom_profile_id(&self, _thread_id: &str) -> Option<String> {
        None
    }
}

/// Before workspaces exist (Z1): no roots, so every path is outside — the fail-closed default.
pub struct NoWorkspaces;

impl WorkspaceRoots for NoWorkspaces {
    fn root(&self, _workspace_id: &str) -> Option<PathBuf> {
        None
    }
}

/// Z1's workspaces: the canonical root stored for the workspace, re-canonicalized on every
/// lookup. A folder that is gone, or now resolves somewhere else (e.g. replaced by a link), has
/// no root, so every path is outside the workspace (fail closed). Reads through [`Core`] only.
pub struct CoreWorkspaceRoots {
    core: Arc<Core>,
}

impl CoreWorkspaceRoots {
    pub fn new(core: Arc<Core>) -> Self {
        Self { core }
    }
}

impl WorkspaceRoots for CoreWorkspaceRoots {
    fn root(&self, workspace_id: &str) -> Option<PathBuf> {
        let workspace = self
            .core
            .workspaces()
            .map_err(|error| {
                tracing::warn!(event = "permissions.workspace_lookup_failed", error = %error.diagnostic());
            })
            .ok()?
            .into_iter()
            .find(|w| w.id == workspace_id)?;
        let stored = PathBuf::from(&workspace.root_path);
        let root = kalcode_core::workspaces::canonical_folder(&stored).ok()?;
        (root == stored).then_some(root)
    }
}

/// Before threads exist (Z3): there are no threads to change.
pub struct NoThreads;

impl ThreadModeStore for NoThreads {
    fn thread(&self, _thread_id: &str) -> Result<Option<ThreadSummary>> {
        Ok(None)
    }

    fn set_mode(
        &self,
        _thread_id: &str,
        _mode: PermissionMode,
        _profile_id: Option<&str>,
    ) -> Result<ThreadSummary> {
        Err(thread_not_found())
    }
}

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    }
}

/// Most approval requests returned by one listing.
pub const MAX_LIST: u32 = 200;

/// A one-time Environment Doctor approval must be used promptly while the reviewed finding,
/// workspace and target are still current.
pub const DOCTOR_APPROVAL_TTL_MS: i64 = 5 * 60 * 1_000;
/// A sealed Utility operation is short-lived and cannot be claimed after this interval.
pub const UTILITY_APPROVAL_TTL_MS: i64 = 5 * 60 * 1_000;
const APPROVAL_CLOCK_SKEW_MS: i64 = 30 * 1_000;

fn forbidden(message: &str) -> KalError {
    KalError::new(ErrorCategory::Permission, "forbidden", message)
}

fn thread_not_found() -> KalError {
    KalError::new(
        ErrorCategory::Validation,
        "thread_not_found",
        "That thread doesn't exist.",
    )
}

fn invalid_id(what: &str) -> KalError {
    KalError::validation("invalid_id", format!("The {what} id is invalid."))
}

/// The result of evaluating an action from a non-thread origin
/// ([`PermissionService::request_for_origin`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginDecision {
    pub decision: PolicyDecision,
    /// The pending approval request when the policy asks; `None` when it allows or denies.
    pub approval: Option<ApprovalView>,
}

/// The audit actor for an origin (the v4 `permission_audit.actor` CHECK values).
fn audit_actor(origin: &ActionOrigin) -> &'static str {
    match origin {
        ActionOrigin::User => Actor::User.as_str(),
        ActionOrigin::System | ActionOrigin::Doctor { .. } | ActionOrigin::Continuity { .. } => {
            Actor::System.as_str()
        }
        ActionOrigin::KalVoice { .. } => Actor::KalVoice.as_str(),
        ActionOrigin::Automation { .. } => Actor::Automation.as_str(),
        ActionOrigin::Thread { .. }
        | ActionOrigin::Agent { .. }
        | ActionOrigin::Delegation { .. }
        | ActionOrigin::Utility { .. }
        | ActionOrigin::Remote { .. } => Actor::Agent.as_str(),
    }
}

fn clean_text(text: &str, max: usize) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(max)
        .collect();
    redact(&cleaned).into_owned()
}

fn timestamp_from_ms(timestamp_ms: i64) -> String {
    let nanos = i128::from(timestamp_ms).saturating_mul(1_000_000);
    OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .map(kalcode_core::time::format_rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_owned())
}

fn timestamp_ms(value: &str) -> Option<i64> {
    let nanos = OffsetDateTime::parse(value, &Rfc3339)
        .ok()?
        .unix_timestamp_nanos();
    i64::try_from(nanos / 1_000_000).ok()
}

fn validate_doctor_action(action: &NormalizedAction) -> Result<()> {
    let (run_id, origin_fix_code) = match &action.origin {
        Some(ActionOrigin::Doctor { run_id, fix_code }) => (run_id, fix_code),
        _ => {
            return Err(KalError::new(
                ErrorCategory::Permission,
                "invalid_doctor_action",
                "That action did not come from the Environment Doctor.",
            ));
        }
    };
    let (fix_code, finding_version) = match &action.action {
        ActionKind::DoctorFix { fix_code, target } => {
            let Some(version) = target.strip_prefix("workspace:.gitignore@") else {
                return Err(KalError::new(
                    ErrorCategory::Permission,
                    "invalid_doctor_action",
                    "That Environment Doctor target is not in the fixed repair catalog.",
                ));
            };
            (fix_code, version)
        }
        _ => {
            return Err(KalError::new(
                ErrorCategory::Permission,
                "invalid_doctor_action",
                "The Environment Doctor can request only a fixed-catalog repair.",
            ));
        }
    };
    if !is_valid_id(&action.id)
        || !is_valid_id(run_id)
        || !is_valid_id(&action.workspace_id)
        || !is_valid_id(finding_version)
        || !action.thread_id.is_empty()
        || !action.provider_id.as_str().is_empty()
        || fix_code != "file.gitignore_env"
        || origin_fix_code != fix_code
    {
        return Err(KalError::new(
            ErrorCategory::Permission,
            "invalid_doctor_action",
            "That Environment Doctor action is not a valid fixed-catalog repair.",
        ));
    }
    Ok(())
}

struct UtilityBinding<'a> {
    operation_id: &'a str,
    workspace_id: Option<&'a str>,
    tool: &'static str,
    effect: &'static str,
}

fn invalid_utility_action(message: &'static str) -> KalError {
    KalError::new(ErrorCategory::Permission, "invalid_utility_action", message)
}

fn safe_review_name(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn validate_utility_action(action: &NormalizedAction) -> Result<UtilityBinding<'_>> {
    let tool = match &action.origin {
        Some(ActionOrigin::Utility { tool }) => tool.as_str(),
        _ => {
            return Err(invalid_utility_action(
                "That action did not come from the Utility Dock.",
            ));
        }
    };
    if !action.thread_id.is_empty()
        || !action.provider_id.as_str().is_empty()
        || (!action.workspace_id.is_empty() && !is_valid_id(&action.workspace_id))
        || action.summary.is_empty()
        || action.summary.len() > 300
        || action.summary.chars().any(char::is_control)
    {
        return Err(invalid_utility_action(
            "That Utility Dock action has invalid runtime or review fields.",
        ));
    }
    let workspace_id = (!action.workspace_id.is_empty()).then_some(action.workspace_id.as_str());
    let binding = match &action.action {
        ActionKind::UtilityDnsResolve { operation_id, host } => {
            if tool != "api_inspector"
                || workspace_id.is_some()
                || crate::network::normalize_host(host).as_deref() != Some(host.as_str())
            {
                return Err(invalid_utility_action(
                    "That Utility DNS action is outside the fixed catalog.",
                ));
            }
            UtilityBinding {
                operation_id,
                workspace_id: None,
                tool: "api_inspector",
                effect: "http",
            }
        }
        ActionKind::UtilityHttp {
            operation_id,
            method,
            origin,
            redirect_hop,
            body_bytes,
            ..
        } => {
            let parsed = url::Url::parse(origin).map_err(|_| {
                invalid_utility_action("That Utility HTTP origin is not canonical.")
            })?;
            let canonical_origin = format!("{}/", parsed.origin().ascii_serialization());
            if tool != "api_inspector"
                || workspace_id.is_some()
                || !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.path() != "/"
                || parsed.query().is_some()
                || parsed.fragment().is_some()
                || origin != &canonical_origin
                || *redirect_hop > 5
                || *body_bytes > 1024 * 1024
                || (matches!(method, UtilityHttpMethod::Get | UtilityHttpMethod::Head)
                    && *body_bytes != 0)
            {
                return Err(invalid_utility_action(
                    "That Utility HTTP action is outside the fixed catalog.",
                ));
            }
            UtilityBinding {
                operation_id,
                workspace_id: None,
                tool: "api_inspector",
                effect: "http",
            }
        }
        ActionKind::UtilityProcessSignal {
            operation_id,
            pid,
            process_start_time,
            process_name,
            ..
        } => {
            if tool != "processes"
                || *pid == 0
                || process_start_time.is_empty()
                || process_start_time.len() > 32
                || !process_start_time.bytes().all(|byte| byte.is_ascii_digit())
                || process_start_time.bytes().all(|byte| byte == b'0')
                || !safe_review_name(process_name, 260)
            {
                return Err(invalid_utility_action(
                    "That Utility process action is outside the fixed catalog.",
                ));
            }
            UtilityBinding {
                operation_id,
                workspace_id,
                tool: "processes",
                effect: "process_signal",
            }
        }
        ActionKind::UtilitySqliteWrite {
            operation_id,
            database_id,
            database_name,
            ..
        } => {
            if tool != "sqlite"
                || !is_valid_id(database_id)
                || !safe_review_name(database_name, 255)
            {
                return Err(invalid_utility_action(
                    "That Utility database action is outside the fixed catalog.",
                ));
            }
            UtilityBinding {
                operation_id,
                workspace_id,
                tool: "sqlite",
                effect: "sqlite_write",
            }
        }
        _ => {
            return Err(invalid_utility_action(
                "The Utility Dock can request only a sealed fixed-catalog action.",
            ));
        }
    };
    if !is_valid_id(binding.operation_id) || action.id != binding.operation_id {
        return Err(invalid_utility_action(
            "That Utility operation id is invalid or changed.",
        ));
    }
    Ok(binding)
}

pub struct PermissionService {
    core: Arc<Core>,
    workspaces: Arc<dyn WorkspaceRoots>,
    threads: Arc<dyn ThreadModeStore>,
    clock: Arc<dyn Clock>,
}

impl PermissionService {
    /// Creates the service and expires requests left pending by a previous process (their
    /// provider sessions are gone, so they can never be answered meaningfully).
    pub fn new(
        core: Arc<Core>,
        workspaces: Arc<dyn WorkspaceRoots>,
        threads: Arc<dyn ThreadModeStore>,
    ) -> Result<Self> {
        Self::with_clock(core, workspaces, threads, Arc::new(SystemClock))
    }

    pub fn with_clock(
        core: Arc<Core>,
        workspaces: Arc<dyn WorkspaceRoots>,
        threads: Arc<dyn ThreadModeStore>,
        clock: Arc<dyn Clock>,
    ) -> Result<Self> {
        let service = Self {
            core,
            workspaces,
            threads,
            clock,
        };
        service.expire(None, None, "process_restarted")?;
        Ok(service)
    }

    pub fn core(&self) -> &Arc<Core> {
        &self.core
    }

    // ---- evaluation ----

    fn workspace(&self, workspace_id: &str) -> Workspace {
        let root = if is_valid_id(workspace_id) {
            self.workspaces.root(workspace_id)
        } else {
            None
        };
        Workspace::new(root.as_deref())
    }

    fn profile_for(&self, thread_id: &str) -> Option<PermissionProfile> {
        let id = self.threads.custom_profile_id(thread_id).or_else(|| {
            self.core
                .read(store::load_settings)
                .ok()
                .and_then(|s| s.default_profile_id)
        })?;
        self.find_profile(&id)
            .ok()
            .flatten()
            .filter(|p| p.mode == PermissionMode::Custom)
    }

    fn find_profile(&self, id: &str) -> Result<Option<PermissionProfile>> {
        if let Some(profile) = profiles::builtin(id) {
            return Ok(Some(profile));
        }
        Ok(self
            .core
            .read(store::stored_profiles)?
            .into_iter()
            .find(|p| p.id == id))
    }

    /// Classifies and evaluates `action` under `mode`, returning the facts behind the decision.
    pub fn evaluate_detailed(
        &self,
        action: &NormalizedAction,
        mode: PermissionMode,
    ) -> (Classification, PolicyDecision) {
        let workspace = self.workspace(&action.workspace_id);
        let c = classify(&action.action, &workspace);
        let now_ms = self.clock.now_ms();
        let grants: Vec<Grant> = self
            .core
            .read(|conn| store::active_grants(conn, &action.thread_id, &action.workspace_id, now_ms))
            .unwrap_or_else(|error| {
                // Without grants the decision can only be stricter.
                tracing::warn!(event = "permissions.grants_unavailable", error = %error.diagnostic());
                Vec::new()
            });
        let user_rules: Vec<PermissionRule> =
            grants.iter().flat_map(|g| g.as_rules(now_ms)).collect();
        let profile = (mode == PermissionMode::Custom)
            .then(|| self.profile_for(&action.thread_id))
            .flatten();
        let decision = policy::evaluate(
            &c,
            &PolicyInput {
                action,
                mode,
                profile: profile.as_ref(),
                user_rules: &user_rules,
                grants: &grants,
                now_ms,
            },
        );
        (c, decision)
    }

    /// Evaluates under the mode the caller passed **and** the mode stored for the thread (when
    /// they differ) and returns the stricter result, so a stale or forged mode can't widen
    /// authority.
    fn evaluate_checked(
        &self,
        action: &NormalizedAction,
        mode: PermissionMode,
    ) -> (Classification, PolicyDecision, PermissionMode) {
        let (c, decision) = self.evaluate_detailed(action, mode);
        let stored = self
            .threads
            .thread(&action.thread_id)
            .ok()
            .flatten()
            .map(|t| t.permission_mode);
        match stored {
            Some(stored_mode) if stored_mode != mode => {
                let (c2, other) = self.evaluate_detailed(action, stored_mode);
                if severity(&other) > severity(&decision) {
                    (c2, other, stored_mode)
                } else {
                    (c, decision, mode)
                }
            }
            _ => (c, decision, mode),
        }
    }

    // ---- requests ----

    fn context_for(&self, action: &NormalizedAction) -> ApprovalContext {
        let thread = self.threads.thread(&action.thread_id).ok().flatten();
        ApprovalContext {
            thread_name: thread.as_ref().map(|t| clean_text(&t.name, 120)),
            workspace_name: thread.as_ref().map(|t| clean_text(&t.workspace_name, 120)),
            provider_name: thread
                .as_ref()
                .map(|t| clean_text(&t.provider_name, 80))
                .or_else(|| provider_display_name(action.provider_id.as_str()).map(str::to_owned)),
        }
    }

    fn validate_action(action: &NormalizedAction) -> Result<()> {
        if !is_valid_id(&action.thread_id) {
            return Err(invalid_id("thread"));
        }
        if !is_valid_id(&action.workspace_id) {
            return Err(invalid_id("workspace"));
        }
        if action.id.is_empty() || action.id.len() > 256 || action.id.chars().any(char::is_control)
        {
            return Err(invalid_id("action"));
        }
        Ok(())
    }

    /// Evaluates an action from a **non-thread origin** and, when the policy asks, files an
    /// approval request with `origin_kind` = that origin (thread, workspace and provider may be
    /// absent, as schema v4 allows). The supported origins are KalVoice and the Environment
    /// Doctor's fixed repair catalog. Every other non-thread origin remains denied until its own
    /// authority contract lands.
    ///
    /// Rules: the action is always evaluated under **Approve** (a non-thread origin never selects
    /// or changes a mode); standing grants and "Allow via rule" rules never apply to it, and its
    /// requests can only be approved once or denied. Only the user answers (`decide` refuses
    /// every other actor, KalVoice included).
    pub fn request_for_origin(&self, action: NormalizedAction) -> Result<OriginDecision> {
        let origin = match &action.origin {
            Some(origin @ ActionOrigin::KalVoice { request_id }) => {
                if !is_valid_id(request_id) {
                    return Err(invalid_id("request"));
                }
                origin.clone()
            }
            Some(origin @ ActionOrigin::Doctor { .. }) => {
                validate_doctor_action(&action)?;
                origin.clone()
            }
            Some(origin @ ActionOrigin::Utility { .. }) => {
                validate_utility_action(&action)?;
                origin.clone()
            }
            Some(ActionOrigin::Thread { .. }) | None => {
                return Err(KalError::validation(
                    "origin_is_a_thread",
                    "Thread actions go through the thread's permission gate.",
                ));
            }
            Some(other) => {
                tracing::warn!(
                    event = "permissions.origin_not_supported",
                    origin = other.kind()
                );
                return Err(KalError::new(
                    ErrorCategory::Permission,
                    "origin_not_supported",
                    "KalCode can't evaluate actions from this source yet.",
                ));
            }
        };
        for (id, what) in [
            (&action.thread_id, "thread"),
            (&action.workspace_id, "workspace"),
        ] {
            if !id.is_empty() && !is_valid_id(id) {
                return Err(invalid_id(what));
            }
        }
        if action.id.is_empty() || action.id.len() > 256 || action.id.chars().any(char::is_control)
        {
            return Err(invalid_id("action"));
        }
        let mode = PermissionMode::Approve;
        let workspace = self.workspace(&action.workspace_id);
        let c = classify(&action.action, &workspace);
        let decision = policy::evaluate(
            &c,
            &PolicyInput {
                action: &action,
                mode,
                profile: None,
                user_rules: &[],
                grants: &[],
                now_ms: self.clock.now_ms(),
            },
        );
        if decision.effect != PolicyEffect::Ask {
            return Ok(OriginDecision {
                decision,
                approval: None,
            });
        }
        let allowed: Vec<ApprovalDecision> = grants::allowed_decisions(&decision, &c)
            .into_iter()
            .filter(|d| matches!(d, ApprovalDecision::Deny | ApprovalDecision::ApproveOnce))
            .collect();
        let context = ApprovalContext {
            thread_name: None,
            workspace_name: None,
            provider_name: provider_display_name(action.provider_id.as_str()).map(str::to_owned),
        };
        let id = new_id();
        let summary = clean_text(&action.summary, 300);
        let actor = audit_actor(&origin);
        let created_at = timestamp_from_ms(self.clock.now_ms());
        let (view, _) = self.core.transact(|tx| {
            store::insert_approval(
                tx,
                &NewApproval {
                    id: &id,
                    action: &action,
                    decision: &decision,
                    mode,
                    allowed: &allowed,
                    context: Some(&context),
                    fingerprint: &c.fingerprint,
                    grant_matcher: None,
                    grant_coverage: "only this request",
                    created_at: &created_at,
                },
            )?;
            let workspace_id =
                (!action.workspace_id.is_empty()).then_some(action.workspace_id.as_str());
            store::audit(
                tx,
                &AuditEntry {
                    kind: "approval.requested",
                    actor,
                    thread_id: None,
                    workspace_id,
                    request_id: Some(&id),
                    detail: json!({
                        "mode": mode,
                        "scopes": decision.scopes,
                        "summary": summary,
                        "opaque": c.opaque,
                        "origin": origin.kind(),
                        "originId": origin.id(),
                    }),
                },
            )?;
            let event = NewEvent {
                source: if matches!(origin, ActionOrigin::KalVoice { .. }) {
                    EventSource::KalVoice
                } else {
                    EventSource::Core
                },
                correlation: correlation(
                    &action.workspace_id,
                    &action.thread_id,
                    action.provider_id.as_str(),
                    &id,
                ),
                event: EventPayload::ApprovalRequested {
                    request_id: id.clone(),
                    thread_id: action.thread_id.clone(),
                    scopes: decision.scopes.clone(),
                    summary: summary.clone(),
                },
            };
            let view = store::get_approval(tx, &id)?
                .ok_or_else(|| KalError::internal("approval_missing", "The request wasn't saved."))?
                .view;
            Ok((view, vec![event]))
        })?;
        Ok(OriginDecision {
            decision,
            approval: Some(view),
        })
    }

    /// Loads one Environment Doctor approval by its exact id and proves that it still belongs to
    /// the immutable action the Doctor prepared. This is intentionally not a general provider or
    /// agent approval API. Replay is claimed atomically by the Doctor fix journal at the effect
    /// boundary; this check binds the authority row, action fingerprint and short lifetime.
    pub fn verify_doctor_approval(
        &self,
        approval_id: &str,
        expected: &NormalizedAction,
    ) -> Result<ApprovalView> {
        if !is_valid_id(approval_id) {
            return Err(invalid_id("approval"));
        }
        validate_doctor_action(expected)?;
        let stored = self
            .core
            .read(|connection| store::get_approval(connection, approval_id))?
            .ok_or_else(|| {
                KalError::new(
                    ErrorCategory::Validation,
                    "approval_not_found",
                    "That approval request isn't available.",
                )
            })?;
        if stored.view.action != *expected {
            return Err(KalError::new(
                ErrorCategory::Permission,
                "approval_object_changed",
                "That approval belongs to a different Environment Doctor action.",
            ));
        }
        let workspace = self.workspace(&expected.workspace_id);
        if stored.fingerprint != classify(&expected.action, &workspace).fingerprint {
            return Err(KalError::new(
                ErrorCategory::Permission,
                "approval_object_changed",
                "That approval no longer matches the reviewed Environment Doctor action.",
            ));
        }
        let created_at_ms = timestamp_ms(&stored.view.created_at).ok_or_else(|| {
            KalError::new(
                ErrorCategory::Permission,
                "approval_expired",
                "That Environment Doctor approval has expired.",
            )
        })?;
        let age_ms = self.clock.now_ms().saturating_sub(created_at_ms);
        if !(-APPROVAL_CLOCK_SKEW_MS..=DOCTOR_APPROVAL_TTL_MS).contains(&age_ms) {
            return Err(KalError::new(
                ErrorCategory::Permission,
                "approval_expired",
                "That Environment Doctor approval has expired.",
            ));
        }
        if stored.view.status == ApprovalStatus::Expired {
            return Err(KalError::new(
                ErrorCategory::Permission,
                "approval_expired",
                "That Environment Doctor approval has expired.",
            ));
        }
        if stored.view.status == ApprovalStatus::Approved
            && stored.view.resolved_decision != Some(ApprovalDecision::ApproveOnce)
        {
            return Err(KalError::new(
                ErrorCategory::Permission,
                "approval_not_one_time",
                "That approval did not authorize this one Environment Doctor action.",
            ));
        }
        Ok(stored.view)
    }

    /// Atomically consumes one exact, approved Utility request before its sealed effect starts.
    /// A retained claim is a tombstone: failures after this method returns never restore replay.
    pub fn claim_utility_approval(
        &self,
        approval_id: &str,
        expected: &NormalizedAction,
        runtime_generation: u64,
    ) -> Result<ApprovalView> {
        if !is_valid_id(approval_id) {
            return Err(invalid_id("approval"));
        }
        let binding = validate_utility_action(expected)?;
        let runtime_generation = i64::try_from(runtime_generation)
            .map_err(|_| invalid_utility_action("That Utility runtime generation is invalid."))?;
        let now_ms = self.clock.now_ms();
        let claimed_at = timestamp_from_ms(now_ms);
        let workspace = self.workspace(&expected.workspace_id);
        let fingerprint = classify(&expected.action, &workspace).fingerprint;
        self.core
            .transact(|tx| {
                let stored = store::get_approval(tx, approval_id)?.ok_or_else(|| {
                    KalError::new(
                        ErrorCategory::Validation,
                        "approval_not_found",
                        "That approval request isn't available.",
                    )
                })?;
                if stored.view.action != *expected || stored.fingerprint != fingerprint {
                    return Err(KalError::new(
                        ErrorCategory::Permission,
                        "approval_object_changed",
                        "That approval belongs to a different Utility Dock action.",
                    ));
                }
                let created_at_ms = timestamp_ms(&stored.view.created_at).ok_or_else(|| {
                    KalError::new(
                        ErrorCategory::Permission,
                        "approval_expired",
                        "That Utility Dock approval has expired.",
                    )
                })?;
                let age_ms = now_ms.saturating_sub(created_at_ms);
                if !(-APPROVAL_CLOCK_SKEW_MS..=UTILITY_APPROVAL_TTL_MS).contains(&age_ms)
                    || stored.view.status == ApprovalStatus::Expired
                {
                    return Err(KalError::new(
                        ErrorCategory::Permission,
                        "approval_expired",
                        "That Utility Dock approval has expired.",
                    ));
                }
                match (stored.view.status, stored.view.resolved_decision) {
                    (ApprovalStatus::Approved, Some(ApprovalDecision::ApproveOnce)) => {}
                    (ApprovalStatus::Pending, _) => {
                        return Err(KalError::new(
                            ErrorCategory::Permission,
                            "approval_pending",
                            "That Utility Dock action has not been approved yet.",
                        ));
                    }
                    (ApprovalStatus::Denied, _) => {
                        return Err(KalError::new(
                            ErrorCategory::Permission,
                            "approval_denied",
                            "That Utility Dock action was denied.",
                        ));
                    }
                    _ => {
                        return Err(KalError::new(
                            ErrorCategory::Permission,
                            "approval_not_one_time",
                            "That approval did not authorize this one Utility Dock action.",
                        ));
                    }
                }
                store::insert_utility_claim(
                    tx,
                    &store::UtilityApprovalClaim {
                        approval_id,
                        operation_id: binding.operation_id,
                        runtime_generation,
                        workspace_id: binding.workspace_id,
                        tool: binding.tool,
                        effect: binding.effect,
                        claimed_at: &claimed_at,
                    },
                )?;
                Ok((stored.view, Vec::new()))
            })
            .map(|(view, _)| view)
    }

    fn open(
        &self,
        action: NormalizedAction,
        mode: PermissionMode,
        offered: &PolicyDecision,
    ) -> Result<ApprovalView> {
        Self::validate_action(&action)?;
        let (c, decision, mode) = self.evaluate_checked(&action, mode);
        if decision.effect != PolicyEffect::Ask {
            tracing::warn!(
                event = "permissions.request_refused",
                offered = ?offered.effect,
                actual = ?decision.effect,
                thread_id = %action.thread_id
            );
            return Err(KalError::new(
                ErrorCategory::Permission,
                "not_askable",
                "KalCode's policy doesn't allow asking for this action.",
            ));
        }
        let allowed = grants::allowed_decisions(&decision, &c);
        let matcher = grants::rule_matcher(&c);
        let context = self.context_for(&action);
        let id = new_id();
        let summary = clean_text(&action.summary, 300);
        let created_at = timestamp_from_ms(self.clock.now_ms());
        let (view, _) = self.core.transact(|tx| {
            let mut events = Vec::new();
            for expired in
                store::expire_pending(tx, Some(&action.thread_id), Some(&action.id), "superseded")?
            {
                events.push(self.expired_event(tx, &expired, "superseded")?);
            }
            store::insert_approval(
                tx,
                &NewApproval {
                    id: &id,
                    action: &action,
                    decision: &decision,
                    mode,
                    allowed: &allowed,
                    context: Some(&context),
                    fingerprint: &c.fingerprint,
                    grant_matcher: matcher.as_deref(),
                    grant_coverage: &c.grant_coverage,
                    created_at: &created_at,
                },
            )?;
            store::audit(
                tx,
                &AuditEntry {
                    kind: "approval.requested",
                    actor: Actor::Agent.as_str(),
                    thread_id: Some(&action.thread_id),
                    workspace_id: Some(&action.workspace_id),
                    request_id: Some(&id),
                    detail: json!({
                        "mode": mode,
                        "scopes": decision.scopes,
                        "summary": summary,
                        "opaque": c.opaque,
                        "providerId": action.provider_id.as_str(),
                    }),
                },
            )?;
            events.push(NewEvent {
                source: EventSource::Core,
                correlation: correlation(
                    &action.workspace_id,
                    &action.thread_id,
                    action.provider_id.as_str(),
                    &id,
                ),
                event: EventPayload::ApprovalRequested {
                    request_id: id.clone(),
                    thread_id: action.thread_id.clone(),
                    scopes: decision.scopes.clone(),
                    summary: summary.clone(),
                },
            });
            let view = store::get_approval(tx, &id)?
                .ok_or_else(|| KalError::internal("approval_missing", "The request wasn't saved."))?
                .view;
            Ok((view, events))
        })?;
        Ok(view)
    }

    fn expired_event(
        &self,
        tx: &rusqlite::Transaction<'_>,
        expired: &store::Expired,
        reason: &str,
    ) -> Result<NewEvent> {
        store::audit(
            tx,
            &AuditEntry {
                kind: "approval.expired",
                actor: Actor::System.as_str(),
                thread_id: Some(&expired.thread_id),
                workspace_id: Some(&expired.workspace_id),
                request_id: Some(&expired.id),
                detail: json!({ "reason": reason }),
            },
        )?;
        Ok(NewEvent {
            source: EventSource::Core,
            correlation: correlation(
                &expired.workspace_id,
                &expired.thread_id,
                &expired.provider_id,
                &expired.id,
            ),
            event: EventPayload::ApprovalExpired {
                request_id: expired.id.clone(),
                thread_id: expired.thread_id.clone(),
            },
        })
    }

    /// Expires pending requests (all, or one thread's) and, for a thread, revokes its thread
    /// grants. Returns how many requests expired.
    fn expire(
        &self,
        thread_id: Option<&str>,
        action_id: Option<&str>,
        reason: &str,
    ) -> Result<usize> {
        let (count, _) = self.core.transact(|tx| {
            let mut events = Vec::new();
            let expired = store::expire_pending(tx, thread_id, action_id, reason)?;
            for item in &expired {
                events.push(self.expired_event(tx, item, reason)?);
            }
            if let Some(thread_id) = thread_id {
                for grant_id in store::revoke_thread_grants(tx, thread_id, reason)? {
                    store::audit(
                        tx,
                        &AuditEntry {
                            kind: "grant.revoked",
                            actor: Actor::System.as_str(),
                            thread_id: Some(thread_id),
                            workspace_id: None,
                            request_id: None,
                            detail: json!({ "grantId": grant_id, "reason": reason }),
                        },
                    )?;
                }
            }
            Ok((expired.len(), events))
        })?;
        Ok(count)
    }

    /// Interactive panes (Z7-W4): nobody answered a request within the hook's ask window, so the
    /// tool call went to the provider's own prompt in the pane, where the person answers it. The
    /// request for that action expires with reason `answered_in_provider`. Thread grants are
    /// untouched (unlike `expire_for_thread`). Returns how many requests expired (0 or 1).
    pub fn expire_answered_in_provider(&self, thread_id: &str, action_id: &str) -> Result<usize> {
        if !is_valid_id(thread_id) {
            return Err(invalid_id("thread"));
        }
        if action_id.is_empty() || action_id.len() > 128 {
            return Err(invalid_id("action"));
        }
        const REASON: &str = "answered_in_provider";
        let (count, _) = self.core.transact(|tx| {
            let expired = store::expire_pending(tx, Some(thread_id), Some(action_id), REASON)?;
            let mut events = Vec::with_capacity(expired.len());
            for item in &expired {
                events.push(self.expired_event(tx, item, REASON)?);
            }
            Ok((expired.len(), events))
        })?;
        Ok(count)
    }

    /// Pending (or all recent) requests, newest first.
    pub fn list_approvals(&self, status: Option<ApprovalStatus>) -> Result<Vec<ApprovalView>> {
        self.core
            .read(|conn| store::list_approvals(conn, status, MAX_LIST))
    }

    /// Records the user's answer to a pending request and creates any standing grant.
    pub fn decide(
        &self,
        request_id: &str,
        decision: ApprovalDecision,
        actor: Actor,
    ) -> Result<ApprovalView> {
        if actor != Actor::User {
            self.audit_refusal(
                "approval.denied",
                actor,
                None,
                Some(request_id),
                "only the user can answer approval requests",
            )?;
            return Err(forbidden("Only you can answer approval requests."));
        }
        if !is_valid_id(request_id) {
            return Err(invalid_id("request"));
        }
        let now_ms = self.clock.now_ms();
        let (view, _) = self.core.transact(|tx| {
            let stored = store::get_approval(tx, request_id)?.ok_or_else(|| {
                KalError::new(ErrorCategory::Validation, "approval_not_found", "That approval request doesn't exist.")
            })?;
            let request = &stored.view;
            match request.status {
                ApprovalStatus::Pending => {}
                ApprovalStatus::Expired => {
                    return Err(KalError::new(
                        ErrorCategory::Permission,
                        "approval_expired",
                        "This request expired because its thread stopped or a newer request replaced it. It can't be approved.",
                    ));
                }
                _ => {
                    return Err(KalError::new(
                        ErrorCategory::Permission,
                        "approval_already_decided",
                        "This request was already answered.",
                    ));
                }
            }
            if !stored.view.allowed_decisions.contains(&decision) {
                return Err(KalError::new(
                    ErrorCategory::Permission,
                    "decision_not_allowed",
                    if request.decision.approvable {
                        "That choice isn't available for this request. You can approve it once or deny it."
                    } else {
                        "This request can only be denied."
                    },
                ));
            }
            let status = if decision == ApprovalDecision::Deny {
                ApprovalStatus::Denied
            } else {
                ApprovalStatus::Approved
            };
            if !store::resolve_approval(tx, request_id, status, decision)? {
                return Err(KalError::new(
                    ErrorCategory::Permission,
                    "approval_already_decided",
                    "This request was already answered.",
                ));
            }
            let action = &request.action;
            let kind = match decision {
                ApprovalDecision::ApproveForThread => Some(GrantKind::Thread),
                ApprovalDecision::ApproveForWorkspace => Some(GrantKind::Workspace),
                ApprovalDecision::AllowViaRule => Some(GrantKind::Rule),
                _ => None,
            };
            if let Some(kind) = kind {
                let grant = Grant {
                    id: new_id(),
                    kind,
                    thread_id: (kind == GrantKind::Thread).then(|| action.thread_id.clone()),
                    workspace_id: (kind != GrantKind::Rule).then(|| action.workspace_id.clone()),
                    scopes: request.decision.scopes.clone(),
                    fingerprint: stored.fingerprint.clone(),
                    matcher: (kind == GrantKind::Rule).then(|| stored.grant_matcher.clone()).flatten(),
                    expires_at_ms: match kind {
                        GrantKind::Thread => Some(now_ms.saturating_add(THREAD_GRANT_TTL_MS)),
                        GrantKind::Workspace => Some(now_ms.saturating_add(WORKSPACE_GRANT_TTL_MS)),
                        GrantKind::Rule => None,
                    },
                };
                if kind == GrantKind::Rule && grant.matcher.is_none() {
                    return Err(KalError::new(
                        ErrorCategory::Permission,
                        "decision_not_allowed",
                        "KalCode can't make a rule for this request.",
                    ));
                }
                store::insert_grant(tx, &grant, request_id)?;
                store::audit(
                    tx,
                    &AuditEntry {
                        kind: "grant.created",
                        actor: actor.as_str(),
                        thread_id: grant.thread_id.as_deref(),
                        workspace_id: grant.workspace_id.as_deref(),
                        request_id: Some(request_id),
                        detail: json!({
                            "grantId": grant.id,
                            "kind": kind.as_str(),
                            "scopes": grant.scopes,
                            "matcher": grant.matcher,
                            "expiresAtMs": grant.expires_at_ms,
                        }),
                    },
                )?;
            }
            store::audit(
                tx,
                &AuditEntry {
                    kind: if status == ApprovalStatus::Denied { "approval.denied" } else { "approval.approved" },
                    actor: actor.as_str(),
                    thread_id: Some(&action.thread_id),
                    workspace_id: Some(&action.workspace_id),
                    request_id: Some(request_id),
                    detail: json!({
                        "decision": decision,
                        "scopes": request.decision.scopes,
                        "mode": request.permission_mode,
                        "summary": clean_text(&action.summary, 300),
                    }),
                },
            )?;
            let event = if status == ApprovalStatus::Denied {
                EventPayload::ApprovalDenied { request_id: request_id.to_owned(), thread_id: action.thread_id.clone() }
            } else {
                EventPayload::ApprovalApproved {
                    request_id: request_id.to_owned(),
                    thread_id: action.thread_id.clone(),
                    decision,
                }
            };
            let events = vec![NewEvent {
                source: EventSource::Ui,
                correlation: correlation(&action.workspace_id, &action.thread_id, action.provider_id.as_str(), request_id),
                event,
            }];
            let view = store::get_approval(tx, request_id)?
                .ok_or_else(|| KalError::internal("approval_missing", "The request disappeared."))?
                .view;
            Ok((view, events))
        })?;
        Ok(view)
    }

    fn audit_refusal(
        &self,
        kind: &str,
        actor: Actor,
        thread_id: Option<&str>,
        request_id: Option<&str>,
        why: &str,
    ) -> Result<()> {
        let request_id = request_id.filter(|id| is_valid_id(id));
        let thread_id = thread_id.filter(|id| is_valid_id(id));
        self.core.transact(|tx| {
            store::audit(
                tx,
                &AuditEntry {
                    kind,
                    actor: actor.as_str(),
                    thread_id,
                    workspace_id: None,
                    request_id,
                    detail: json!({ "refused": why }),
                },
            )?;
            Ok(((), Vec::new()))
        })?;
        Ok(())
    }

    // ---- modes and settings ----

    fn check_mode_change(
        &self,
        mode: PermissionMode,
        confirm_bypass: bool,
        actor: Actor,
        thread_id: Option<&str>,
    ) -> Result<()> {
        if mode == PermissionMode::Bypass {
            if actor != Actor::User {
                self.audit_refusal(
                    "permission.bypass_refused",
                    actor,
                    thread_id,
                    None,
                    "only the user can enable Bypass",
                )?;
                return Err(forbidden(
                    "Only you can turn on Bypass. Agents and KalVoice can't.",
                ));
            }
            if !confirm_bypass {
                self.audit_refusal(
                    "permission.bypass_refused",
                    actor,
                    thread_id,
                    None,
                    "missing confirmation",
                )?;
                return Err(KalError::new(
                    ErrorCategory::Permission,
                    "bypass_confirmation_required",
                    "Bypass needs your explicit confirmation.",
                ));
            }
        } else if actor != Actor::User {
            // Only the user changes permission modes; agents may not loosen or tighten them.
            self.audit_refusal(
                "permission.mode_changed",
                actor,
                thread_id,
                None,
                "only the user can change permission modes",
            )?;
            return Err(forbidden("Only you can change a thread's permission mode."));
        }
        Ok(())
    }

    fn check_profile(
        &self,
        mode: PermissionMode,
        profile_id: Option<&str>,
    ) -> Result<Option<String>> {
        match (mode, profile_id) {
            (PermissionMode::Custom, Some(id)) => {
                if !profiles::is_valid_profile_id(id) {
                    return Err(invalid_id("profile"));
                }
                match self.find_profile(id)? {
                    Some(p) if p.mode == PermissionMode::Custom => Ok(Some(p.id)),
                    _ => Err(KalError::validation(
                        "profile_not_found",
                        "That Custom profile doesn't exist.",
                    )),
                }
            }
            (PermissionMode::Custom, None) => Err(KalError::validation(
                "profile_required",
                "Choose a Custom profile for this mode.",
            )),
            (_, _) => Ok(None),
        }
    }

    /// Changes a thread's permission mode (user action only; Bypass needs `confirm_bypass`).
    /// Pending requests of the thread expire, since they were asked under the old mode.
    pub fn set_thread_mode(
        &self,
        thread_id: &str,
        mode: PermissionMode,
        confirm_bypass: bool,
        profile_id: Option<&str>,
        actor: Actor,
    ) -> Result<ThreadSummary> {
        if !is_valid_id(thread_id) {
            return Err(invalid_id("thread"));
        }
        self.check_mode_change(mode, confirm_bypass, actor, Some(thread_id))?;
        let profile_id = self.check_profile(mode, profile_id)?;
        let current = self
            .threads
            .thread(thread_id)?
            .ok_or_else(thread_not_found)?;
        let from = current.permission_mode;
        let unchanged_profile =
            profile_id.is_none() || self.threads.custom_profile_id(thread_id) == profile_id;
        if from == mode && unchanged_profile {
            return Ok(current);
        }
        let updated = self
            .threads
            .set_mode(thread_id, mode, profile_id.as_deref())?;
        let recorded = self.core.transact(|tx| {
            let mut events = Vec::new();
            for expired in store::expire_pending(tx, Some(thread_id), None, "mode_changed")? {
                events.push(self.expired_event(tx, &expired, "mode_changed")?);
            }
            store::audit(
                tx,
                &AuditEntry {
                    kind: "permission.mode_changed",
                    actor: actor.as_str(),
                    thread_id: Some(thread_id),
                    workspace_id: Some(&current.workspace_id),
                    request_id: None,
                    detail: json!({ "from": from, "to": mode, "profileId": profile_id }),
                },
            )?;
            if mode == PermissionMode::Bypass {
                store::audit(
                    tx,
                    &AuditEntry {
                        kind: "permission.bypass_enabled",
                        actor: actor.as_str(),
                        thread_id: Some(thread_id),
                        workspace_id: Some(&current.workspace_id),
                        request_id: None,
                        detail: json!({ "confirmed": true, "from": from }),
                    },
                )?;
            }
            events.push(NewEvent {
                source: EventSource::Ui,
                correlation: Correlation {
                    workspace_id: Some(current.workspace_id.clone()),
                    thread_id: Some(thread_id.to_owned()),
                    provider_id: Some(current.provider_id.as_str().to_owned()),
                    ..Correlation::default()
                },
                event: EventPayload::PermissionModeChanged {
                    thread_id: Some(thread_id.to_owned()),
                    from,
                    to: mode,
                },
            });
            Ok(((), events))
        });
        if let Err(error) = recorded {
            // Never leave a mode change without its audit trail.
            let previous = self.threads.custom_profile_id(thread_id);
            if let Err(revert) = self.threads.set_mode(thread_id, from, previous.as_deref()) {
                tracing::error!(event = "permissions.mode_revert_failed", error = %revert.diagnostic());
            }
            return Err(error);
        }
        Ok(updated)
    }

    pub fn settings(&self) -> Result<PermissionSettings> {
        self.core.read(store::load_settings)
    }

    /// Changes the default mode for new threads (user action only; Bypass needs confirmation).
    pub fn update_settings(
        &self,
        default_mode: PermissionMode,
        profile_id: Option<&str>,
        confirm_bypass: bool,
        actor: Actor,
    ) -> Result<PermissionSettings> {
        self.check_mode_change(default_mode, confirm_bypass, actor, None)?;
        let profile_id = self.check_profile(default_mode, profile_id)?;
        let (settings, _) = self.core.transact(|tx| {
            let previous = store::load_settings(tx)?;
            let next = PermissionSettings { default_mode, default_profile_id: profile_id.clone() };
            if previous == next {
                return Ok((next, Vec::new()));
            }
            store::save_settings(tx, &next)?;
            store::audit(
                tx,
                &AuditEntry {
                    kind: "permission.default_mode_changed",
                    actor: actor.as_str(),
                    thread_id: None,
                    workspace_id: None,
                    request_id: None,
                    detail: json!({ "from": previous.default_mode, "to": default_mode, "profileId": profile_id }),
                },
            )?;
            if default_mode == PermissionMode::Bypass && previous.default_mode != PermissionMode::Bypass {
                store::audit(
                    tx,
                    &AuditEntry {
                        kind: "permission.bypass_enabled",
                        actor: actor.as_str(),
                        thread_id: None,
                        workspace_id: None,
                        request_id: None,
                        detail: json!({ "confirmed": true, "scope": "default_for_new_threads" }),
                    },
                )?;
            }
            let events = if previous.default_mode == default_mode {
                Vec::new()
            } else {
                vec![NewEvent {
                    source: EventSource::Ui,
                    correlation: Correlation::default(),
                    event: EventPayload::PermissionModeChanged { thread_id: None, from: previous.default_mode, to: default_mode },
                }]
            };
            Ok((next, events))
        })?;
        Ok(settings)
    }

    /// Built-in profiles followed by the user's saved Custom profiles.
    pub fn profiles(&self) -> Result<Vec<PermissionProfile>> {
        let mut all = profiles::builtin_profiles();
        all.extend(self.core.read(store::stored_profiles)?);
        Ok(all)
    }

    pub fn audit_log(&self) -> Result<Vec<store::AuditRow>> {
        self.core.read(store::audit_rows)
    }

    pub fn mode_label(mode: PermissionMode) -> &'static str {
        mode_name(mode)
    }
}

fn severity(decision: &PolicyDecision) -> u8 {
    match decision.effect {
        PolicyEffect::Allow => 0,
        PolicyEffect::Ask => 1,
        PolicyEffect::Deny => 2,
    }
}

fn correlation(
    workspace_id: &str,
    thread_id: &str,
    provider_id: &str,
    request_id: &str,
) -> Correlation {
    // Non-thread origins (KalVoice) may have no thread, workspace or provider.
    let present = |value: &str| (!value.is_empty()).then(|| value.to_owned());
    Correlation {
        workspace_id: present(workspace_id),
        thread_id: present(thread_id),
        mission_id: None,
        provider_id: present(provider_id),
        request_id: present(request_id),
        ..Correlation::default()
    }
}

fn provider_display_name(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "claude-code" => Some("Claude Code"),
        "codex" => Some("Codex"),
        "gemini-cli" => Some("Gemini CLI"),
        _ => None,
    }
}

impl PermissionGate for PermissionService {
    fn evaluate(&self, action: &NormalizedAction, mode: PermissionMode) -> PolicyDecision {
        if Self::validate_action(action).is_err() {
            return PolicyDecision {
                effect: PolicyEffect::Deny,
                scopes: Vec::new(),
                reason: "The action came with invalid identifiers, so KalCode refused it.".into(),
                approvable: false,
            };
        }
        self.evaluate_checked(action, mode).1
    }

    fn open_request(
        &self,
        action: NormalizedAction,
        mode: PermissionMode,
        decision: PolicyDecision,
    ) -> std::result::Result<ApprovalRequest, String> {
        self.open(action, mode, &decision).map_err(|error| {
            tracing::warn!(event = "permissions.open_request_failed", error = %error.diagnostic());
            error.message
        })
    }

    fn expire_for_thread(&self, thread_id: &str) {
        if !is_valid_id(thread_id) {
            return;
        }
        if let Err(error) = self.expire(Some(thread_id), None, "thread_stopped") {
            tracing::error!(event = "permissions.expire_failed", error = %error.diagnostic());
        }
    }
}

impl PermissionService {
    /// As [`PermissionGate::open_request`], returning the full view (tests and the IPC layer).
    pub fn open_request_view(
        &self,
        action: NormalizedAction,
        mode: PermissionMode,
        decision: &PolicyDecision,
    ) -> Result<ApprovalView> {
        self.open(action, mode, decision)
    }
}
