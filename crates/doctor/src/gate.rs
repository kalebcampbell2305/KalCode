//! The seam between Doctor fixes and KalCode's one authority (ADVANCED.md §3 D5, DOC-03).
//!
//! Every fix that changes something is a typed `ActionKind::DoctorFix` from the fixed catalog
//! with `origin = ActionOrigin::Doctor { run_id, fix_code }`, evaluated by the Z4 permission
//! engine ([`kalcode_permissions::PermissionService::request_for_origin`]): under Approve,
//! without standing grants, opaque (always asked), answerable once by the person only. When the
//! Trust Kernel lands (TK-1) it implements [`FixGate`] by wrapping the same engine; nothing in the
//! Doctor changes. No gate ⇒ no fix (fail closed).

use kalcode_contracts::permissions::{
    ApprovalDecision, ApprovalStatus, NormalizedAction, PolicyEffect,
};

/// What the permission engine decided about a fix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision {
    /// The policy allows it without asking.
    Allowed,
    /// The policy refuses it.
    Denied { reason: String },
    /// An approval request was filed; the person answers it in KalCode.
    Asked { approval_id: String },
}

pub trait FixGate: Send + Sync {
    fn request(&self, action: NormalizedAction) -> Result<GateDecision, String>;
    /// Confirms that `approval_id` approved this exact immutable action. Replay consumption is
    /// performed atomically by the Doctor fix journal after this check.
    fn confirm(&self, approval_id: &str, action: &NormalizedAction)
    -> Result<GateDecision, String>;
}

impl FixGate for kalcode_permissions::PermissionService {
    fn request(&self, action: NormalizedAction) -> Result<GateDecision, String> {
        let outcome = self
            .request_for_origin(action)
            .map_err(|e| e.message.clone())?;
        Ok(match (outcome.decision.effect, outcome.approval) {
            (PolicyEffect::Ask, Some(approval)) => GateDecision::Asked {
                approval_id: approval.id,
            },
            (PolicyEffect::Ask, None) => {
                return Err("KalCode couldn't file the approval request.".into());
            }
            (PolicyEffect::Allow, _) => GateDecision::Allowed,
            (PolicyEffect::Deny, _) => GateDecision::Denied {
                reason: outcome.decision.reason,
            },
        })
    }

    fn confirm(
        &self,
        approval_id: &str,
        action: &NormalizedAction,
    ) -> Result<GateDecision, String> {
        let request = self
            .verify_doctor_approval(approval_id, action)
            .map_err(|error| error.message.clone())?;
        Ok(match (request.status, request.resolved_decision) {
            (ApprovalStatus::Approved, Some(ApprovalDecision::ApproveOnce)) => {
                GateDecision::Allowed
            }
            (ApprovalStatus::Pending, _) => GateDecision::Asked {
                approval_id: request.id,
            },
            _ => GateDecision::Denied {
                reason: "That approval did not authorize this fix.".into(),
            },
        })
    }
}
