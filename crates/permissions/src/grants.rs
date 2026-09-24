//! Standing grants created by approval decisions, and which decisions a request allows.

use kalcode_contracts::permissions::{
    ApprovalDecision, NormalizedAction, PermissionRule, PermissionScope as S, PolicyDecision,
    PolicyEffect, RuleEffect,
};

use crate::classify::Classification;
use crate::scopes::is_always_ask;

/// "Allow for thread" lasts until the thread stops or its process exits, and at most this long.
pub const THREAD_GRANT_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// "Allow for workspace" lasts this long (or until revoked).
pub const WORKSPACE_GRANT_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantKind {
    Thread,
    Workspace,
    Rule,
}

impl GrantKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Thread => "thread",
            Self::Workspace => "workspace",
            Self::Rule => "rule",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "thread" => Some(Self::Thread),
            "workspace" => Some(Self::Workspace),
            "rule" => Some(Self::Rule),
            _ => None,
        }
    }
}

/// A standing permission created by the user's decision on a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub id: String,
    pub kind: GrantKind,
    pub thread_id: Option<String>,
    pub workspace_id: Option<String>,
    pub scopes: Vec<S>,
    pub fingerprint: String,
    /// Rule grants: the matcher of the generated allow rules.
    pub matcher: Option<String>,
    pub expires_at_ms: Option<i64>,
}

impl Grant {
    /// Does this grant allow `scope` for `action`? Rule grants are applied as rules, not here.
    pub fn covers(
        &self,
        action: &NormalizedAction,
        c: &Classification,
        scope: S,
        now_ms: i64,
    ) -> bool {
        if self.expires_at_ms.is_some_and(|at| now_ms >= at) {
            return false;
        }
        let place = match self.kind {
            GrantKind::Thread => {
                self.thread_id.as_deref() == Some(action.thread_id.as_str())
                    && self.workspace_id.as_deref() == Some(action.workspace_id.as_str())
            }
            GrantKind::Workspace => {
                self.workspace_id.as_deref() == Some(action.workspace_id.as_str())
            }
            GrantKind::Rule => false,
        };
        place && self.scopes.contains(&scope) && self.fingerprint == c.fingerprint
    }

    /// The allow rules a rule grant stands for.
    pub fn as_rules(&self, now_ms: i64) -> Vec<PermissionRule> {
        if self.kind != GrantKind::Rule || self.expires_at_ms.is_some_and(|at| now_ms >= at) {
            return Vec::new();
        }
        self.scopes
            .iter()
            .map(|&scope| PermissionRule {
                scope,
                effect: RuleEffect::Allow,
                matcher: self.matcher.clone(),
            })
            .collect()
    }
}

/// Scopes an "Allow via rule" decision may create a standing rule for.
const RULE_SCOPES: &[S] = &[
    S::FilesystemRead,
    S::FilesystemWrite,
    S::TerminalReadOnly,
    S::TerminalExecute,
    S::GitRead,
    S::GitCommit,
    S::NetworkDocs,
    S::BrowserNavigate,
];

/// Which answers the user may give. Deny is always possible. Nothing but Deny for a request
/// the policy refused; only "Approve once" for opaque or sensitive actions and for any scope
/// that always asks (remote-consequential, destructive, credentials, outside the workspace).
pub fn allowed_decisions(decision: &PolicyDecision, c: &Classification) -> Vec<ApprovalDecision> {
    let mut allowed = vec![ApprovalDecision::Deny];
    if decision.effect != PolicyEffect::Ask || !decision.approvable {
        return allowed;
    }
    allowed.push(ApprovalDecision::ApproveOnce);
    let standing = !c.opaque && !c.sensitive && !decision.scopes.iter().any(|s| is_always_ask(*s));
    if !standing {
        return allowed;
    }
    allowed.push(ApprovalDecision::ApproveForThread);
    allowed.push(ApprovalDecision::ApproveForWorkspace);
    if decision.scopes.iter().all(|s| RULE_SCOPES.contains(s)) && rule_matcher(c).is_some() {
        allowed.push(ApprovalDecision::AllowViaRule);
    }
    allowed
}

/// The matcher an "Allow via rule" decision records: the simple command for command-like
/// actions, the host for network actions, the workspace-relative path for file actions.
pub fn rule_matcher(c: &Classification) -> Option<String> {
    if c.fingerprint.starts_with("file.") {
        return match c.paths.as_slice() {
            [one] => one.relative.clone().filter(|r| !r.is_empty()),
            _ => None,
        };
    }
    if c.fingerprint.starts_with("network:") || c.fingerprint.starts_with("browser:") {
        return match c.hosts.as_slice() {
            [one] => Some(one.clone()),
            _ => None,
        };
    }
    c.subject.clone().filter(|s| !s.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::classify::classify;
    use crate::paths::Workspace;
    use kalcode_contracts::permissions::ActionKind;

    fn ask(scopes: Vec<S>) -> PolicyDecision {
        PolicyDecision {
            effect: PolicyEffect::Ask,
            scopes,
            reason: String::new(),
            approvable: true,
        }
    }

    #[test]
    fn remote_and_destructive_requests_are_once_only() {
        let c = classify(
            &ActionKind::Deploy {
                target: "prod".into(),
            },
            &Workspace::none(),
        );
        assert_eq!(
            allowed_decisions(&ask(c.scopes.clone()), &c),
            vec![ApprovalDecision::Deny, ApprovalDecision::ApproveOnce]
        );
    }

    #[test]
    fn refused_requests_only_allow_deny() {
        let c = classify(
            &ActionKind::Deploy {
                target: "prod".into(),
            },
            &Workspace::none(),
        );
        let mut d = ask(c.scopes.clone());
        d.effect = PolicyEffect::Deny;
        d.approvable = false;
        assert_eq!(allowed_decisions(&d, &c), vec![ApprovalDecision::Deny]);
    }

    #[test]
    fn simple_commands_allow_standing_grants_and_rules() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ws = Workspace::new(Some(dir.path()));
        let c = classify(
            &ActionKind::Command {
                command: "npm test".into(),
                argv: vec![],
                cwd: String::new(),
            },
            &ws,
        );
        let allowed = allowed_decisions(&ask(c.scopes.clone()), &c);
        assert!(allowed.contains(&ApprovalDecision::ApproveForThread));
        assert!(allowed.contains(&ApprovalDecision::AllowViaRule));
        assert_eq!(rule_matcher(&c).as_deref(), Some("npm test"));
    }

    #[test]
    fn opaque_commands_are_once_only() {
        let c = classify(
            &ActionKind::Command {
                command: "echo $(whoami)".into(),
                argv: vec![],
                cwd: String::new(),
            },
            &Workspace::none(),
        );
        assert!(c.opaque);
        assert_eq!(
            allowed_decisions(&ask(c.scopes.clone()), &c),
            vec![ApprovalDecision::Deny, ApprovalDecision::ApproveOnce]
        );
    }
}
