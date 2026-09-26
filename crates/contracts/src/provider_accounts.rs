//! Public metadata for provider accounts and account-binding resolution.
//!
//! These contracts contain no credentials and no native profile paths. Provider-reported
//! identity is informational metadata populated only by trusted adapter code.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::{AuthState, ProviderId};

/// Maximum user-visible account label length in Unicode scalar values.
pub const MAX_ACCOUNT_LABEL_CHARS: usize = 80;
/// Maximum provider-reported identity length in Unicode scalar values.
pub const MAX_PROVIDER_IDENTITY_CHARS: usize = 320;
/// Maximum stable provider error-code length.
pub const MAX_PROVIDER_ERROR_CODE_CHARS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderAccount {
    pub id: String,
    pub provider_id: ProviderId,
    /// Local owner-chosen label. This is never inferred from provider output.
    pub display_name: String,
    /// Informational identity returned by an official provider adapter, when available.
    pub provider_reported_identity: Option<String>,
    pub authentication_state: AuthState,
    pub is_default: bool,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub last_checked_at: Option<String>,
    pub last_error_code: Option<String>,
    /// Set when removed from active account selection. Provider profiles and auth remain intact.
    pub archived_at: Option<String>,
}

/// Scope that may select an account for a provider operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProviderAccountBindingKind {
    Workspace,
    Agent,
    Mission,
    Thread,
    ProviderProfile,
}

impl ProviderAccountBindingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Agent => "agent",
            Self::Mission => "mission",
            Self::Thread => "thread",
            Self::ProviderProfile => "provider_profile",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "workspace" => Some(Self::Workspace),
            "agent" => Some(Self::Agent),
            "mission" => Some(Self::Mission),
            "thread" => Some(Self::Thread),
            "provider_profile" => Some(Self::ProviderProfile),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderAccountBinding {
    pub provider_id: ProviderId,
    pub kind: ProviderAccountBindingKind,
    pub scope_id: String,
    pub account_id: String,
}

/// Candidate scope IDs for deterministic account resolution. Resolution order is thread,
/// mission, agent, workspace, provider profile, then the provider default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderAccountScopes {
    pub workspace_id: Option<String>,
    pub agent_id: Option<String>,
    pub mission_id: Option<String>,
    pub thread_id: Option<String>,
    pub provider_profile_id: Option<String>,
}
