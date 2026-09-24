//! Built-in permission profiles. Mode profiles are generated from [`policy::baseline`], so what
//! Settings shows is exactly what the engine enforces. Every mode is available on every plan.

use kalcode_contracts::permissions::{
    PermissionMode, PermissionProfile, PermissionRule, PermissionScope as S, RuleEffect,
};

use crate::policy::baseline;
use crate::scopes::ALL_SCOPES;

pub const PLAN: &str = "builtin.plan";
pub const APPROVE: &str = "builtin.approve";
pub const AUTO: &str = "builtin.auto";
pub const BYPASS: &str = "builtin.bypass";
pub const CODE_REVIEWER: &str = "builtin.code_reviewer";
pub const LOCAL_BUILDER: &str = "builtin.local_builder";

/// The built-in profile that represents `mode` (Custom has none; it needs a named profile).
pub fn mode_profile_id(mode: PermissionMode) -> Option<&'static str> {
    match mode {
        PermissionMode::Plan => Some(PLAN),
        PermissionMode::Approve => Some(APPROVE),
        PermissionMode::Auto => Some(AUTO),
        PermissionMode::Bypass => Some(BYPASS),
        PermissionMode::Custom => None,
    }
}

fn mode_profile(id: &str, name: &str, mode: PermissionMode) -> PermissionProfile {
    PermissionProfile {
        id: id.to_owned(),
        name: name.to_owned(),
        mode,
        rules: ALL_SCOPES
            .iter()
            .map(|&scope| PermissionRule {
                scope,
                effect: baseline(mode, scope),
                matcher: None,
            })
            .collect(),
        builtin: true,
    }
}

fn rules(entries: &[(S, RuleEffect)]) -> Vec<PermissionRule> {
    entries
        .iter()
        .map(|&(scope, effect)| PermissionRule {
            scope,
            effect,
            matcher: None,
        })
        .collect()
}

/// Every built-in profile, in display order.
pub fn builtin_profiles() -> Vec<PermissionProfile> {
    use RuleEffect::{Allow, Ask, Deny, Never};
    vec![
        mode_profile(PLAN, "Plan", PermissionMode::Plan),
        mode_profile(APPROVE, "Approve", PermissionMode::Approve),
        mode_profile(AUTO, "Auto", PermissionMode::Auto),
        mode_profile(BYPASS, "Bypass", PermissionMode::Bypass),
        PermissionProfile {
            id: CODE_REVIEWER.to_owned(),
            name: "Code Reviewer".to_owned(),
            mode: PermissionMode::Custom,
            rules: rules(&[
                (S::FilesystemRead, Allow),
                (S::FilesystemWrite, Deny),
                (S::FilesystemOutsideWorkspace, Ask),
                (S::TerminalReadOnly, Allow),
                (S::TerminalExecute, Ask),
                (S::PackageInstall, Deny),
                (S::GitRead, Allow),
                (S::GitCommit, Deny),
                (S::GitPush, Never),
                (S::NetworkDocs, Allow),
                (S::NetworkOther, Ask),
                (S::BrowserNavigate, Ask),
                (S::BrowserInteract, Ask),
                (S::CredentialsAccess, Deny),
                (S::MessagingSend, Ask),
                (S::DeployProduction, Never),
                (S::CloudModify, Never),
                (S::BillingSpend, Never),
                (S::Destructive, Never),
            ]),
            builtin: true,
        },
        PermissionProfile {
            id: LOCAL_BUILDER.to_owned(),
            name: "Local Builder".to_owned(),
            mode: PermissionMode::Custom,
            rules: rules(&[
                (S::FilesystemRead, Allow),
                (S::FilesystemWrite, Allow),
                (S::FilesystemOutsideWorkspace, Ask),
                (S::TerminalReadOnly, Allow),
                (S::TerminalExecute, Allow),
                (S::PackageInstall, Ask),
                (S::GitRead, Allow),
                (S::GitCommit, Allow),
                (S::GitPush, Ask),
                (S::NetworkDocs, Allow),
                (S::NetworkOther, Ask),
                (S::BrowserNavigate, Allow),
                (S::BrowserInteract, Ask),
                (S::CredentialsAccess, Ask),
                (S::MessagingSend, Never),
                (S::DeployProduction, Never),
                (S::CloudModify, Never),
                (S::BillingSpend, Never),
                (S::Destructive, Ask),
            ]),
            builtin: true,
        },
    ]
}

pub fn builtin(id: &str) -> Option<PermissionProfile> {
    builtin_profiles().into_iter().find(|p| p.id == id)
}

/// A profile id KalCode accepts from the UI: a built-in id or a stored profile's UUID.
pub fn is_valid_profile_id(id: &str) -> bool {
    builtin(id).is_some() || kalcode_contracts::ids::is_valid_id(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_profiles_mirror_the_baseline() {
        for profile in builtin_profiles()
            .iter()
            .filter(|p| p.mode != PermissionMode::Custom)
        {
            assert_eq!(profile.rules.len(), ALL_SCOPES.len());
            for rule in &profile.rules {
                assert_eq!(rule.effect, baseline(profile.mode, rule.scope));
            }
        }
    }

    #[test]
    fn custom_builtins_cover_every_scope_once() {
        for profile in builtin_profiles()
            .iter()
            .filter(|p| p.mode == PermissionMode::Custom)
        {
            for scope in ALL_SCOPES {
                assert_eq!(
                    profile.rules.iter().filter(|r| r.scope == scope).count(),
                    1,
                    "{} {scope:?}",
                    profile.name
                );
            }
        }
    }

    #[test]
    fn profile_ids_validate() {
        assert!(is_valid_profile_id(CODE_REVIEWER));
        assert!(is_valid_profile_id(&kalcode_contracts::ids::new_id()));
        assert!(!is_valid_profile_id("builtin.root"));
        assert!(!is_valid_profile_id("../x"));
    }
}
