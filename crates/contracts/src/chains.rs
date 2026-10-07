//! Agent Handoff Chains: ordered work passed between real coding agents.
//!
//! A chain is a relation over canonical Operations. Every step attempt is one Agent
//! [`crate::operations::OperationRecord`] (a real provider terminal and a Run/Queue item), and
//! the Operations runtime owns its queue, dependency wait, session and settlement. The chain
//! stores only what Operations cannot know: the goal, acceptance criteria, each step's intent,
//! the structured step report, and the person's explicit decisions (skip, record, cancel).
//! Phases are derived on every read and never persisted.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::operations::OperationRecord;

/// What a step is asked to do. The vocabulary extends single-step Hand Off with `Implement`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ChainStepIntent {
    Implement,
    Review,
    Fix,
    Test,
    Continue,
}

impl ChainStepIntent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Implement => "implement",
            Self::Review => "review",
            Self::Fix => "fix",
            Self::Test => "test",
            Self::Continue => "continue",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Implement => "Implement",
            Self::Review => "Review",
            Self::Fix => "Fix",
            Self::Test => "Test",
            Self::Continue => "Continue",
        }
    }

    /// Review and Test inspect the work; the receiving provider's permission mode still governs.
    pub fn read_only(self) -> bool {
        matches!(self, Self::Review | Self::Test)
    }
}

/// Where every step of a chain runs. Steps are sequential writers, so they share one tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ChainWorktree {
    /// One KalCode-managed worktree and branch, created by the first step and shared by the rest.
    Shared,
    /// The project's own checkout.
    Project,
}

impl ChainWorktree {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shared => "shared",
            Self::Project => "project",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChainStepDefinition {
    /// Stable key inside the chain (`implement`, `review-2`, ...).
    pub key: String,
    pub name: String,
    pub intent: ChainStepIntent,
    pub provider_id: String,
    pub provider_account_id: String,
    pub model: String,
    pub effort: String,
    pub instructions: Option<String>,
    /// Keys of earlier steps. Empty for the first step; several keys join parallel branches.
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChainStartRequest {
    /// Idempotency key: a retried start with the same inputs returns the same chain.
    pub request_id: String,
    pub workspace_id: String,
    pub name: String,
    pub goal: String,
    pub acceptance: Vec<String>,
    pub worktree: ChainWorktree,
    pub steps: Vec<ChainStepDefinition>,
}

/// A step's explicit outcome. Never inferred from terminal prose or an idle prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ChainStepResult {
    Passed,
    Failed,
    /// A review that asks for changes. The chain continues to the steps that address them.
    ChangesRequested,
}

impl ChainStepResult {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::ChangesRequested => "changes_requested",
        }
    }
}

/// Who recorded a step report: the step's own agent (its structured report file) or the person.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ChainReportSource {
    Agent,
    You,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChainTestRun {
    pub command: String,
    pub passed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChainStepReport {
    pub result: ChainStepResult,
    pub summary: String,
    pub tests: Vec<ChainTestRun>,
    pub blockers: Vec<String>,
    pub source: ChainReportSource,
    pub recorded_at: String,
}

/// Derived on read from the step's Operation, its report and the person's decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ChainStepPhase {
    /// Waiting for earlier steps to pass.
    Waiting,
    Starting,
    Working,
    /// The agent's turn ended without a step report: open it, answer it or record the outcome.
    NeedsReport,
    Passed,
    ChangesRequested,
    Failed,
    /// An earlier step failed or was cancelled; this step will not run until it is resolved.
    Blocked,
    Paused,
    Skipped,
    Cancelled,
    /// Newer merged work made this step obsolete; it was not executed.
    Superseded,
}

impl ChainStepPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Starting => "starting",
            Self::Working => "working",
            Self::NeedsReport => "needs_report",
            Self::Passed => "passed",
            Self::ChangesRequested => "changes_requested",
            Self::Failed => "failed",
            Self::Blocked => "blocked",
            Self::Paused => "paused",
            Self::Skipped => "skipped",
            Self::Cancelled => "cancelled",
            Self::Superseded => "superseded",
        }
    }

    /// The step's work is finished and its dependents may run.
    pub fn satisfied(self) -> bool {
        matches!(self, Self::Passed | Self::ChangesRequested | Self::Skipped)
    }

    pub fn settled(self) -> bool {
        matches!(
            self,
            Self::Passed
                | Self::ChangesRequested
                | Self::Failed
                | Self::Skipped
                | Self::Cancelled
                | Self::Superseded
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ChainPhase {
    Running,
    /// A step needs the person (a missing report, a provider question, or a reconnect).
    NeedsYou,
    Paused,
    /// A step failed; only its dependents are stopped.
    Blocked,
    /// Every step is satisfied: the branch is ready for the normal merge and ship pipeline.
    ReadyToMerge,
    Cancelled,
    Superseded,
}

impl ChainPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::NeedsYou => "needs_you",
            Self::Paused => "paused",
            Self::Blocked => "blocked",
            Self::ReadyToMerge => "ready_to_merge",
            Self::Cancelled => "cancelled",
            Self::Superseded => "superseded",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChainStep {
    pub key: String,
    pub name: String,
    pub intent: ChainStepIntent,
    pub instructions: Option<String>,
    pub depends_on: Vec<String>,
    pub position: u32,
    /// The current attempt's Operation (and therefore its provider terminal/thread id).
    pub operation_id: String,
    /// 1 for the first run; each Retry adds one.
    pub attempt: u32,
    pub phase: ChainStepPhase,
    /// Why the step is not running yet, in plain words ("Waiting for Review").
    pub waiting_reason: Option<String>,
    pub report: Option<ChainStepReport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Chain {
    pub id: String,
    pub name: String,
    pub goal: String,
    pub acceptance: Vec<String>,
    pub workspace_id: String,
    pub worktree: ChainWorktree,
    /// The shared worktree branch once the first step created it.
    pub branch: Option<String>,
    pub created_at: String,
    pub paused: bool,
    pub cancelled: bool,
    pub superseded_reason: Option<String>,
    pub phase: ChainPhase,
    /// The single most useful next action, in plain words ("Open Review to answer its question").
    pub next_action: Option<String>,
    pub steps: Vec<ChainStep>,
}

/// One coherent read model: chains plus exactly the Operations their steps point at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChainsSnapshot {
    pub chains: Vec<Chain>,
    pub operations: Vec<OperationRecord>,
}

/// A replacement provider configuration for a step that has not started, or for its retry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChainStepRoute {
    pub provider_id: String,
    pub provider_account_id: String,
    pub model: String,
    pub effort: String,
}
