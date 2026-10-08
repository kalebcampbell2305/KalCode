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

/// One exact model choice reported for a provider account. Provider adapters preserve native
/// model and effort identifiers verbatim; KalCode does not maintain a vendor allowlist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderAccountModel {
    /// Exact provider-native value passed when the coding agent is launched.
    pub id: String,
    pub display_name: String,
    pub is_default: bool,
    /// Exact provider-native default when the provider advertises one.
    pub default_effort: Option<String>,
    /// Exact provider-native effort values supported by this model, in provider order.
    pub supported_efforts: Vec<String>,
}

/// Where an account-bound provider model catalog came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProviderModelCatalogSource {
    /// Discovered from the authenticated provider's supported runtime command.
    Runtime,
    /// Aliases published in the provider's documentation; the provider resolves them.
    DocumentedAliases,
    /// The provider does not expose a supported model-discovery path.
    NotDiscoverable,
}

/// Account-bound model catalog returned by the canonical provider adapter path.
///
/// Echoing both identities lets an asynchronous UI discard a response after an account switch
/// without trusting request timing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderAccountModelCatalog {
    pub account_id: String,
    pub provider_id: ProviderId,
    /// Provenance for this account catalog. Absent only when reading a legacy serialized value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source: Option<ProviderModelCatalogSource>,
    /// Adapter-owned picker fallback when no model-specific effort metadata is available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub supported_efforts: Option<Vec<String>>,
    pub models: Vec<ProviderAccountModel>,
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

/// Whether KalCode could read real provider quota usage for an account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProviderUsageStatus {
    /// Real provider-reported numbers, as of `checked_at`.
    Available,
    /// The provider doesn't expose plan usage for this account (Gemini CLI, API keys).
    Unavailable,
    /// Nothing readable yet: signed out, never run, reset since the last read, or unreadable.
    NotChecked,
}

/// One provider rate-limit window ("5-hour", "Weekly") as the provider last reported it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderUsageWindow {
    /// Stable id: `five_hour`, `weekly`, `weekly_opus`, `primary`, `secondary`…
    pub id: String,
    pub label: String,
    /// 0–100: how much of the window is left (100 − the provider's used percentage).
    pub remaining_percent: f64,
    /// RFC 3339 time the window resets, when the provider reports it.
    pub resets_at: Option<String>,
}

/// Credential-free quota usage for one provider account. Values are only ever copied from data
/// the provider itself recorded; KalCode never estimates them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderAccountUsage {
    pub account_id: String,
    pub status: ProviderUsageStatus,
    /// Provider plan label ("Max 20x", "Pro"), when the provider recorded one.
    pub plan: Option<String>,
    /// Most constrained window first. Empty unless `status` is `available`.
    pub windows: Vec<ProviderUsageWindow>,
    /// RFC 3339 time of the provider read the numbers came from.
    pub checked_at: Option<String>,
    /// Short user-facing reason when unavailable / not checked.
    pub reason: Option<String>,
}
