//! IPC shapes of the layout store.

use kalcode_contracts::workspace_ui::PaneLayout;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A workspace's saved pane layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceLayout {
    pub workspace_id: String,
    pub schema_version: u32,
    pub layout: PaneLayout,
    pub updated_at: String,
}

/// A layout shape the user saved under a name. Only the split tree and its sizes are kept:
/// panes are empty, nothing is maximized or collapsed, the dock is empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SavedLayoutPreset {
    pub id: String,
    pub name: String,
    pub schema_version: u32,
    pub layout: PaneLayout,
    pub created_at: String,
}
