//! Provider-independent, account- and workspace-scoped project knowledge.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MemoryCategory {
    Project,
    Decisions,
    Architecture,
    Conventions,
    Product,
    RecentContext,
    KnownIssues,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MemorySourceKind {
    User,
    Agent,
    Brainstorm,
    Run,
    Instructions,
    Handoff,
    Merge,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MemoryRecord {
    pub id: String,
    pub workspace_id: String,
    pub category: MemoryCategory,
    pub title: String,
    pub content: String,
    pub pinned: bool,
    pub permanent: bool,
    pub source_kind: MemorySourceKind,
    pub source_id: Option<String>,
    pub file_path: Option<String>,
    pub file_hash: Option<String>,
    pub commit_id: Option<String>,
    pub stale: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MemoryInput {
    pub category: MemoryCategory,
    pub title: String,
    pub content: String,
    pub pinned: bool,
    pub permanent: bool,
    pub source_kind: MemorySourceKind,
    pub source_id: Option<String>,
    pub file_path: Option<String>,
    pub commit_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MemorySettings {
    pub auto_capture: bool,
    pub sharing_enabled: bool,
}

impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            auto_capture: true,
            sharing_enabled: true,
        }
    }
}
