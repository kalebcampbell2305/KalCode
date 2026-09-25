//! Trust Kernel phase-1 types (adopted in CA-1 from `docs/CONTRACTS_ADVANCED.md` §2;
//! `docs/TRUST_KERNEL.md`). Types only: `crates/permissions` implements [`TrustKernel`] in TK-1,
//! on top of the existing Z4 engine. There is one evaluator, one audit trail and one approval
//! queue; ceilings and invariants can only restrict, and only the user can relax policy.
//!
//! [`ActionOrigin`](crate::permissions::ActionOrigin), the new scopes and the new action kinds
//! live in `permissions.rs` next to the types they extend.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::permissions::{
    ApprovalRequest, NormalizedAction, PermissionMode, PermissionRule, PermissionScope,
    PolicyDecision, PolicyEffect,
};

/// A restriction applied on top of the policy. Ceilings only ever restrict (K7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AuthorityCeiling {
    pub id: String,
    pub source: CeilingSource,
    /// The broadest mode actions may be evaluated under (never Bypass for non-user origins).
    pub max_mode: PermissionMode,
    /// `None` = no allow-list; `Some` = only these scopes may be anything other than Deny.
    pub allow_scopes: Option<Vec<PermissionScope>>,
    /// Treated as `never` rules.
    pub never: Vec<PermissionRule>,
    /// Path globs (workspace-relative) outside which filesystem scopes are denied.
    pub path_globs: Vec<String>,
    /// Parent ceiling this one was intersected with.
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum CeilingSource {
    Delegation { delegation_id: String },
    Automation { automation_id: String },
    Mission { mission_id: String },
}

/// One evaluation request: the action, the mode it runs under, and the ceiling that applies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ActionRequest {
    pub action: NormalizedAction,
    pub mode: PermissionMode,
    pub custom_profile_id: Option<String>,
    pub ceiling: Option<AuthorityCeiling>,
}

/// Non-overridable kernel rules (`docs/TRUST_KERNEL.md` K1–K10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum KernelInvariant {
    /// K1: anything the kernel cannot evaluate is denied.
    FailClosed,
    /// K2: actions KalCode cannot fully see need an explicit, one-time approval.
    OpaqueNeedsApproval,
    /// K3: consequences that leave the machine always ask.
    RemoteConsequentialAsks,
    /// K4: repository content never grants authority.
    RepositoryIsNotAuthority,
    /// K5: only the user changes policy, and only through KalCode's UI.
    OnlyUserChangesPolicy,
    /// K6: Bypass is set by the user only.
    BypassIsUserOnly,
    /// K7: ceilings only restrict.
    CeilingRestricts,
    /// K8: approvals are decided by the user.
    ApprovalsAreUserDecided,
    /// K9: every consequential decision is audited.
    Audited,
    /// K10: a few confirmations are native (WebView-unforgeable), ADVANCED.md §3 D8.
    NativeConfirmation,
}

/// The kernel's final result for one action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KernelDecision {
    /// Final result (policy result after ceilings and invariants).
    pub decision: PolicyDecision,
    pub invariants: Vec<KernelInvariant>,
    pub ceiling_applied: Option<String>,
    /// The action may proceed only after a Rust-side (native) confirmation dialog (D8 set).
    pub requires_native_confirmation: bool,
    /// Recorded in `permission_action_log`; used by `explain` and Time Machine replay.
    pub log_id: Option<String>,
}

/// Why an action was decided the way it was, step by step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DecisionExplanation {
    pub action_id: String,
    /// Ordered: invariant → ceiling → profile rule → baseline → grant.
    pub steps: Vec<ExplanationStep>,
    /// One sentence, user-readable.
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExplanationStep {
    pub scope: PermissionScope,
    pub source: String,
    pub effect: PolicyEffect,
    pub detail: String,
}

/// Implemented by `crates/permissions` (TK-1). The only evaluator; `PermissionGate` stays the Z3
/// seam and is implemented on top of it.
pub trait TrustKernel: Send + Sync {
    fn evaluate(&self, request: &ActionRequest) -> KernelDecision;
    /// Persists an approval request (any origin) and emits `approval.requested`.
    fn open_request(
        &self,
        request: ActionRequest,
        decision: KernelDecision,
    ) -> Result<ApprovalRequest, String>;
    /// Records that a native confirmation happened for `log_id` (K10), then allows execution.
    fn confirm_native(&self, log_id: &str) -> Result<(), String>;
    fn explain(&self, action_id: &str) -> Option<DecisionExplanation>;
    /// Composes a child ceiling: result = parent ∩ child. Never broader than `parent`.
    fn compose_ceiling(
        &self,
        parent: Option<&AuthorityCeiling>,
        child: AuthorityCeiling,
    ) -> AuthorityCeiling;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ceilings_and_invariants_have_stable_wire_forms() {
        let ceiling = AuthorityCeiling {
            id: "c".into(),
            source: CeilingSource::Automation {
                automation_id: "a".into(),
            },
            max_mode: PermissionMode::Auto,
            allow_scopes: Some(vec![PermissionScope::FilesystemRead]),
            never: vec![],
            path_globs: vec!["src/**".into()],
            parent_id: None,
        };
        let json = serde_json::to_value(&ceiling).expect("json");
        assert_eq!(json["source"]["kind"], "automation");
        assert_eq!(json["maxMode"], "auto");
        assert_eq!(json["allowScopes"][0], "filesystem.read");
        assert_eq!(
            serde_json::to_value(KernelInvariant::RemoteConsequentialAsks).expect("json"),
            "remote_consequential_asks"
        );
    }
}
