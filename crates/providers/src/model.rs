//! Z2-local IPC types. The provider contract itself (`ProviderDetection`, `ProviderCapabilities`,
//! `PermissionMapping`, ...) lives in `kalcode_contracts::agent`; these types only add what the
//! Providers surface needs around it. Exported to TypeScript with ts-rs.

use kalcode_contracts::agent::{ProviderCapabilities, ProviderDetection, ProviderId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where a provider's model list comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ModelSource {
    /// Discovered from the authenticated provider's supported runtime command.
    Runtime,
    /// Aliases published in the provider's documentation; the provider resolves them.
    DocumentedAliases,
    /// The provider can't list models without starting a session; none are shown.
    NotDiscoverable,
}

/// Whether KalCode has a working adapter for the provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AdapterState {
    /// The native adapter is implemented and tested; threads use it from Z3.
    Implemented,
    /// Detection and research only; the adapter is built in a later campaign.
    Planned,
}

/// A managed runtime that passed local capability and policy checks. Machine installation
/// detection remains separate; account authentication is still checked when selecting an account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ManagedRuntimeReadiness {
    pub version: String,
    pub source: String,
}

/// Everything the Providers surface shows for one provider. Capability flags describe what
/// KalCode's adapter does, not only what the provider documents: a flag is `true` only when
/// KalCode implements it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderStatus {
    pub id: ProviderId,
    pub display_name: String,
    /// `None` until the first detection has run.
    pub detection: Option<ProviderDetection>,
    /// Stable machine code when the last detection ended in `error`, e.g. `version_timeout`.
    pub detection_error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub managed_runtime: Option<ManagedRuntimeReadiness>,
    /// The documented command KalCode runs to read the sign-in state, e.g. `claude auth
    /// status`; `None` when the provider documents no side-effect-free way to check.
    pub auth_check: Option<String>,
    pub capabilities: ProviderCapabilities,
    pub adapter: AdapterState,
    pub model_source: ModelSource,
    /// The documented integration surface KalCode uses or will use, in plain language.
    pub integration: String,
    /// How the user signs in with the provider's own CLI. KalCode never handles the login.
    pub sign_in_command: String,
    /// How the provider documents installing it on this platform.
    pub install_command: String,
    /// The provider's official documentation.
    pub docs_url: String,
}
