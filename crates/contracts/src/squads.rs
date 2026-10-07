//! Reusable coding-agent Squads and their durable relationship to canonical Operations.
//!
//! A launched Squad never copies agent/session execution state. Each member points at the
//! [`crate::operations::OperationRecord`] that owns its queue, run, and session lifecycle.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::operations::OperationRecord;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SquadMemberDefinition {
    pub key: String,
    pub name: String,
    pub provider_id: String,
    pub provider_account_id: String,
    pub model: String,
    pub effort: String,
    pub role: String,
    /// Optional first task. `None` launches a real ready coding terminal without injected work.
    pub task: Option<String>,
    pub worktree: bool,
    pub depends_on: Vec<String>,
    pub manager_key: Option<String>,
    pub owned_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SquadDefinition {
    pub id: String,
    pub name: String,
    pub goal: String,
    pub members: Vec<SquadMemberDefinition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SquadRecipe {
    pub id: String,
    pub name: String,
    pub squad_id: String,
    pub goal: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SquadLaunchMember {
    pub key: String,
    pub role: String,
    pub manager_key: Option<String>,
    pub operation_id: String,
    pub owned_paths: Vec<String>,
}

/// Durable launch relation. Canonical Operations own every member's execution state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SquadLaunch {
    pub id: String,
    pub squad_id: String,
    pub name: String,
    pub goal: String,
    pub workspace_id: String,
    pub created_at: String,
    pub members: Vec<SquadLaunchMember>,
}

/// Launch-only metadata used by the canonical Operations runtime for one member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SquadOperationConfig {
    pub launch_id: String,
    pub squad_id: String,
    pub member_key: String,
    pub role: String,
    pub manager_key: Option<String>,
    pub manager_operation_id: Option<String>,
    pub worktree: bool,
    pub owned_paths: Vec<String>,
}

/// One coherent read model. `operations` is loaded by exact launch member identity and therefore
/// is not truncated by Operations' bounded general history projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SquadsSnapshot {
    pub squads: Vec<SquadDefinition>,
    pub recipes: Vec<SquadRecipe>,
    pub launches: Vec<SquadLaunch>,
    pub operations: Vec<OperationRecord>,
}
