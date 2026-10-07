//! Session resolution (0.1.5, terminal-aware KalVoice): one deterministic answer to "which
//! session does this name mean?", shared by KalVoice, the command palette and the Dashboard.
//!
//! A *session* is an open (not archived) thread. The resolver never guesses: a name that fits
//! more than one session is answered with a clarification ("Which one — Release Windows or
//! Release Mac?") and nothing happens until the person chooses. It never uses the Session
//! Locator (a gated surface); it reads only the thread store listing.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::ProviderId;
use crate::agent_state::{AgentFilter, AgentState};
use crate::threads::ThreadStatus;

/// Most choices a clarification offers. More matches than this ask for a longer name.
pub const MAX_SESSION_CHOICES: usize = 4;

/// Longest query the resolver accepts (Unicode scalar values); longer input is not a name.
pub const MAX_SESSION_QUERY_CHARS: usize = 200;

/// One open thread a query resolved to, or one choice in a clarification. Carries only what
/// may be shown or spoken: never a credential, an email or a provider identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionCandidate {
    pub thread_id: String,
    pub name: String,
    pub provider_id: ProviderId,
    pub provider_name: String,
    /// The thread's provider-account label ("Gemini B"); `null` for threads without one.
    pub account_label: Option<String>,
    /// Exact launch-time model selection. This is configuration, not proof of the active model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
    /// Provider-reported active model when the runtime exposes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_model: Option<String>,
    /// Exact launch-time reasoning selection. This is configuration, not proof of active effort.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort: Option<String>,
    /// Provider-reported active reasoning effort when the runtime exposes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_effort: Option<String>,
    pub workspace_id: String,
    pub workspace_name: String,
    pub status: ThreadStatus,
    /// Full provider/account/model/effort identity. Unreported configured values are marked
    /// `selected`; unknown active values are explicitly provider-controlled.
    pub label: String,
}

/// Which rule produced a unique answer (diagnostics and tests; never user text).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionMatchTier {
    /// The query was a thread id.
    ExplicitId,
    /// The exact name, in the workspace the person is looking at.
    ExactNameInWorkspace,
    /// The exact name, in any workspace.
    ExactName,
    /// Provider and/or account words plus the name ("Gemini B Research", "Claude Backend").
    ProviderAccountName,
    /// "this / that / it": the thread the person is looking at.
    Focused,
    /// "it" with nothing focused: the session the previous command resolved to.
    LastTarget,
    /// Only a provider (and/or account) was named, and exactly one open thread fits.
    ProviderOnly,
    /// A partial or slightly misspelt name that fits exactly one session.
    Fuzzy,
}

/// The resolver's answer for one query.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum SessionResolution {
    Resolved {
        target: SessionCandidate,
        tier: SessionMatchTier,
    },
    /// More than one session fits. `question` names the choices by the first thing that tells
    /// them apart ("Which one — Release Windows or Release Mac?"); `choices` holds at most
    /// [`MAX_SESSION_CHOICES`], current workspace first, then most recently active. `total` is
    /// how many sessions fit in all.
    Ambiguous {
        question: String,
        choices: Vec<SessionCandidate>,
        total: u32,
    },
    /// Nothing fits. `message` is user-safe and names no other session.
    NotFound { message: String },
}

/// A state KalVoice can look sessions up by ("focus the one waiting for permission",
/// "which agent failed?").
///
/// For coding agents ([`SessionScope::Agents`]) every state is read from the shared agent-state
/// model ([`Self::matches_agent`]), the same for every provider; for chat threads
/// ([`SessionScope::Threads`]) from the thread's own status ([`Self::matches`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionAttention {
    /// A permission request is pending.
    WaitingForPermission,
    /// The provider asked the person something (or a permission request is pending: both wait
    /// on the person).
    WaitingForYou,
    /// The session failed. For a coding agent this includes an agent whose last turn failed.
    Failed,
    /// Not failed, but not making progress. A coding agent is stuck when the shared model says
    /// WAITING (blocked on something other than the person); an offline agent is IDLE there and
    /// a recovering one STARTING, so neither is stuck. A chat thread is stuck while waiting on a
    /// dependency, recovering or offline.
    Stuck,
}

/// Which open sessions a state lookup ("which agent is stuck?", "which thread failed?") reads.
/// Agents and Threads are separate product concepts: an agent is a real coding terminal session
/// of any provider, never a chat thread.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionScope {
    /// Coding agents only (interactive provider terminals of every provider). The default:
    /// "which one is stuck", "what failed" and every phrase that names an agent, a terminal, a
    /// pane or a provider.
    #[default]
    Agents,
    /// Chat threads only: phrases that name a thread or a session.
    Threads,
}

impl SessionAttention {
    /// Whether a coding agent with these runtime facts is in this state, read from the shared
    /// agent-state model ([`AgentState::of`]): identical for every provider.
    pub fn matches_agent(
        self,
        status: ThreadStatus,
        activity: Option<&str>,
        pending_approvals: u32,
    ) -> bool {
        let state = AgentState::of(status, activity, pending_approvals);
        match self {
            Self::WaitingForPermission => {
                state == AgentState::NeedsYou
                    && (status == ThreadStatus::WaitingForPermission || pending_approvals > 0)
            }
            Self::WaitingForYou => state == AgentState::NeedsYou,
            Self::Failed => state == AgentState::Failed,
            Self::Stuck => state == AgentState::Waiting,
        }
    }

    /// The Agents tab group that shows every agent in this state.
    pub fn agent_filter(self) -> AgentFilter {
        match self {
            Self::WaitingForPermission | Self::WaitingForYou => AgentFilter::NeedsYou,
            Self::Failed => AgentFilter::Failed,
            Self::Stuck => AgentFilter::Waiting,
        }
    }

    /// Whether a chat thread in `status` is in this state.
    pub fn matches(self, status: ThreadStatus) -> bool {
        match self {
            Self::WaitingForPermission => status == ThreadStatus::WaitingForPermission,
            Self::WaitingForYou => status == ThreadStatus::WaitingForUser,
            Self::Failed => status == ThreadStatus::Failed,
            Self::Stuck => matches!(
                status,
                ThreadStatus::WaitingForDependency
                    | ThreadStatus::Recovering
                    | ThreadStatus::Offline
            ),
        }
    }

    /// Words for summaries and readback ("waiting for permission").
    pub fn phrase(self) -> &'static str {
        match self {
            Self::WaitingForPermission => "waiting for permission",
            Self::WaitingForYou => "waiting for you",
            Self::Failed => "failed",
            Self::Stuck => "stuck",
        }
    }
}

/// What happens to the session the person picks from a clarification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum SessionFollowUp {
    /// Open (focus) the chosen session.
    Open,
    /// Open the chosen session and put `text` in its composer; `submit` then presses the
    /// composer's own Send (prompt review and warnings still run, and a warned prompt stops at
    /// the dialog). `text` is transient: never stored, logged or spoken.
    Compose { text: String, submit: bool },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_is_tagged_camel_case() {
        let candidate = SessionCandidate {
            thread_id: "0192f3c4-0000-7000-8000-000000000001".into(),
            name: "Research".into(),
            provider_id: ProviderId::new(ProviderId::GEMINI_CLI),
            provider_name: "Gemini CLI".into(),
            account_label: Some("Gemini B".into()),
            model: Some("gemini-2.5-pro".into()),
            active_model: Some("gemini-2.5-pro-002".into()),
            effort: Some("high".into()),
            active_effort: None,
            workspace_id: "0192f3c4-0000-7000-8000-00000000a001".into(),
            workspace_name: "kalcode".into(),
            status: ThreadStatus::Idle,
            label: "Research · Gemini CLI · Gemini B".into(),
        };
        let resolved = serde_json::to_value(SessionResolution::Resolved {
            target: candidate.clone(),
            tier: SessionMatchTier::ProviderAccountName,
        })
        .expect("json");
        assert_eq!(resolved["kind"], "resolved");
        assert_eq!(resolved["tier"], "provider_account_name");
        assert_eq!(resolved["target"]["threadId"], candidate.thread_id);
        assert_eq!(resolved["target"]["accountLabel"], "Gemini B");
        assert_eq!(resolved["target"]["model"], "gemini-2.5-pro");
        assert_eq!(resolved["target"]["activeModel"], "gemini-2.5-pro-002");
        assert_eq!(resolved["target"]["effort"], "high");
        assert!(resolved["target"].get("activeEffort").is_none());
        let ambiguous = serde_json::to_value(SessionResolution::Ambiguous {
            question: "Which one?".into(),
            choices: vec![candidate],
            total: 1,
        })
        .expect("json");
        assert_eq!(ambiguous["kind"], "ambiguous");
        assert_eq!(ambiguous["total"], 1);
        let legacy: SessionCandidate = serde_json::from_value(serde_json::json!({
            "threadId": "t",
            "name": "Legacy",
            "providerId": "codex",
            "providerName": "Codex",
            "accountLabel": null,
            "workspaceId": "w",
            "workspaceName": "Workspace",
            "status": "idle",
            "label": "Legacy · Codex"
        }))
        .expect("legacy candidate");
        assert_eq!(legacy.model, None);
        assert_eq!(legacy.active_model, None);
        assert_eq!(legacy.effort, None);
        assert_eq!(legacy.active_effort, None);
        let missing = serde_json::to_value(SessionResolution::NotFound {
            message: "No session".into(),
        })
        .expect("json");
        assert_eq!(missing["kind"], "not_found");
    }

    #[test]
    fn attention_states_are_disjoint_and_cover_the_blocked_statuses() {
        let states = [
            SessionAttention::WaitingForPermission,
            SessionAttention::WaitingForYou,
            SessionAttention::Failed,
            SessionAttention::Stuck,
        ];
        for status in ThreadStatus::ALL {
            let hits = states.iter().filter(|s| s.matches(status)).count();
            assert!(hits <= 1, "{status:?} matches {hits} states");
        }
        assert!(SessionAttention::Stuck.matches(ThreadStatus::WaitingForDependency));
        assert!(!SessionAttention::Stuck.matches(ThreadStatus::Failed));
        assert!(!SessionAttention::Stuck.matches(ThreadStatus::Idle));
        assert_eq!(
            serde_json::to_value(SessionAttention::WaitingForPermission).expect("json"),
            "waiting_for_permission"
        );
    }

    #[test]
    fn agent_attention_reads_the_shared_agent_state_model() {
        use crate::agent_state::LAST_TURN_FAILED_ACTIVITY;
        use SessionAttention as A;
        let states = [
            A::WaitingForPermission,
            A::WaitingForYou,
            A::Failed,
            A::Stuck,
        ];
        for status in ThreadStatus::ALL {
            for pending in [0, 1] {
                let agent = AgentState::of(status, None, pending);
                for state in states {
                    // Every agent in a state is in that state's Agents tab group.
                    if state.matches_agent(status, None, pending) {
                        assert!(state.agent_filter().matches(agent), "{status:?} {state:?}");
                    }
                }
                // The groups that name exactly one shared state agree with it.
                assert_eq!(
                    A::Stuck.matches_agent(status, None, pending),
                    agent == AgentState::Waiting
                );
                assert_eq!(
                    A::WaitingForYou.matches_agent(status, None, pending),
                    agent == AgentState::NeedsYou
                );
                assert_eq!(
                    A::Failed.matches_agent(status, None, pending),
                    agent == AgentState::Failed
                );
            }
        }
        // Permission is the narrower Needs-you: a request is open, not a question.
        assert!(A::WaitingForPermission.matches_agent(ThreadStatus::WaitingForPermission, None, 0));
        assert!(A::WaitingForPermission.matches_agent(ThreadStatus::RunningTool, None, 1));
        assert!(!A::WaitingForPermission.matches_agent(ThreadStatus::WaitingForUser, None, 0));
        assert!(!A::WaitingForPermission.matches_agent(ThreadStatus::Completed, None, 1));
        // A failed last turn is a failed agent; offline and recovering agents are not stuck.
        assert!(A::Failed.matches_agent(ThreadStatus::Idle, Some(LAST_TURN_FAILED_ACTIVITY), 0));
        assert!(!A::Stuck.matches_agent(ThreadStatus::Offline, None, 0));
        assert!(!A::Stuck.matches_agent(ThreadStatus::Recovering, None, 0));
        assert!(A::Stuck.matches_agent(ThreadStatus::WaitingForDependency, None, 0));
        assert_eq!(
            serde_json::to_value(SessionScope::default()).expect("json"),
            "agents"
        );
    }

    #[test]
    fn follow_up_compose_is_tagged() {
        let json = serde_json::to_value(SessionFollowUp::Compose {
            text: "bump the version".into(),
            submit: true,
        })
        .expect("json");
        assert_eq!(json["kind"], "compose");
        assert_eq!(json["submit"], true);
        assert_eq!(
            serde_json::to_value(SessionFollowUp::Open).expect("json")["kind"],
            "open"
        );
    }
}
