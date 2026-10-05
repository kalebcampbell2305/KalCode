//! The one KalCode agent-state model (owner directive 2026-10-04: agent status is
//! provider-agnostic).
//!
//! An agent is a real coding terminal session (Claude Code, Codex, Cursor, Gemini CLI and every
//! future provider), never a Thread. Each provider adapter maps its own native session events
//! (hooks, notify, process lifecycle) into the shared [`ThreadStatus`] runtime state; this module
//! is the single projection from that runtime state to what every agent surface shows and
//! filters by: the Agents tab and Fleet, Code, What's Happening, Needs You, counters, KalTidy and
//! KalVoice. Nothing here looks at the provider: the same facts give the same state for every
//! provider. Mirrored by `packages/protocol/src/agent-state.ts` (a test keeps the two identical).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::threads::ThreadStatus;

/// The runtime's activity for an agent whose session has just come up at its prompt and has not
/// been given work yet (a provider's session-start signal, or the spawn itself). Any later
/// transition replaces it, so it never outlives the first turn.
pub const READY_ACTIVITY: &str = "Ready for a task";

/// The runtime's activity for an idle agent whose last turn failed.
pub const LAST_TURN_FAILED_ACTIVITY: &str = "Last turn failed";

/// What a coding agent is doing, the same words for every provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentState {
    /// The session is launching (or recovering) and isn't at its prompt yet.
    Starting,
    /// The session is up at its prompt and hasn't been given work yet.
    Ready,
    /// A turn is running: thinking, using tools, running commands, editing or reviewing.
    Working,
    /// A turn is running the project's tests.
    Testing,
    /// Blocked on something other than the person (another task, system resources).
    Waiting,
    /// Can't continue until the person answers: an approval or a reply.
    NeedsYou,
    /// At its prompt after work, or paused / offline: open, doing nothing.
    Idle,
    /// The session finished successfully.
    Done,
    /// The session or its last turn failed.
    Failed,
    /// The session was stopped before finishing (resumable).
    Stopped,
}

/// The status filters every agent list offers. They partition agents exactly (every agent is in
/// one group besides All), across every provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentFilter {
    All,
    NeedsYou,
    Working,
    Waiting,
    Idle,
    Done,
    Failed,
}

impl AgentState {
    /// Every state, in declaration order.
    pub const ALL: [AgentState; 10] = [
        Self::Starting,
        Self::Ready,
        Self::Working,
        Self::Testing,
        Self::Waiting,
        Self::NeedsYou,
        Self::Idle,
        Self::Done,
        Self::Failed,
        Self::Stopped,
    ];

    /// The state of an agent from its runtime facts: the status, the runtime's activity marker
    /// and its pending approvals. Provider-independent by construction.
    pub fn of(status: ThreadStatus, activity: Option<&str>, pending_approvals: u32) -> Self {
        if pending_approvals > 0 && !status.is_terminal() {
            return Self::NeedsYou;
        }
        Self::of_status(status, activity)
    }

    /// [`Self::of`] without approvals: the per-status row of the mapping table.
    pub fn of_status(status: ThreadStatus, activity: Option<&str>) -> Self {
        use ThreadStatus as S;
        match status {
            S::Starting | S::Recovering => Self::Starting,
            S::Active
            | S::Thinking
            | S::RunningTool
            | S::RunningCommand
            | S::Editing
            | S::Reviewing => Self::Working,
            S::Testing => Self::Testing,
            S::WaitingForPermission | S::WaitingForUser => Self::NeedsYou,
            S::WaitingForDependency => Self::Waiting,
            S::Idle => match activity {
                Some(READY_ACTIVITY) => Self::Ready,
                Some(LAST_TURN_FAILED_ACTIVITY) => Self::Failed,
                _ => Self::Idle,
            },
            S::Paused | S::Offline => Self::Idle,
            S::Completed => Self::Done,
            S::Failed => Self::Failed,
            S::Interrupted => Self::Stopped,
        }
    }

    /// The filter group the state belongs to.
    pub fn filter(self) -> AgentFilter {
        match self {
            Self::Starting | Self::Working | Self::Testing => AgentFilter::Working,
            Self::NeedsYou => AgentFilter::NeedsYou,
            Self::Waiting => AgentFilter::Waiting,
            Self::Ready | Self::Idle => AgentFilter::Idle,
            Self::Done | Self::Stopped => AgentFilter::Done,
            Self::Failed => AgentFilter::Failed,
        }
    }

    /// A turn or launch is in progress.
    pub fn is_busy(self) -> bool {
        matches!(self, Self::Starting | Self::Working | Self::Testing)
    }

    /// The uppercase word surfaces show ("Codex B · NEEDS YOU").
    pub fn label(self) -> &'static str {
        match self {
            Self::Starting => "STARTING",
            Self::Ready => "READY",
            Self::Working => "WORKING",
            Self::Testing => "TESTING",
            Self::Waiting => "WAITING",
            Self::NeedsYou => "NEEDS YOU",
            Self::Idle => "IDLE",
            Self::Done => "DONE",
            Self::Failed => "FAILED",
            Self::Stopped => "STOPPED",
        }
    }
}

impl AgentFilter {
    /// Every filter, in the order agent lists offer them.
    pub const ALL: [AgentFilter; 7] = [
        Self::All,
        Self::NeedsYou,
        Self::Working,
        Self::Waiting,
        Self::Done,
        Self::Idle,
        Self::Failed,
    ];

    /// Whether an agent in `state` shows under this filter.
    pub fn matches(self, state: AgentState) -> bool {
        self == Self::All || state.filter() == self
    }

    /// Lowercase words for spoken and summary text ("need you", "working").
    pub fn words(self) -> &'static str {
        match self {
            Self::All => "agents",
            Self::NeedsYou => "need you",
            Self::Working => "working",
            Self::Waiting => "waiting",
            Self::Idle => "idle",
            Self::Done => "done",
            Self::Failed => "failed",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire<T: Serialize>(value: T) -> String {
        serde_json::to_value(value)
            .expect("json")
            .as_str()
            .expect("string")
            .to_owned()
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
            .filter(|line| !line.is_empty() && !line.starts_with("//"))
            .collect()
    }

    fn ts_value(row: &str) -> (&str, String) {
        let (key, value) = row.split_once(": ").expect("row");
        (key.trim_matches('"'), value.trim_end_matches(',').trim_matches('"').to_owned())
    }

    #[test]
    fn activity_markers_refine_only_idle() {
        assert_eq!(
            AgentState::of_status(ThreadStatus::Idle, Some(READY_ACTIVITY)),
            AgentState::Ready
        );
        assert_eq!(
            AgentState::of_status(ThreadStatus::Idle, Some(LAST_TURN_FAILED_ACTIVITY)),
            AgentState::Failed
        );
        assert_eq!(AgentState::of_status(ThreadStatus::Idle, None), AgentState::Idle);
        assert_eq!(
            AgentState::of_status(ThreadStatus::Active, Some(READY_ACTIVITY)),
            AgentState::Working
        );
    }

    #[test]
    fn pending_approvals_need_you_until_the_session_ends() {
        assert_eq!(
            AgentState::of(ThreadStatus::RunningTool, None, 1),
            AgentState::NeedsYou
        );
        assert_eq!(AgentState::of(ThreadStatus::Completed, None, 1), AgentState::Done);
    }

    #[test]
    fn filters_partition_every_state() {
        for state in AgentState::ALL {
            let groups: Vec<_> = AgentFilter::ALL
                .into_iter()
                .filter(|f| *f != AgentFilter::All && f.matches(state))
                .collect();
            assert_eq!(groups.len(), 1, "{state:?}");
        }
    }

    /// `packages/protocol/src/agent-state.ts` is the TypeScript side of the one mapping.
    #[test]
    fn protocol_package_mirror_is_identical() {
        let ts = include_str!("../../../packages/protocol/src/agent-state.ts");

        let rows = ts_table(ts, "AGENT_STATE_OF_STATUS");
        assert_eq!(rows.len(), ThreadStatus::ALL.len());
        for (status, row) in ThreadStatus::ALL.into_iter().zip(rows) {
            let (key, value) = ts_value(row);
            assert_eq!(key, wire(status));
            assert_eq!(value, wire(AgentState::of_status(status, None)), "{key}");
        }

        let filters = ts_table(ts, "AGENT_STATE_FILTER");
        let labels = ts_table(ts, "AGENT_STATE_LABEL");
        assert_eq!(filters.len(), AgentState::ALL.len());
        assert_eq!(labels.len(), AgentState::ALL.len());
        for ((state, filter), label) in AgentState::ALL.into_iter().zip(filters).zip(labels) {
            let (key, value) = ts_value(filter);
            assert_eq!(key, wire(state));
            assert_eq!(value, wire(state.filter()), "{key}");
            let (key, value) = ts_value(label);
            assert_eq!(key, wire(state));
            assert_eq!(value, state.label(), "{key}");
        }

        for marker in [READY_ACTIVITY, LAST_TURN_FAILED_ACTIVITY] {
            assert!(ts.contains(&format!("\"{marker}\"")), "{marker}");
        }
    }
}
