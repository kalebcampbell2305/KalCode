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
    pub workspace_id: String,
    pub workspace_name: String,
    pub status: ThreadStatus,
    /// "Name · Provider · Account" (the account part is left out when the thread has none).
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionAttention {
    /// A permission request is pending.
    WaitingForPermission,
    /// The provider asked the person something.
    WaitingForYou,
    Failed,
    /// Not failed, but not making progress: waiting on a dependency, recovering or offline.
    Stuck,
}

impl SessionAttention {
    /// Whether a thread in `status` is in this state.
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
        let ambiguous = serde_json::to_value(SessionResolution::Ambiguous {
            question: "Which one?".into(),
            choices: vec![candidate],
            total: 1,
        })
        .expect("json");
        assert_eq!(ambiguous["kind"], "ambiguous");
        assert_eq!(ambiguous["total"], 1);
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
