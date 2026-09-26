//! Developer Utility Dock (UD, `docs/UTILITY_DOCK.md`): the tool identifiers shared by the
//! desktop shell, KalVoice and the permission engine's `ActionOrigin::Utility`.
//!
//! Only the tool enum lives here. The utilities' own wire types (requests, process rows, SQLite
//! pages, …) live in `kalcode_utilities::types` until the lead moves them into contracts (the
//! JSON shapes are chosen so the move changes nothing on the wire; `docs/campaigns/UD.md`).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One tool of the Utility Dock. The snake_case form is the tool id used in
/// `ActionOrigin::Utility { tool }` and in pane widget ids (`kalcode.utility.<id>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum UtilityTool {
    ApiInspector,
    Json,
    Regex,
    Processes,
    Ports,
    Environment,
    Sqlite,
    ScratchTerminal,
    Scratchpad,
    Diff,
    EncodeHash,
}

impl UtilityTool {
    pub const ALL: [UtilityTool; 11] = [
        Self::ApiInspector,
        Self::Json,
        Self::Regex,
        Self::Processes,
        Self::Ports,
        Self::Environment,
        Self::Sqlite,
        Self::ScratchTerminal,
        Self::Scratchpad,
        Self::Diff,
        Self::EncodeHash,
    ];

    /// The snake_case id (same as the JSON form).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ApiInspector => "api_inspector",
            Self::Json => "json",
            Self::Regex => "regex",
            Self::Processes => "processes",
            Self::Ports => "ports",
            Self::Environment => "environment",
            Self::Sqlite => "sqlite",
            Self::ScratchTerminal => "scratch_terminal",
            Self::Scratchpad => "scratchpad",
            Self::Diff => "diff",
            Self::EncodeHash => "encode_hash",
        }
    }

    /// The name people see ("API Inspector").
    pub fn display_name(self) -> &'static str {
        match self {
            Self::ApiInspector => "API Inspector",
            Self::Json => "JSON Tool",
            Self::Regex => "Regex Lab",
            Self::Processes => "Process Monitor",
            Self::Ports => "Port Inspector",
            Self::Environment => "Environment Viewer",
            Self::Sqlite => "SQLite Viewer",
            Self::ScratchTerminal => "Scratch terminal",
            Self::Scratchpad => "Scratchpad",
            Self::Diff => "Diff Tool",
            Self::EncodeHash => "Encode / Hash",
        }
    }

    /// The origin a consequential action taken from this tool carries into the permission
    /// engine (`ActionOrigin::Utility { tool }`).
    pub fn origin(self) -> crate::permissions::ActionOrigin {
        crate::permissions::ActionOrigin::Utility {
            tool: self.as_str().to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_the_json_form_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for tool in UtilityTool::ALL {
            let json = serde_json::to_value(tool).expect("json");
            assert_eq!(json, tool.as_str());
            assert!(seen.insert(tool.as_str()));
            let back: UtilityTool = serde_json::from_value(json).expect("back");
            assert_eq!(back, tool);
            assert!(!tool.display_name().is_empty());
            assert_eq!(tool.origin().kind(), "utility");
            assert_eq!(tool.origin().id(), Some(tool.as_str()));
        }
    }
}
