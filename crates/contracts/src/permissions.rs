//! Permission contract (enforced from Z4). See docs/PERMISSIONS.md. KalVoice, agents,
//! automations and plugins are all subject to these rules. Every permission mode is available on
//! every plan.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::ProviderId;
use crate::kalvoice::ThreadScope;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PermissionMode {
    Plan,
    Approve,
    Auto,
    Bypass,
    Custom,
}

/// Default for an implicit local coding session: Bypass, so coding agents and threads run
/// without approvals (owner directive 2026-10-03, "take away all approvals").
pub const DEFAULT_CODING_PERMISSION_MODE: PermissionMode = PermissionMode::Bypass;

impl PermissionMode {
    /// Modes that may be selected when creating a coding session. Custom needs an attached
    /// profile; every other mode, Bypass included, starts without a confirmation.
    pub const fn is_confirm_free_start(self) -> bool {
        !matches!(self, Self::Custom)
    }
}

/// Built-in authority scopes. Plugin capability scopes are added with the plugin system (Z11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum PermissionScope {
    #[serde(rename = "filesystem.read")]
    FilesystemRead,
    #[serde(rename = "filesystem.write")]
    FilesystemWrite,
    #[serde(rename = "filesystem.outside_workspace")]
    FilesystemOutsideWorkspace,
    #[serde(rename = "terminal.read_only")]
    TerminalReadOnly,
    #[serde(rename = "terminal.execute")]
    TerminalExecute,
    #[serde(rename = "package.install")]
    PackageInstall,
    #[serde(rename = "git.read")]
    GitRead,
    #[serde(rename = "git.commit")]
    GitCommit,
    #[serde(rename = "git.push")]
    GitPush,
    #[serde(rename = "network.docs")]
    NetworkDocs,
    #[serde(rename = "network.other")]
    NetworkOther,
    #[serde(rename = "browser.navigate")]
    BrowserNavigate,
    #[serde(rename = "browser.interact")]
    BrowserInteract,
    #[serde(rename = "credentials.access")]
    CredentialsAccess,
    #[serde(rename = "messaging.send")]
    MessagingSend,
    #[serde(rename = "deploy.production")]
    DeployProduction,
    #[serde(rename = "cloud.modify")]
    CloudModify,
    #[serde(rename = "billing.spend")]
    BillingSpend,
    #[serde(rename = "destructive")]
    Destructive,
    // ---- Trust Kernel phase 1 (adopted in CA-1; classified by crates/permissions in TK-1) ----
    /// Terminate or signal a process.
    #[serde(rename = "process.control")]
    ProcessControl,
    /// Open an SSH connection to a remote host.
    #[serde(rename = "remote.connect")]
    RemoteConnect,
    /// Send a context package to a provider (non-user origins).
    #[serde(rename = "context.share")]
    ContextShare,
    /// Agents and automations writing memory.
    #[serde(rename = "memory.write")]
    MemoryWrite,
    /// Create or enable automations (non-user origins).
    #[serde(rename = "automation.manage")]
    AutomationManage,
    /// Start a delegation to another agent.
    #[serde(rename = "agent.delegate")]
    AgentDelegate,
    /// Start or resume agent threads on the user's behalf (KalVoice and other non-thread origins).
    /// Added in CA-1 with the KalVoice request.
    #[serde(rename = "thread.start")]
    ThreadStart,
    /// A provider tool KalCode cannot classify (Z4 request). Today unrecognized tools are still
    /// reported as `terminal.execute` (opaque); TK-1 switches the classifier to this scope.
    #[serde(rename = "tool.unknown")]
    ToolUnknown,
}

impl PermissionScope {
    /// Every scope, in declaration order (the 19 Z4 scopes, then the CA-1 additions).
    pub const ALL: [PermissionScope; 27] = [
        Self::FilesystemRead,
        Self::FilesystemWrite,
        Self::FilesystemOutsideWorkspace,
        Self::TerminalReadOnly,
        Self::TerminalExecute,
        Self::PackageInstall,
        Self::GitRead,
        Self::GitCommit,
        Self::GitPush,
        Self::NetworkDocs,
        Self::NetworkOther,
        Self::BrowserNavigate,
        Self::BrowserInteract,
        Self::CredentialsAccess,
        Self::MessagingSend,
        Self::DeployProduction,
        Self::CloudModify,
        Self::BillingSpend,
        Self::Destructive,
        Self::ProcessControl,
        Self::RemoteConnect,
        Self::ContextShare,
        Self::MemoryWrite,
        Self::AutomationManage,
        Self::AgentDelegate,
        Self::ThreadStart,
        Self::ToolUnknown,
    ];

    /// Scopes whose consequences leave the machine. Never implied by Bypass.
    pub fn is_remote_consequential(self) -> bool {
        matches!(
            self,
            Self::GitPush
                | Self::MessagingSend
                | Self::DeployProduction
                | Self::CloudModify
                | Self::BillingSpend
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RuleEffect {
    Allow,
    Ask,
    Deny,
    /// Deny, and never offer to approve (e.g. "Delete repository: Never").
    Never,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PermissionRule {
    pub scope: PermissionScope,
    pub effect: RuleEffect,
    /// Optional matcher interpreted per scope: a command prefix, a domain, a path glob.
    pub matcher: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PermissionProfile {
    pub id: String,
    pub name: String,
    pub mode: PermissionMode,
    pub rules: Vec<PermissionRule>,
    pub builtin: bool,
}

/// What a provider/agent wants to do, normalized so one policy engine can judge every provider.
/// Produced by provider adapters (Z2/Z3) from their tool calls; evaluated by the engine (Z4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ActionKind {
    FileRead {
        path: String,
    },
    FileWrite {
        path: String,
    },
    FileDelete {
        path: String,
    },
    /// A shell command. `argv` when the provider exposes it; `command` is the display form.
    Command {
        command: String,
        argv: Vec<String>,
        cwd: String,
    },
    PackageInstall {
        manager: String,
        packages: Vec<String>,
    },
    Git {
        operation: GitOperation,
        remote: Option<String>,
    },
    Network {
        host: String,
        url: Option<String>,
    },
    Browser {
        action: String,
        url: Option<String>,
    },
    Deploy {
        target: String,
    },
    /// A provider tool KalCode cannot classify more precisely. Evaluated conservatively.
    Tool {
        tool: String,
        input_summary: String,
    },
    // ---- Trust Kernel phase 1 (adopted in CA-1). Until TK-1 classifies them precisely, the
    // engine treats these as opaque: always an explicit, one-time approval. ----
    /// Terminate or signal a process (Utility Dock, Doctor).
    ProcessSignal {
        pid: u32,
        process_name: String,
        signal: ProcessSignalKind,
    },
    /// Open an SSH connection (Distributed Workspaces).
    RemoteConnect {
        host_id: String,
        address: String,
    },
    /// Send a context package to a provider.
    ContextShare {
        package_id: String,
        items: u32,
        bytes: u64,
    },
    /// Write a memory record.
    MemoryWrite {
        memory_id: Option<String>,
        scope: MemoryScope,
    },
    /// Start a delegation under a delegation contract.
    Delegate {
        contract_id: String,
        delegate_agent_id: String,
    },
    /// Restore files from a checkpoint (Time Machine).
    Restore {
        checkpoint_id: String,
        files: u32,
        reset_branch: bool,
    },
    /// Create, enable, disable, edit or delete an automation.
    AutomationChange {
        automation_id: String,
        change: AutomationChangeKind,
    },
    /// A typed Environment Doctor fix from the fixed catalog (never free-form commands).
    DoctorFix {
        fix_code: String,
        target: String,
    },
    /// Authorize resolving one exact, normalized API Inspector host. This authority contains no
    /// destination claim: a fresh [`ActionKind::UtilityHttp`] approval binds the pinned result.
    UtilityDnsResolve {
        operation_id: String,
        host: String,
    },
    /// A sealed Utility Dock HTTP hop. The URL path, query, headers and body remain only in the
    /// authenticated native runtime; review exposes the canonical origin and bounded shape.
    UtilityHttp {
        operation_id: String,
        method: UtilityHttpMethod,
        origin: String,
        destination: UtilityHttpDestination,
        redirect_hop: u8,
        body_bytes: u64,
    },
    /// A sealed process signal bound to the creation identity of a retained OS process handle.
    UtilityProcessSignal {
        operation_id: String,
        pid: u32,
        process_start_time: String,
        process_name: String,
        signal: ProcessSignalKind,
    },
    /// A sealed SQLite write bound to a retained database identity. Raw SQL is never persisted in
    /// the permission request.
    UtilitySqliteWrite {
        operation_id: String,
        database_id: String,
        database_name: String,
        statement: UtilitySqliteOperation,
    },
    /// Open new agent threads (KalVoice "create three Codex threads"). Added in CA-1.
    CreateThreads {
        provider_id: ProviderId,
        count: u32,
        workspace_id: Option<String>,
    },
    /// Resume stopped threads (KalVoice "resume my threads"). Added in CA-1.
    ResumeThreads {
        scope: ThreadScope,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "UPPERCASE")]
#[ts(export)]
pub enum UtilityHttpMethod {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
    Options,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum UtilityHttpDestination {
    Loopback,
    Private,
    External,
    LinkLocal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum UtilitySqliteOperation {
    Insert,
    Update,
    Delete,
    Replace,
    Create,
    Drop,
    Alter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProcessSignalKind {
    Terminate,
    Kill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AutomationChangeKind {
    Create,
    Enable,
    Disable,
    Edit,
    Delete,
}

/// Where a memory record lives (`docs/CONTRACTS_ADVANCED.md` §5.9; the memory system lands in
/// P4, the scope is needed now by `ActionKind::MemoryWrite`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum MemoryScope {
    Global,
    Workspace { workspace_id: String },
    Agent { agent_id: String },
    Mission { mission_id: String },
}

/// Who is acting (Trust Kernel, `docs/TRUST_KERNEL.md`). The `kind` values are exactly the v4
/// `approvals.origin_kind` CHECK values. Replaces the crate-local `Actor` of crates/permissions in
/// TK-1 (same values, plus ids).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ActionOrigin {
    /// A person acting through KalCode's own UI.
    User,
    /// KalCode itself (expiry, recovery).
    System,
    /// A provider session in a thread (the only origin before TK-1).
    Thread {
        thread_id: String,
    },
    #[serde(rename = "kalvoice")]
    KalVoice {
        request_id: String,
    },
    Agent {
        agent_id: String,
        thread_id: String,
    },
    Delegation {
        delegation_id: String,
        thread_id: String,
    },
    Automation {
        automation_id: String,
        run_id: String,
    },
    Doctor {
        run_id: String,
        fix_code: String,
    },
    Continuity {
        item_id: String,
    },
    /// A Utility Dock tool (`tool` is the tool's snake_case id).
    Utility {
        tool: String,
    },
    Remote {
        host_id: String,
    },
}

impl ActionOrigin {
    /// Every `kind` value, in the order of the v4 `approvals.origin_kind` CHECK.
    pub const KINDS: [&'static str; 11] = [
        "user",
        "system",
        "thread",
        "kalvoice",
        "agent",
        "delegation",
        "automation",
        "doctor",
        "continuity",
        "utility",
        "remote",
    ];

    /// The `kind` tag, as stored in `approvals.origin_kind`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::User => "user",
            Self::System => "system",
            Self::Thread { .. } => "thread",
            Self::KalVoice { .. } => "kalvoice",
            Self::Agent { .. } => "agent",
            Self::Delegation { .. } => "delegation",
            Self::Automation { .. } => "automation",
            Self::Doctor { .. } => "doctor",
            Self::Continuity { .. } => "continuity",
            Self::Utility { .. } => "utility",
            Self::Remote { .. } => "remote",
        }
    }

    /// The id stored in `approvals.origin_id` (the most specific id the origin carries).
    pub fn id(&self) -> Option<&str> {
        match self {
            Self::User | Self::System => None,
            Self::Thread { thread_id } => Some(thread_id),
            Self::KalVoice { request_id } => Some(request_id),
            Self::Agent { agent_id, .. } => Some(agent_id),
            Self::Delegation { delegation_id, .. } => Some(delegation_id),
            Self::Automation { run_id, .. } | Self::Doctor { run_id, .. } => Some(run_id),
            Self::Continuity { item_id } => Some(item_id),
            Self::Utility { tool } => Some(tool),
            Self::Remote { host_id } => Some(host_id),
        }
    }

    /// Only the user may relax policy (Trust Kernel K5/K6).
    pub fn is_user(&self) -> bool {
        matches!(self, Self::User)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum GitOperation {
    Status,
    Diff,
    Log,
    Commit,
    Branch,
    Checkout,
    Push,
    Pull,
    Reset,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NormalizedAction {
    pub id: String,
    pub thread_id: String,
    pub workspace_id: String,
    pub provider_id: ProviderId,
    pub action: ActionKind,
    /// One-line, user-readable description ("Run npm install lodash").
    pub summary: String,
    pub requested_at: String,
    /// Who is acting. Absent in requests stored before CA-1 and from today's adapters, meaning
    /// `Thread { thread_id }` (see [`NormalizedAction::effective_origin`]). For non-thread
    /// origins `thread_id` / `provider_id` hold `""` and `origin` is authoritative.
    #[serde(default)]
    pub origin: Option<ActionOrigin>,
}

impl NormalizedAction {
    /// `origin`, or the thread origin every pre-CA-1 action implicitly had.
    pub fn effective_origin(&self) -> ActionOrigin {
        self.origin.clone().unwrap_or_else(|| ActionOrigin::Thread {
            thread_id: self.thread_id.clone(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PolicyEffect {
    Allow,
    Ask,
    Deny,
}

/// The engine's verdict for one action, with its reason (for the approval UI and the audit log).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PolicyDecision {
    pub effect: PolicyEffect,
    pub scopes: Vec<PermissionScope>,
    pub reason: String,
    /// True when the user may approve (false for `Never` rules).
    pub approvable: bool,
}

/// The user's answer to an approval request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ApprovalDecision {
    Deny,
    ApproveOnce,
    ApproveForThread,
    ApproveForWorkspace,
    AllowViaRule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    /// The thread stopped, the process exited, or the request was superseded.
    Expired,
}

/// Names shown in the approval prompt, captured when the request opens.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApprovalContext {
    pub thread_name: Option<String>,
    pub workspace_name: Option<String>,
    pub provider_name: Option<String>,
}

/// An approval request as every surface shows it. The fields after `resolved_at` were adopted in
/// CA-1 from Z4's `ApprovalView` (now an alias of this type); they default when absent so older
/// stored or cached JSON still deserializes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ApprovalRequest {
    pub id: String,
    pub action: NormalizedAction,
    pub decision: PolicyDecision,
    pub permission_mode: PermissionMode,
    pub status: ApprovalStatus,
    pub resolved_decision: Option<ApprovalDecision>,
    pub resolved_at: Option<String>,
    /// The answers the user may give (only `deny` for requests that cannot be approved).
    #[serde(default)]
    pub allowed_decisions: Vec<ApprovalDecision>,
    /// What "Allow for thread / workspace" would cover ("changing any file in this workspace").
    #[serde(default)]
    pub grant_coverage: String,
    #[serde(default)]
    pub context: Option<ApprovalContext>,
    #[serde(default)]
    pub created_at: String,
    /// Why an expired request expired: `thread_stopped`, `superseded`, `mode_changed`,
    /// `process_restarted` or `answered_in_provider` (the v4 `expire_reason` CHECK values).
    #[serde(default)]
    pub expire_reason: Option<String>,
}

/// The permission engine as the thread runtime sees it. Implemented by Z4; consumed by Z3.
///
/// Flow: an adapter reports an action → `evaluate` → `Allow` runs it, `Deny` refuses it, `Ask`
/// calls `open_request`, which persists the request and emits `approval.requested`. The user's
/// answer arrives on the event bus as `approval.approved` / `approval.denied` / `approval.expired`
/// for that request id; the thread runtime forwards it to the provider session.
pub trait PermissionGate: Send + Sync {
    /// Pure policy evaluation of `action` under `mode` and the standing grants for its thread.
    fn evaluate(&self, action: &NormalizedAction, mode: PermissionMode) -> PolicyDecision;
    /// Records a pending approval and emits `approval.requested`.
    fn open_request(
        &self,
        action: NormalizedAction,
        mode: PermissionMode,
        decision: PolicyDecision,
    ) -> Result<ApprovalRequest, String>;
    /// Expires every pending request of a thread (it stopped, or its process exited).
    fn expire_for_thread(&self, thread_id: &str);
}

/// Conservative stand-in for development and tests until the Z4 engine lands: reads inside the
/// workspace are allowed; everything else asks. It never allows more than the real engine would.
#[derive(Debug, Default, Clone, Copy)]
pub struct AskUnlessReadGate;

impl PermissionGate for AskUnlessReadGate {
    fn evaluate(&self, action: &NormalizedAction, _mode: PermissionMode) -> PolicyDecision {
        let (effect, scopes) = match &action.action {
            ActionKind::FileRead { .. } => {
                (PolicyEffect::Allow, vec![PermissionScope::FilesystemRead])
            }
            _ => (PolicyEffect::Ask, vec![]),
        };
        PolicyDecision {
            effect,
            scopes,
            reason: "Development gate: only reads run without asking.".into(),
            approvable: true,
        }
    }

    fn open_request(
        &self,
        action: NormalizedAction,
        mode: PermissionMode,
        decision: PolicyDecision,
    ) -> Result<ApprovalRequest, String> {
        let allowed_decisions = if decision.approvable {
            vec![ApprovalDecision::Deny, ApprovalDecision::ApproveOnce]
        } else {
            vec![ApprovalDecision::Deny]
        };
        Ok(ApprovalRequest {
            id: crate::ids::new_id(),
            action,
            decision,
            permission_mode: mode,
            status: ApprovalStatus::Pending,
            resolved_decision: None,
            resolved_at: None,
            allowed_decisions,
            grant_coverage: "only this request".into(),
            context: None,
            created_at: String::new(),
            expire_reason: None,
        })
    }

    fn expire_for_thread(&self, _thread_id: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_use_dotted_wire_names() {
        assert_eq!(
            serde_json::to_string(&PermissionScope::GitPush).expect("json"),
            "\"git.push\""
        );
        assert!(PermissionScope::DeployProduction.is_remote_consequential());
        assert!(!PermissionScope::FilesystemWrite.is_remote_consequential());
    }

    #[test]
    fn development_gate_only_allows_reads() {
        let action = |kind| NormalizedAction {
            id: "a".into(),
            thread_id: "t".into(),
            workspace_id: "w".into(),
            provider_id: crate::agent::ProviderId::new("p"),
            action: kind,
            summary: String::new(),
            requested_at: String::new(),
            origin: None,
        };
        let gate = AskUnlessReadGate;
        let read = gate.evaluate(
            &action(ActionKind::FileRead { path: "a".into() }),
            PermissionMode::Bypass,
        );
        assert_eq!(read.effect, PolicyEffect::Allow);
        let run = gate.evaluate(
            &action(ActionKind::Command {
                command: "rm -rf /".into(),
                argv: vec![],
                cwd: String::new(),
            }),
            PermissionMode::Bypass,
        );
        assert_eq!(run.effect, PolicyEffect::Ask);
    }

    #[test]
    fn actions_are_tagged_by_kind() {
        let action = ActionKind::Command {
            command: "npm test".into(),
            argv: vec!["npm".into(), "test".into()],
            cwd: "/p".into(),
        };
        let json = serde_json::to_value(&action).expect("json");
        assert_eq!(json["kind"], "command");
        assert_eq!(json["argv"][1], "test");
    }

    /// The origin kinds are exactly the values the v4 schema accepts in `approvals.origin_kind`.
    #[test]
    fn origin_kinds_match_the_v4_check_exactly() {
        let sql = include_str!("../../native-core/migrations/0004_permissions.sql");
        let start =
            sql.find("origin_kind IN (").expect("origin_kind CHECK") + "origin_kind IN (".len();
        let end = start + sql[start..].find(')').expect("end of CHECK");
        let allowed: Vec<&str> = sql[start..end]
            .split(',')
            .map(|v| v.trim().trim_matches('\''))
            .collect();
        assert_eq!(allowed, ActionOrigin::KINDS);
        let samples = [
            ActionOrigin::User,
            ActionOrigin::System,
            ActionOrigin::Thread {
                thread_id: "t".into(),
            },
            ActionOrigin::KalVoice {
                request_id: "r".into(),
            },
            ActionOrigin::Agent {
                agent_id: "a".into(),
                thread_id: "t".into(),
            },
            ActionOrigin::Delegation {
                delegation_id: "d".into(),
                thread_id: "t".into(),
            },
            ActionOrigin::Automation {
                automation_id: "a".into(),
                run_id: "r".into(),
            },
            ActionOrigin::Doctor {
                run_id: "r".into(),
                fix_code: "f".into(),
            },
            ActionOrigin::Continuity {
                item_id: "i".into(),
            },
            ActionOrigin::Utility {
                tool: "http".into(),
            },
            ActionOrigin::Remote {
                host_id: "h".into(),
            },
        ];
        let kinds: Vec<&str> = samples.iter().map(ActionOrigin::kind).collect();
        assert_eq!(kinds, ActionOrigin::KINDS);
        for origin in samples {
            let json = serde_json::to_value(&origin).expect("json");
            assert_eq!(json["kind"], origin.kind());
            let back: ActionOrigin = serde_json::from_value(json).expect("back");
            assert_eq!(back, origin);
        }
    }

    /// Requests and actions stored by Z4 before CA-1 (no origin, no view fields) still decode.
    #[test]
    fn pre_ca1_json_still_decodes() {
        let action = serde_json::json!({
            "id": "a", "threadId": "t", "workspaceId": "w", "providerId": "claude-code",
            "action": {"kind": "file_read", "path": "a"}, "summary": "", "requestedAt": ""
        });
        let decoded: NormalizedAction = serde_json::from_value(action.clone()).expect("action");
        assert_eq!(decoded.origin, None);
        assert_eq!(
            decoded.effective_origin(),
            ActionOrigin::Thread {
                thread_id: "t".into()
            }
        );
        let request = serde_json::json!({
            "id": "r", "action": action,
            "decision": {"effect": "ask", "scopes": [], "reason": "", "approvable": true},
            "permissionMode": "approve", "status": "pending",
            "resolvedDecision": null, "resolvedAt": null
        });
        let decoded: ApprovalRequest = serde_json::from_value(request).expect("request");
        assert!(decoded.allowed_decisions.is_empty());
        assert_eq!(decoded.expire_reason, None);
        let json = serde_json::to_value(&decoded).expect("json");
        assert_eq!(json["grantCoverage"], "");
        assert!(json["context"].is_null());
    }

    #[test]
    fn every_scope_is_listed_once_with_a_dotted_name() {
        let mut names = std::collections::HashSet::new();
        for scope in PermissionScope::ALL {
            let json = serde_json::to_value(scope).expect("json");
            let name = json.as_str().expect("string").to_owned();
            assert!(name.contains('.') || name == "destructive", "{name}");
            assert!(names.insert(name));
        }
        assert_eq!(
            serde_json::to_value(PermissionScope::ToolUnknown).expect("json"),
            "tool.unknown"
        );
        assert!(!PermissionScope::ProcessControl.is_remote_consequential());
    }

    #[test]
    fn trust_kernel_action_kinds_are_tagged() {
        let json = serde_json::to_value(ActionKind::ProcessSignal {
            pid: 7,
            process_name: "node".into(),
            signal: ProcessSignalKind::Terminate,
        })
        .expect("json");
        assert_eq!(
            json,
            serde_json::json!({"kind": "process_signal", "pid": 7, "processName": "node", "signal": "terminate"})
        );
        let memory = serde_json::to_value(ActionKind::MemoryWrite {
            memory_id: None,
            scope: MemoryScope::Workspace {
                workspace_id: "w".into(),
            },
        })
        .expect("json");
        assert_eq!(memory["scope"]["kind"], "workspace");
        assert_eq!(memory["scope"]["workspaceId"], "w");
    }

    #[test]
    fn utility_effects_have_typed_non_secret_review_fields() {
        let dns = serde_json::to_value(ActionKind::UtilityDnsResolve {
            operation_id: "018f8d7c-91b2-7c3d-8e4f-1234567890ab".into(),
            host: "api.example.test".into(),
        })
        .expect("dns json");
        assert_eq!(dns["kind"], "utility_dns_resolve");
        assert_eq!(dns["host"], "api.example.test");
        assert!(dns.get("destination").is_none());

        let http = serde_json::to_value(ActionKind::UtilityHttp {
            operation_id: "018f8d7c-a1b2-7c3d-8e4f-1234567890ab".into(),
            method: UtilityHttpMethod::Post,
            origin: "https://api.example.test/".into(),
            destination: UtilityHttpDestination::External,
            redirect_hop: 2,
            body_bytes: 128,
        })
        .expect("http json");
        assert_eq!(http["kind"], "utility_http");
        assert_eq!(http["method"], "POST");
        assert_eq!(http["destination"], "external");
        assert!(http.get("body").is_none());
        assert!(http.get("sql").is_none());

        let sqlite = serde_json::to_value(ActionKind::UtilitySqliteWrite {
            operation_id: "018f8d7c-b1b2-7c3d-8e4f-1234567890ab".into(),
            database_id: "018f8d7c-c1b2-7c3d-8e4f-1234567890ab".into(),
            database_name: "work.db".into(),
            statement: UtilitySqliteOperation::Update,
        })
        .expect("sqlite json");
        assert_eq!(sqlite["kind"], "utility_sqlite_write");
        assert_eq!(sqlite["statement"], "update");
        assert!(sqlite.get("sql").is_none());
    }
}
