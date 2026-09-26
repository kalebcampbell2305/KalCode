//! Z7 workspace UX contracts (adopted in CA-1 from `docs/CONTRACTS_ADVANCED.md` §6.10 and
//! `docs/campaigns/ADVANCED.md` §16): normalized display statuses with their tones, and the
//! versioned pane-layout schema. The mapping from runtime status lives on
//! [`ThreadStatus::display`](crate::threads::ThreadStatus::display).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The 12 display statuses every surface shows (Dashboard, rail, panes, notifications,
/// KalVoice). Always rendered with text and a glyph, never colour alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DisplayStatus {
    Starting,
    Working,
    Testing,
    Reviewing,
    PermissionRequired,
    WaitingForYou,
    Idle,
    Paused,
    Done,
    Failed,
    Recovering,
    Offline,
}

impl DisplayStatus {
    pub const ALL: [DisplayStatus; 12] = [
        Self::Starting,
        Self::Working,
        Self::Testing,
        Self::Reviewing,
        Self::PermissionRequired,
        Self::WaitingForYou,
        Self::Idle,
        Self::Paused,
        Self::Done,
        Self::Failed,
        Self::Recovering,
        Self::Offline,
    ];

    /// The label, as shown (uppercase).
    pub fn label(self) -> &'static str {
        match self {
            Self::Starting => "STARTING",
            Self::Working => "WORKING",
            Self::Testing => "TESTING",
            Self::Reviewing => "REVIEWING",
            Self::PermissionRequired => "PERMISSION REQUIRED",
            Self::WaitingForYou => "WAITING FOR YOU",
            Self::Idle => "IDLE",
            Self::Paused => "PAUSED",
            Self::Done => "DONE",
            Self::Failed => "FAILED",
            Self::Recovering => "RECOVERING",
            Self::Offline => "OFFLINE",
        }
    }

    /// The colour semantics of the status (owner's colour spec, ADVANCED.md §14a decision 8).
    pub fn tone(self) -> StatusTone {
        match self {
            Self::Working | Self::Testing | Self::Reviewing => StatusTone::Working,
            Self::PermissionRequired | Self::WaitingForYou => StatusTone::Waiting,
            Self::Starting | Self::Idle | Self::Offline => StatusTone::Muted,
            Self::Done => StatusTone::Done,
            Self::Failed => StatusTone::Failed,
            Self::Paused => StatusTone::Paused,
            Self::Recovering => StatusTone::Recovering,
        }
    }
}

/// Colour semantics for display statuses. Surfaces map tones to design-system tokens; the
/// approval / waiting accent is neutral grey and amber is reserved for PAUSED.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum StatusTone {
    /// Green: WORKING, TESTING, REVIEWING.
    Working,
    /// Neutral grey, emphasized: WAITING FOR YOU, PERMISSION REQUIRED.
    Waiting,
    /// Muted: IDLE, STARTING, OFFLINE.
    Muted,
    /// High-contrast neutral: DONE.
    Done,
    /// Red: FAILED.
    Failed,
    /// Amber: PAUSED (the only amber status).
    Paused,
    /// Blue: RECOVERING.
    Recovering,
}

/// Extra context for IDLE, which stands in for STOPPED and BLOCKED.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DisplayQualifier {
    /// `waiting_for_dependency`: "waiting on …".
    WaitingOnDependency,
    /// `interrupted`: "stopped · resumable".
    StoppedResumable,
}

impl DisplayQualifier {
    pub fn label(self) -> &'static str {
        match self {
            Self::WaitingOnDependency => "waiting on another task",
            Self::StoppedResumable => "stopped · resumable",
        }
    }
}

/// Dashboard filter chips.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum DashboardChip {
    All,
    WaitingForYou,
    Working,
    Done,
    Idle,
}

/// Current pane-layout schema version.
pub const PANE_LAYOUT_SCHEMA_VERSION: u32 = 1;
/// Deepest split nesting accepted.
pub const MAX_PANE_DEPTH: usize = 8;
/// Most leaves (panes) in one layout.
pub const MAX_PANES: usize = 32;
/// Most tabs in one pane.
pub const MAX_TABS_PER_PANE: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SplitAxis {
    Horizontal,
    Vertical,
}

/// What a pane tab shows. Unknown kinds in stored layouts render as "unavailable".
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum PaneContent {
    Thread {
        thread_id: String,
    },
    Terminal {
        terminal_id: String,
    },
    Dashboard,
    Widget {
        widget_id: String,
    },
    /// An isolated browser surface. Older placeholder layouts receive an identity on load.
    Browser {
        #[serde(default = "crate::ids::new_id")]
        browser_id: String,
        url: Option<String>,
    },
    /// Z6b.
    Git {
        workspace_id: String,
    },
}

/// A versioned pane tree (validated natively with [`PaneLayout::validate`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum PaneNode {
    Split {
        axis: SplitAxis,
        /// Per-mille shares of each child; they sum to 1000.
        ratios: Vec<u16>,
        children: Vec<PaneNode>,
    },
    Leaf {
        pane_id: String,
        tabs: Vec<PaneContent>,
        active_tab: u32,
        collapsed: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PaneLayout {
    pub schema_version: u32,
    pub root: PaneNode,
    pub maximized_pane_id: Option<String>,
    pub dock: Vec<PaneContent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum LayoutPreset {
    Two,
    Three,
    Four,
    Six,
    Custom { preset_id: String },
}

/// Why a pane layout is refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LayoutError {
    #[error("unsupported layout schema version {0}")]
    UnsupportedVersion(u32),
    #[error("a split needs at least two children and one ratio per child")]
    BadSplit,
    #[error("split ratios must be positive and sum to 1000")]
    BadRatios,
    #[error("the layout is nested too deeply")]
    TooDeep,
    #[error("the layout has too many panes or tabs")]
    TooLarge,
    #[error("pane ids must be unique and non-empty")]
    BadPaneId,
    #[error("a pane's active tab is out of range")]
    BadActiveTab,
    #[error("the maximized pane does not exist")]
    UnknownMaximizedPane,
}

impl PaneLayout {
    /// Structural validation. Content ids are validated by their owners when a pane opens.
    pub fn validate(&self) -> Result<(), LayoutError> {
        if self.schema_version != PANE_LAYOUT_SCHEMA_VERSION {
            return Err(LayoutError::UnsupportedVersion(self.schema_version));
        }
        let mut ids = HashSet::new();
        validate_node(&self.root, 1, &mut ids)?;
        if self.dock.len() > MAX_TABS_PER_PANE {
            return Err(LayoutError::TooLarge);
        }
        if let Some(id) = &self.maximized_pane_id
            && !ids.contains(id.as_str())
        {
            return Err(LayoutError::UnknownMaximizedPane);
        }
        Ok(())
    }
}

fn validate_node<'a>(
    node: &'a PaneNode,
    depth: usize,
    ids: &mut HashSet<&'a str>,
) -> Result<(), LayoutError> {
    if depth > MAX_PANE_DEPTH {
        return Err(LayoutError::TooDeep);
    }
    match node {
        PaneNode::Split {
            ratios, children, ..
        } => {
            if children.len() < 2 || ratios.len() != children.len() {
                return Err(LayoutError::BadSplit);
            }
            let sum: u32 = ratios.iter().map(|r| u32::from(*r)).sum();
            if sum != 1000 || ratios.contains(&0) {
                return Err(LayoutError::BadRatios);
            }
            for child in children {
                validate_node(child, depth + 1, ids)?;
            }
            Ok(())
        }
        PaneNode::Leaf {
            pane_id,
            tabs,
            active_tab,
            ..
        } => {
            if pane_id.is_empty() || pane_id.len() > 64 || !ids.insert(pane_id.as_str()) {
                return Err(LayoutError::BadPaneId);
            }
            if ids.len() > MAX_PANES || tabs.len() > MAX_TABS_PER_PANE {
                return Err(LayoutError::TooLarge);
            }
            let active = usize::try_from(*active_tab).unwrap_or(usize::MAX);
            if (tabs.is_empty() && *active_tab != 0) || (!tabs.is_empty() && active >= tabs.len()) {
                return Err(LayoutError::BadActiveTab);
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(id: &str) -> PaneNode {
        PaneNode::Leaf {
            pane_id: id.into(),
            tabs: vec![PaneContent::Dashboard],
            active_tab: 0,
            collapsed: false,
        }
    }

    fn layout(root: PaneNode) -> PaneLayout {
        PaneLayout {
            schema_version: 1,
            root,
            maximized_pane_id: None,
            dock: vec![],
        }
    }

    #[test]
    fn tones_follow_the_colour_spec() {
        assert_eq!(DisplayStatus::Working.tone(), StatusTone::Working);
        assert_eq!(
            DisplayStatus::PermissionRequired.tone(),
            StatusTone::Waiting
        );
        assert_eq!(DisplayStatus::WaitingForYou.tone(), StatusTone::Waiting);
        assert_eq!(DisplayStatus::Idle.tone(), StatusTone::Muted);
        assert_eq!(DisplayStatus::Done.tone(), StatusTone::Done);
        assert_eq!(DisplayStatus::Failed.tone(), StatusTone::Failed);
        assert_eq!(DisplayStatus::Recovering.tone(), StatusTone::Recovering);
        // Amber is reserved for PAUSED.
        let amber: Vec<_> = DisplayStatus::ALL
            .into_iter()
            .filter(|s| s.tone() == StatusTone::Paused)
            .collect();
        assert_eq!(amber, vec![DisplayStatus::Paused]);
        assert_eq!(
            serde_json::to_value(DisplayStatus::PermissionRequired).expect("json"),
            "permission_required"
        );
    }

    #[test]
    fn valid_layouts_pass_and_malformed_ones_are_refused() {
        let good = layout(PaneNode::Split {
            axis: SplitAxis::Horizontal,
            ratios: vec![500, 500],
            children: vec![leaf("a"), leaf("b")],
        });
        assert_eq!(good.validate(), Ok(()));
        let json = serde_json::to_value(&good).expect("json");
        assert_eq!(json["root"]["kind"], "split");
        assert_eq!(json["root"]["children"][0]["paneId"], "a");
        let back: PaneLayout = serde_json::from_value(json).expect("back");
        assert_eq!(back, good);

        let bad_ratio = layout(PaneNode::Split {
            axis: SplitAxis::Vertical,
            ratios: vec![600, 500],
            children: vec![leaf("a"), leaf("b")],
        });
        assert_eq!(bad_ratio.validate(), Err(LayoutError::BadRatios));
        let duplicate = layout(PaneNode::Split {
            axis: SplitAxis::Vertical,
            ratios: vec![500, 500],
            children: vec![leaf("a"), leaf("a")],
        });
        assert_eq!(duplicate.validate(), Err(LayoutError::BadPaneId));
        let lonely = layout(PaneNode::Split {
            axis: SplitAxis::Vertical,
            ratios: vec![1000],
            children: vec![leaf("a")],
        });
        assert_eq!(lonely.validate(), Err(LayoutError::BadSplit));
        let mut wrong_version = layout(leaf("a"));
        wrong_version.schema_version = 2;
        assert_eq!(
            wrong_version.validate(),
            Err(LayoutError::UnsupportedVersion(2))
        );
        let mut missing_max = layout(leaf("a"));
        missing_max.maximized_pane_id = Some("zzz".into());
        assert_eq!(
            missing_max.validate(),
            Err(LayoutError::UnknownMaximizedPane)
        );
        let tab_out_of_range = layout(PaneNode::Leaf {
            pane_id: "a".into(),
            tabs: vec![PaneContent::Dashboard],
            active_tab: 1,
            collapsed: false,
        });
        assert_eq!(tab_out_of_range.validate(), Err(LayoutError::BadActiveTab));
        let mut deep = leaf("x");
        for i in 0..MAX_PANE_DEPTH {
            deep = PaneNode::Split {
                axis: SplitAxis::Horizontal,
                ratios: vec![500, 500],
                children: vec![deep, leaf(&format!("p{i}"))],
            };
        }
        assert_eq!(layout(deep).validate(), Err(LayoutError::TooDeep));
    }

    /// The body lines of `export const <name> = {` … `} as const` in a TypeScript source.
    fn ts_table<'a>(source: &'a str, name: &str) -> Vec<&'a str> {
        let start = source
            .find(&format!("export const {name} = {{"))
            .unwrap_or_else(|| panic!("{name} missing"));
        let body = &source[start..];
        let end = body.find("} as const").expect("end of table");
        body[..end]
            .lines()
            .skip(1)
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect()
    }

    fn ts_string(value: &str) -> Option<String> {
        let value = value.trim().trim_end_matches(',');
        (value != "null").then(|| value.trim_matches('"').to_owned())
    }

    fn wire<T: Serialize>(value: T) -> String {
        serde_json::to_value(value)
            .expect("json")
            .as_str()
            .expect("string")
            .to_owned()
    }

    /// `packages/protocol/src/display-status.ts` is the TypeScript side of the one mapping; it
    /// must equal `ThreadStatus::display` / `chip`, `DisplayStatus::tone` / `label` exactly.
    #[test]
    fn protocol_package_mirror_is_identical() {
        use crate::threads::ThreadStatus;
        let ts = include_str!("../../../packages/protocol/src/display-status.ts");

        let rows = ts_table(ts, "DISPLAY_STATUS_OF");
        assert_eq!(rows.len(), ThreadStatus::ALL.len());
        for (status, row) in ThreadStatus::ALL.into_iter().zip(rows) {
            let (key, rest) = row.split_once(": {").expect("row");
            assert_eq!(key, wire(status));
            let fields: Vec<(&str, Option<String>)> = rest
                .trim_end_matches(',')
                .trim_end_matches('}')
                .split(',')
                .filter_map(|f| f.split_once(':'))
                .map(|(k, v)| (k.trim(), ts_string(v)))
                .collect();
            let (display, qualifier) = status.display();
            assert_eq!(fields[0], ("status", Some(wire(display))), "{key}");
            assert_eq!(fields[1], ("qualifier", qualifier.map(wire)), "{key}");
            assert_eq!(fields[2], ("chip", Some(wire(status.chip()))), "{key}");
        }

        let tones = ts_table(ts, "DISPLAY_STATUS_TONE");
        let labels = ts_table(ts, "DISPLAY_STATUS_LABEL");
        assert_eq!(tones.len(), DisplayStatus::ALL.len());
        assert_eq!(labels.len(), DisplayStatus::ALL.len());
        for ((display, tone), label) in DisplayStatus::ALL.into_iter().zip(tones).zip(labels) {
            let (key, value) = tone.split_once(": ").expect("tone");
            assert_eq!(key, wire(display));
            assert_eq!(ts_string(value), Some(wire(display.tone())), "{key}");
            let (key, value) = label.split_once(": ").expect("label");
            assert_eq!(key, wire(display));
            assert_eq!(ts_string(value).as_deref(), Some(display.label()), "{key}");
        }
        let qualifiers = ts_table(ts, "DISPLAY_QUALIFIER_LABEL");
        for (qualifier, row) in [
            DisplayQualifier::WaitingOnDependency,
            DisplayQualifier::StoppedResumable,
        ]
        .into_iter()
        .zip(qualifiers)
        {
            let (key, value) = row.split_once(": ").expect("qualifier");
            assert_eq!(key, wire(qualifier));
            assert_eq!(ts_string(value).as_deref(), Some(qualifier.label()));
        }
    }
}
