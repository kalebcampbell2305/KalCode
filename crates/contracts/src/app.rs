//! Application-level contract types.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BuildChannel {
    Stable,
    Beta,
    Development,
}

/// Top-level product surfaces (navigation, feature flags, KalVoice navigation commands).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SurfaceId {
    Dashboard,
    Operations,
    #[serde(rename = "kalvoice")]
    KalVoice,
    Code,
    Threads,
    Agents,
    Missions,
    Automations,
    Skills,
    Plugins,
    Memory,
    Providers,
    Settings,
    /// Command Center (ADVANCED.md §14 decision 5: the one new top-level surface). Gated until
    /// its campaign ships.
    CommandCenter,
}

/// Per-feature flags next to the surface flags (`docs/CONTRACTS_ADVANCED.md` §10). A feature is
/// part of a surface (or of several); its flag says whether it is built and shown on a channel,
/// and its [`FeaturePlacement`] says which plans include it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FeatureId {
    ProviderHealth,
    ProviderProfiles,
    ContextDrop,
    UtilityDock,
    ResourceGovernor,
    SessionLocator,
    ProcessContinuity,
    GitCore,
    TrustKernelExplain,
    AgentOrganization,
    Missions,
    Verification,
    TimeMachine,
    RemoteWorkspaces,
    Scheduler,
    DiffIntelligence,
    Automations,
    Memory,
    EnvironmentDoctor,
    Blueprints,
    CommandCenter,
    ProviderHandoff,
    BenchmarkLab,
    FailureAutopsy,
    WorkspaceHome,
    WorkspaceRail,
    PaneSystem,
    ProviderPanes,
    NotificationCenter,
    AccountSignIn,
    // Safety parts of other systems, listed so their placement is explicit and tested.
    ContextFirewall,
    HostKeyVerification,
    SafeRestore,
    AutomationKillSwitch,
}

/// The lowest plan a feature is on (ADVANCED.md §14a decision 1). `Safety` features are on every
/// plan and can never be moved to a paid plan, like permission modes. OWNER has everything,
/// current and future, by construction (it is unrestricted, not enumerated).
///
/// Mirrored by `FEATURE_PLACEMENT` in `packages/protocol/src/features.ts`, the single source of
/// truth for plan placement; a test here keeps the two identical.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FeaturePlacement {
    Safety,
    Free,
    Pro,
    Max,
}

impl FeatureId {
    pub const ALL: [FeatureId; 34] = [
        Self::ProviderHealth,
        Self::ProviderProfiles,
        Self::ContextDrop,
        Self::UtilityDock,
        Self::ResourceGovernor,
        Self::SessionLocator,
        Self::ProcessContinuity,
        Self::GitCore,
        Self::TrustKernelExplain,
        Self::AgentOrganization,
        Self::Missions,
        Self::Verification,
        Self::TimeMachine,
        Self::RemoteWorkspaces,
        Self::Scheduler,
        Self::DiffIntelligence,
        Self::Automations,
        Self::Memory,
        Self::EnvironmentDoctor,
        Self::Blueprints,
        Self::CommandCenter,
        Self::ProviderHandoff,
        Self::BenchmarkLab,
        Self::FailureAutopsy,
        Self::WorkspaceHome,
        Self::WorkspaceRail,
        Self::PaneSystem,
        Self::ProviderPanes,
        Self::NotificationCenter,
        Self::AccountSignIn,
        Self::ContextFirewall,
        Self::HostKeyVerification,
        Self::SafeRestore,
        Self::AutomationKillSwitch,
    ];

    /// Plan placement (ADVANCED.md §14a decision 1; placements the decision does not name are
    /// the lead's and are marked "lead" in `docs/CONTRACTS.md`).
    pub fn placement(self) -> FeaturePlacement {
        use FeaturePlacement::*;
        match self {
            // Safety systems: every plan, never paywalled.
            Self::TrustKernelExplain
            | Self::ContextFirewall
            | Self::HostKeyVerification
            | Self::EnvironmentDoctor
            | Self::SafeRestore
            | Self::AutomationKillSwitch => Safety,
            // Free.
            Self::ProviderHealth
            | Self::SessionLocator
            | Self::ProcessContinuity
            | Self::UtilityDock
            | Self::ResourceGovernor
            | Self::GitCore
            | Self::ContextDrop
            | Self::WorkspaceHome
            | Self::WorkspaceRail
            | Self::PaneSystem
            | Self::ProviderPanes
            | Self::NotificationCenter
            | Self::AccountSignIn => Free,
            // Pro.
            Self::AgentOrganization
            | Self::ProviderProfiles
            | Self::Blueprints
            | Self::TimeMachine
            | Self::ProviderHandoff
            | Self::RemoteWorkspaces
            | Self::Automations
            | Self::Memory
            | Self::Missions
            | Self::Verification => Pro,
            // MAX.
            Self::CommandCenter
            | Self::Scheduler
            | Self::BenchmarkLab
            | Self::FailureAutopsy
            | Self::DiffIntelligence => Max,
        }
    }

    /// The snake_case wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProviderHealth => "provider_health",
            Self::ProviderProfiles => "provider_profiles",
            Self::ContextDrop => "context_drop",
            Self::UtilityDock => "utility_dock",
            Self::ResourceGovernor => "resource_governor",
            Self::SessionLocator => "session_locator",
            Self::ProcessContinuity => "process_continuity",
            Self::GitCore => "git_core",
            Self::TrustKernelExplain => "trust_kernel_explain",
            Self::AgentOrganization => "agent_organization",
            Self::Missions => "missions",
            Self::Verification => "verification",
            Self::TimeMachine => "time_machine",
            Self::RemoteWorkspaces => "remote_workspaces",
            Self::Scheduler => "scheduler",
            Self::DiffIntelligence => "diff_intelligence",
            Self::Automations => "automations",
            Self::Memory => "memory",
            Self::EnvironmentDoctor => "environment_doctor",
            Self::Blueprints => "blueprints",
            Self::CommandCenter => "command_center",
            Self::ProviderHandoff => "provider_handoff",
            Self::BenchmarkLab => "benchmark_lab",
            Self::FailureAutopsy => "failure_autopsy",
            Self::WorkspaceHome => "workspace_home",
            Self::WorkspaceRail => "workspace_rail",
            Self::PaneSystem => "pane_system",
            Self::ProviderPanes => "provider_panes",
            Self::NotificationCenter => "notification_center",
            Self::AccountSignIn => "account_sign_in",
            Self::ContextFirewall => "context_firewall",
            Self::HostKeyVerification => "host_key_verification",
            Self::SafeRestore => "safe_restore",
            Self::AutomationKillSwitch => "automation_kill_switch",
        }
    }
}

impl FeaturePlacement {
    /// Whether a restricted plan includes a feature with this placement. `plan_rank`: Free = 0,
    /// Pro = 1, MAX = 2. (OWNER is unrestricted and never asks.)
    pub fn included_in(self, plan_rank: u8) -> bool {
        match self {
            Self::Safety | Self::Free => true,
            Self::Pro => plan_rank >= 1,
            Self::Max => plan_rank >= 2,
        }
    }
}

impl BuildChannel {
    /// Channel baked in at compile time via `KALCODE_CHANNEL` (default: development).
    pub fn current() -> Self {
        Self::parse(option_env!("KALCODE_CHANNEL").unwrap_or("development"))
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "stable" => Self::Stable,
            "beta" => Self::Beta,
            _ => Self::Development,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_wire_names_match_serde_and_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for feature in FeatureId::ALL {
            assert_eq!(
                serde_json::to_value(feature).expect("json"),
                feature.as_str()
            );
            assert!(seen.insert(feature));
        }
        assert_eq!(
            serde_json::to_value(SurfaceId::CommandCenter).expect("json"),
            "command_center"
        );
    }

    #[test]
    fn safety_features_are_on_every_plan() {
        for feature in FeatureId::ALL {
            if feature.placement() == FeaturePlacement::Safety {
                assert!(feature.placement().included_in(0), "{feature:?}");
            }
        }
        for safety in [
            FeatureId::TrustKernelExplain,
            FeatureId::ContextFirewall,
            FeatureId::HostKeyVerification,
            FeatureId::EnvironmentDoctor,
            FeatureId::SafeRestore,
            FeatureId::AutomationKillSwitch,
        ] {
            assert_eq!(safety.placement(), FeaturePlacement::Safety, "{safety:?}");
        }
        assert!(!FeatureId::TimeMachine.placement().included_in(0));
        assert!(FeatureId::TimeMachine.placement().included_in(1));
        assert!(!FeatureId::BenchmarkLab.placement().included_in(1));
    }

    /// `packages/protocol/src/features.ts` is the single source of truth for plan placement; this
    /// keeps the Rust mirror identical, entry for entry and in order.
    #[test]
    fn placement_matches_the_protocol_package() {
        let ts = include_str!("../../../packages/protocol/src/features.ts");
        let start = ts
            .find("export const FEATURE_PLACEMENT = {")
            .expect("FEATURE_PLACEMENT in features.ts");
        let body = &ts[start..];
        let body = &body[..body.find("} as const").expect("end of FEATURE_PLACEMENT")];
        let entries: Vec<(String, String)> = body
            .lines()
            .skip(1)
            .filter_map(|line| {
                let line = line.trim();
                if line.starts_with("//") {
                    return None;
                }
                let (key, value) = line.trim_end_matches(',').split_once(": ")?;
                Some((key.to_owned(), value.trim_matches('"').to_owned()))
            })
            .collect();
        assert_eq!(entries.len(), FeatureId::ALL.len(), "{entries:?}");
        for (feature, (key, value)) in FeatureId::ALL.into_iter().zip(entries) {
            assert_eq!(key, feature.as_str());
            let placement = serde_json::to_value(feature.placement()).expect("json");
            assert_eq!(placement, value.as_str(), "{key}");
        }
    }
}
