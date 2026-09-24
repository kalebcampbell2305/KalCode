//! Build channel and feature flags.
//!
//! A surface is `available` when it fully works, `preview` when it works but is still being
//! refined, and `gated` when it has not reached its campaign. Gated surfaces are hidden on the
//! stable channel; development builds show an honest status page for them.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use kalcode_contracts::app::BuildChannel;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SurfaceId {
    Dashboard,
    Jarvis,
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
}

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FeatureFlags {
    pub surfaces: Vec<SurfaceFlag>,
}

impl FeatureFlags {
    pub fn for_channel(channel: BuildChannel) -> Self {
        use SurfaceId::*;
        use SurfaceState::*;
        let table = [
            (Dashboard, Available),
            (Jarvis, Gated),
            (Code, Gated),
            (Threads, Gated),
            (Agents, Gated),
            (Missions, Gated),
            (Automations, Gated),
            (Skills, Gated),
            (Plugins, Gated),
            (Memory, Gated),
            (Providers, Available),
            (Settings, Available),
        ];
        let surfaces = table
            .into_iter()
            .map(|(id, state)| SurfaceFlag {
                id,
                state,
                visible: match (state, channel) {
                    (Available, _) => true,
                    (Preview, BuildChannel::Stable) => false,
                    (Preview, _) => true,
                    (Gated, BuildChannel::Development) => true,
                    (Gated, _) => false,
                },
            })
            .collect();
        Self { surfaces }
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
    fn channel_parsing_defaults_to_development() {
        assert_eq!(BuildChannel::parse("stable"), BuildChannel::Stable);
        assert_eq!(BuildChannel::parse("beta"), BuildChannel::Beta);
        assert_eq!(BuildChannel::parse("nonsense"), BuildChannel::Development);
    }
}
