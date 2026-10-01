//! Build channel and feature flags.
//!
//! A surface is `available` when it fully works, `preview` when it works but is still being
//! refined, and `gated` when it has not reached its campaign. Gated surfaces are hidden on the
//! stable channel; development builds show an honest status page for them.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use kalcode_contracts::app::{BuildChannel, FeatureId, FeaturePlacement, SurfaceId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SurfaceState {
    Available,
    Preview,
    Gated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SurfaceFlag {
    pub id: SurfaceId,
    pub state: SurfaceState,
    /// Whether the surface appears in navigation for this channel.
    pub visible: bool,
}

/// A per-feature flag (CA-1 / L-1). Features ship inside surfaces; a gated feature is hidden on
/// stable and beta and shown with an honest status in development builds, like surfaces. Plan
/// placement is separate (`FeatureId::placement`, evaluated on the signed entitlement).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FeatureFlag {
    pub id: FeatureId,
    pub state: SurfaceState,
    pub visible: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FeatureFlags {
    pub surfaces: Vec<SurfaceFlag>,
    /// Added in CA-1; absent in older payloads.
    #[serde(default)]
    pub features: Vec<FeatureFlag>,
}

fn visible(state: SurfaceState, channel: BuildChannel) -> bool {
    use SurfaceState::*;
    match (state, channel) {
        (Available, _) => true,
        (Preview, BuildChannel::Stable) => false,
        (Preview, _) => true,
        (Gated, BuildChannel::Development) => true,
        (Gated, _) => false,
    }
}

/// The build state of a feature. Every advanced-systems feature is gated until its campaign
/// merges and flips its row here (a hot file: writers list their line in the hand-off).
fn feature_state(feature: FeatureId) -> SurfaceState {
    match feature {
        FeatureId::ContextDrop
        | FeatureId::UtilityDock
        | FeatureId::ResourceGovernor
        | FeatureId::SessionLocator
        | FeatureId::ProcessContinuity
        | FeatureId::GitCore
        | FeatureId::TrustKernelExplain
        | FeatureId::AgentOrganization
        | FeatureId::Missions
        | FeatureId::Verification
        | FeatureId::TimeMachine
        | FeatureId::RemoteWorkspaces
        | FeatureId::Scheduler
        | FeatureId::DiffIntelligence
        | FeatureId::Automations
        | FeatureId::Memory
        | FeatureId::EnvironmentDoctor
        | FeatureId::Blueprints
        | FeatureId::CommandCenter
        | FeatureId::ProviderHandoff
        | FeatureId::BenchmarkLab
        | FeatureId::FailureAutopsy
        | FeatureId::WorkspaceHome
        | FeatureId::WorkspaceRail
        | FeatureId::ProviderPanes
        | FeatureId::ContextFirewall
        | FeatureId::HostKeyVerification
        | FeatureId::SafeRestore
        | FeatureId::AutomationKillSwitch => SurfaceState::Gated,
        // Z7-W1: the pane canvas is the Code surface.
        FeatureId::PaneSystem => SurfaceState::Available,
        // 0.1.5 zero-setup (E1-E3, E7): these ship unconditionally on Stable (Providers › Health
        // and Accounts, the Notifications panel, the sign-in gate); nothing gates on the flag.
        FeatureId::ProviderHealth
        | FeatureId::ProviderProfiles
        | FeatureId::NotificationCenter
        | FeatureId::AccountSignIn => SurfaceState::Available,
    }
}

impl FeatureFlags {
    pub fn for_channel(channel: BuildChannel) -> Self {
        use SurfaceId::*;
        use SurfaceState::*;
        let table = [
            (Dashboard, Available),
            (Operations, Available),
            // Stable ships KalVoice; bootstrap still requires the compiled speech engine.
            (KalVoice, Available),
            (Code, Available),
            (Threads, Available),
            (Agents, Gated),
            (Missions, Gated),
            (Automations, Gated),
            (Skills, Gated),
            (Plugins, Gated),
            (Memory, Gated),
            (Providers, Available),
            (Settings, Available),
            (CommandCenter, Gated),
        ];
        let surfaces = table
            .into_iter()
            .map(|(id, state)| SurfaceFlag {
                id,
                state,
                visible: visible(state, channel),
            })
            .collect();
        let features = FeatureId::ALL
            .into_iter()
            .map(|id| {
                let state = feature_state(id);
                FeatureFlag {
                    id,
                    state,
                    visible: visible(state, channel),
                }
            })
            .collect();
        Self { surfaces, features }
    }

    /// Hides a surface outside development builds when a native component it needs is not
    /// compiled into this build (KalVoice without its on-device speech engine: push to talk
    /// couldn't hear anything). Development builds keep showing it, with the component's honest
    /// "not in this build" state. This check also applies to available Stable surfaces.
    pub fn require_component(&mut self, surface: SurfaceId, compiled: bool, channel: BuildChannel) {
        if compiled || channel == BuildChannel::Development {
            return;
        }
        for flag in self.surfaces.iter_mut().filter(|s| s.id == surface) {
            flag.visible = false;
        }
    }

    /// The flag of `feature` (every feature has one).
    pub fn feature(&self, feature: FeatureId) -> Option<&FeatureFlag> {
        self.features.iter().find(|flag| flag.id == feature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_hides_everything_not_available() {
        let flags = FeatureFlags::for_channel(BuildChannel::Stable);
        for surface in &flags.surfaces {
            assert_eq!(
                surface.visible,
                surface.state == SurfaceState::Available,
                "{:?}",
                surface.id
            );
        }
    }

    #[test]
    fn development_shows_gated_surfaces() {
        let flags = FeatureFlags::for_channel(BuildChannel::Development);
        assert!(flags.surfaces.iter().all(|s| s.visible));
        assert!(
            flags
                .surfaces
                .iter()
                .any(|s| s.state == SurfaceState::Gated)
        );
    }

    #[test]
    fn code_surface_is_available_on_every_channel() {
        for channel in [
            BuildChannel::Stable,
            BuildChannel::Beta,
            BuildChannel::Development,
        ] {
            let code = FeatureFlags::for_channel(channel)
                .surfaces
                .into_iter()
                .find(|s| s.id == SurfaceId::Code)
                .expect("code surface");
            assert_eq!(code.state, SurfaceState::Available);
            assert!(code.visible);
        }
    }

    #[test]
    fn channel_parsing_defaults_to_development() {
        assert_eq!(BuildChannel::parse("stable"), BuildChannel::Stable);
        assert_eq!(BuildChannel::parse("beta"), BuildChannel::Beta);
        assert_eq!(BuildChannel::parse("nonsense"), BuildChannel::Development);
    }

    #[test]
    fn every_feature_has_one_flag_and_advanced_features_are_gated() {
        // Shipped in every channel: the pane system (Z7-W1) and the 0.1.5 features whose UI is
        // unconditional (provider health and accounts, notifications, KalCode sign-in).
        const AVAILABLE: [FeatureId; 5] = [
            FeatureId::PaneSystem,
            FeatureId::ProviderHealth,
            FeatureId::ProviderProfiles,
            FeatureId::NotificationCenter,
            FeatureId::AccountSignIn,
        ];
        for channel in [
            BuildChannel::Stable,
            BuildChannel::Beta,
            BuildChannel::Development,
        ] {
            let flags = FeatureFlags::for_channel(channel);
            assert_eq!(flags.features.len(), FeatureId::ALL.len());
            for feature in FeatureId::ALL {
                let flag = flags.feature(feature).expect("flag");
                if AVAILABLE.contains(&feature) {
                    assert_eq!(flag.state, SurfaceState::Available, "{feature:?}");
                    assert!(flag.visible, "{feature:?}");
                    continue;
                }
                assert_eq!(flag.state, SurfaceState::Gated, "{feature:?}");
                assert_eq!(flag.visible, channel == BuildChannel::Development);
            }
        }
    }

    #[test]
    fn kalvoice_is_available_and_needs_its_speech_engine_outside_development() {
        let kalvoice = |flags: &FeatureFlags| {
            flags
                .surfaces
                .iter()
                .find(|s| s.id == SurfaceId::KalVoice)
                .cloned()
                .expect("kalvoice")
        };
        for (channel, compiled, visible) in [
            (BuildChannel::Beta, true, true),
            (BuildChannel::Beta, false, false),
            (BuildChannel::Development, false, true),
            (BuildChannel::Development, true, true),
            (BuildChannel::Stable, true, true),
            (BuildChannel::Stable, false, false),
        ] {
            let mut flags = FeatureFlags::for_channel(channel);
            flags.require_component(SurfaceId::KalVoice, compiled, channel);
            let flag = kalvoice(&flags);
            assert_eq!(flag.state, SurfaceState::Available);
            assert_eq!(
                flag.visible, visible,
                "{channel:?}, engine compiled: {compiled}"
            );
        }
    }

    #[test]
    fn stable_shell_fixture_matches_native_compiled_surfaces() {
        let mut flags = FeatureFlags::for_channel(BuildChannel::Stable);
        flags.require_component(SurfaceId::KalVoice, true, BuildChannel::Stable);
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../apps/desktop/src/shell/fixtures/stable-native-surfaces.json"
        ))
        .expect("native shell fixture");
        assert_eq!(serde_json::to_value(&flags.surfaces).unwrap(), fixture);
    }

    #[test]
    fn command_center_is_a_gated_surface() {
        let stable = FeatureFlags::for_channel(BuildChannel::Stable);
        let surface = stable
            .surfaces
            .iter()
            .find(|s| s.id == SurfaceId::CommandCenter)
            .expect("command center");
        assert_eq!(surface.state, SurfaceState::Gated);
        assert!(!surface.visible);
        // Older payloads without `features` still decode.
        let old: FeatureFlags =
            serde_json::from_value(serde_json::json!({"surfaces": []})).expect("decode");
        assert!(old.features.is_empty());
    }
}
