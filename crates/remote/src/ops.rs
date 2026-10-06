//! Operations (§5): the complete allowlist, typed arguments and typed results.
//!
//! [`crate::server::serve_connection`] refuses any `op` not in [`ALL`] before the host sees it.
//! Hosts may parse arguments with [`Op::parse`] and build results with the types here, then
//! serialize them with `serde_json::to_value`.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

use crate::wire::{RemoteAgent, RemoteError, RemoteRun, RemoteWorkspace};

pub const AGENT_DETAIL: &str = "agent.detail";
pub const AGENT_DIFF: &str = "agent.diff";
pub const AGENT_LOG: &str = "agent.log";
pub const AGENT_PROMPT: &str = "agent.prompt";
pub const AGENT_STOP: &str = "agent.stop";
pub const AGENT_RETRY: &str = "agent.retry";
pub const AGENT_LAUNCH: &str = "agent.launch";
pub const LAUNCH_OPTIONS: &str = "launch.options";
pub const NEEDS_DECIDE: &str = "needs.decide";
pub const VOICE_COMMAND: &str = "voice.command";
pub const RUN_DETAIL: &str = "run.detail";
pub const TIDY_CLOSE_IDLE: &str = "tidy.closeIdle";

/// Every operation that exists. Nothing else is accepted.
pub const ALL: [&str; 12] = [
    AGENT_DETAIL,
    AGENT_DIFF,
    AGENT_LOG,
    AGENT_PROMPT,
    AGENT_STOP,
    AGENT_RETRY,
    AGENT_LAUNCH,
    LAUNCH_OPTIONS,
    NEEDS_DECIDE,
    VOICE_COMMAND,
    RUN_DETAIL,
    TIDY_CLOSE_IDLE,
];

/// Whether `op` is in the allowlist.
pub fn is_known(op: &str) -> bool {
    ALL.contains(&op)
}

/// A parsed request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    AgentDetail(AgentRef),
    AgentDiff(DiffArgs),
    AgentLog(LogArgs),
    AgentPrompt(PromptArgs),
    AgentStop(AgentRef),
    AgentRetry(AgentRef),
    AgentLaunch(LaunchArgs),
    LaunchOptions,
    NeedsDecide(DecideArgs),
    VoiceCommand(VoiceArgs),
    RunDetail(RunRef),
    TidyCloseIdle,
}

impl Op {
    /// Parses `op` + `args`; unknown ops and bad arguments are `invalid`.
    pub fn parse(op: &str, args: Value) -> Result<Self, RemoteError> {
        Ok(match op {
            AGENT_DETAIL => Self::AgentDetail(args_of(args)?),
            AGENT_DIFF => Self::AgentDiff(args_of(args)?),
            AGENT_LOG => Self::AgentLog(args_of(args)?),
            AGENT_PROMPT => Self::AgentPrompt(args_of(args)?),
            AGENT_STOP => Self::AgentStop(args_of(args)?),
            AGENT_RETRY => Self::AgentRetry(args_of(args)?),
            AGENT_LAUNCH => Self::AgentLaunch(args_of(args)?),
            LAUNCH_OPTIONS => Self::LaunchOptions,
            NEEDS_DECIDE => Self::NeedsDecide(args_of(args)?),
            VOICE_COMMAND => Self::VoiceCommand(args_of(args)?),
            RUN_DETAIL => Self::RunDetail(args_of(args)?),
            TIDY_CLOSE_IDLE => Self::TidyCloseIdle,
            other => return Err(RemoteError::invalid(format!("unknown operation {other}"))),
        })
    }
}

fn args_of<T: DeserializeOwned>(args: Value) -> Result<T, RemoteError> {
    serde_json::from_value(args).map_err(|e| RemoteError::invalid(format!("bad arguments: {e}")))
}

// ---- arguments ------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    pub agent_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffArgs {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogArgs {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptArgs {
    pub agent_id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchArgs {
    pub workspace_id: String,
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
}

/// Remote can only approve once or deny.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    ApproveOnce,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecideArgs {
    pub approval_id: String,
    pub decision: Decision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceArgs {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRef {
    pub run_id: String,
}

// ---- results --------------------------------------------------------------------------------

/// `{summary}`: agent.prompt, agent.stop, agent.retry, tidy.closeIdle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Summary {
    pub summary: String,
}

/// agent.detail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentDetail {
    pub agent: RemoteAgent,
    pub messages: Vec<AgentMessage>,
    pub tools: Vec<ToolCall>,
    /// The agent's worktree, or null when it works in the workspace directly.
    pub worktree: Option<WorktreeInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentMessage {
    /// `user` | `assistant` | `system`.
    pub role: String,
    pub text: String,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub name: String,
    pub summary: String,
    /// `running` | `succeeded` | `failed` | `denied`.
    pub status: String,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub base_branch: Option<String>,
}

/// agent.diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffResult {
    pub files: Vec<DiffFile>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffFile {
    pub path: String,
    /// `added` | `modified` | `deleted` | `renamed`.
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffHunk {
    /// `@@ -a,b +c,d @@ context`.
    pub header: String,
    /// `[kind, text]` pairs.
    pub lines: Vec<(DiffLineKind, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffLineKind {
    Add,
    Del,
    Ctx,
}

/// agent.log: one page, newest last; `more` when older entries exist (pass the first
/// entry's id as `beforeId`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogPage {
    pub entries: Vec<LogEntry>,
    pub more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub id: String,
    /// `message` | `tool` | `output` | `status`.
    pub kind: String,
    pub text: String,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

/// agent.launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub summary: String,
}

/// launch.options. Labels only: never credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchOptions {
    pub workspaces: Vec<RemoteWorkspace>,
    pub providers: Vec<LaunchProvider>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchProvider {
    pub id: String,
    pub name: String,
    pub accounts: Vec<LaunchAccount>,
    pub models: Vec<LaunchModel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchAccount {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchModel {
    pub id: String,
    pub name: String,
    pub efforts: Vec<String>,
}

/// needs.decide: `approved` | `denied` | `already_answered`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecideResult {
    pub status: String,
}

/// voice.command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceResult {
    pub summary: String,
    /// `done` | `partial` | `refused` | `clarify`.
    pub outcome: String,
}

/// run.detail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunDetail {
    pub run: RemoteRun,
    /// Recent log lines, oldest first.
    pub logs: Vec<String>,
    pub tests: Vec<TestResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub name: String,
    /// `passed` | `failed` | `skipped` | `running`.
    pub status: String,
    pub duration_ms: Option<u64>,
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]
    use serde_json::json;

    use super::*;
    use crate::wire::ErrorCode;

    #[test]
    fn parses_known_ops_and_refuses_others() {
        assert_eq!(
            Op::parse(
                NEEDS_DECIDE,
                json!({"approvalId":"apr_1","decision":"approve_once"})
            )
            .unwrap(),
            Op::NeedsDecide(DecideArgs {
                approval_id: "apr_1".into(),
                decision: Decision::ApproveOnce
            })
        );
        assert_eq!(
            Op::parse(LAUNCH_OPTIONS, Value::Null).unwrap(),
            Op::LaunchOptions
        );
        // "approve always" does not exist on Remote.
        let err = Op::parse(
            NEEDS_DECIDE,
            json!({"approvalId":"a","decision":"approve_always"}),
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert_eq!(
            Op::parse("shell.exec", json!({})).unwrap_err().code,
            ErrorCode::Invalid
        );
        assert!(ALL.iter().all(|op| is_known(op)));
    }

    #[test]
    fn diff_lines_are_pairs() {
        let hunk = DiffHunk {
            header: "@@ -1 +1 @@".into(),
            lines: vec![(DiffLineKind::Add, "x".into())],
        };
        assert_eq!(
            serde_json::to_value(hunk).unwrap(),
            json!({"header":"@@ -1 +1 @@","lines":[["add","x"]]})
        );
    }
}
