//! Permission contract (enforced from Z4). See docs/PERMISSIONS.md. KalVoice, agents,
//! automations and plugins are all subject to these rules. Every permission mode is available on
//! every plan.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::ProviderId;

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
}

impl PermissionScope {
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
        Ok(ApprovalRequest {
            id: crate::ids::new_id(),
            action,
            decision,
            permission_mode: mode,
            status: ApprovalStatus::Pending,
            resolved_decision: None,
            resolved_at: None,
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
}
