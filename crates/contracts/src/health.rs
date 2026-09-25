//! Provider Health + Capacity (PH, `docs/PROVIDER_HEALTH.md`, `docs/CONTRACTS_ADVANCED.md` §6.1).
//!
//! A live, low-overhead view of each provider: what detection last found (installed, version
//! against the adapter's minimum, sign-in state as the provider reports it), what KalCode
//! observed from real sessions (active sessions, time to first output, recent failures), and
//! rate-limit state **only when the provider reported one in a documented, structured shape**.
//! Nothing here is estimated or invented: unknown values stay unknown.
//!
//! Additive to v1 (PROVIDERS-2). Consumers (Scheduler, Hot-Swap, missions, Command Center, the
//! Environment Doctor) read these types through one API instead of probing providers again.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::agent::{AuthState, DetectionState, ModelInfo, ProviderId};

/// Overall health of one provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HealthState {
    /// Installed at a supported version, not known to be signed out, and recent sessions are
    /// working.
    Healthy,
    /// Usable, but recent sessions failed or the provider reported a rate limit.
    Degraded,
    /// Can't run sessions: not installed, outdated, signed out, or detection failed.
    Unavailable,
    /// Not checked yet, or the health subsystem itself failed. Never blocks a thread.
    Unknown,
}

/// Whether the provider can take more work right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CapacityState {
    Available,
    /// At a concurrency limit KalCode knows about. KalCode sets no provider limit today, so
    /// this appears only when a limit is configured.
    Saturated,
    /// The provider reported a rate limit or quota error; new work should wait.
    BackingOff,
    Unknown,
}

/// What would make an unhealthy provider healthy again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Recoverability {
    /// Nothing to recover.
    None,
    /// Expected to recover on its own (a reported rate limit expiring, transient failures).
    Automatic,
    /// Sign in with the provider's own command.
    SignIn,
    /// Update the provider CLI.
    Update,
    /// Install the provider CLI.
    Install,
    /// Restart the affected thread (or check the provider again).
    Restart,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HealthTrend {
    Improving,
    Stable,
    Worsening,
    /// Fewer than two hours with observations.
    InsufficientData,
}

/// The most recent failure KalCode observed in a session (codes only; never provider output).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HealthFailure {
    /// The normalized error code, e.g. `process_exited`, `api_rate_limit`.
    pub code: String,
    pub at: String,
}

/// The health of one provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderHealth {
    pub provider_id: ProviderId,
    pub display_name: String,
    pub state: HealthState,
    /// `None` until the provider has been detected.
    pub detection: Option<DetectionState>,
    /// As the provider reports it through its documented status command; `unknown` when it
    /// documents none (Gemini CLI).
    pub auth: AuthState,
    /// Display label of the connected account. KalCode never reads account details from a
    /// provider, so this is `None` until API-key accounts exist.
    pub account_label: Option<String>,
    pub version: Option<String>,
    /// The adapter's minimum supported version, when one is declared.
    pub minimum_version: Option<String>,
    pub models: Vec<ModelInfo>,
    /// At least one session process of this provider is running.
    pub process_running: bool,
    pub active_sessions: u32,
    /// Time from sending input to the first provider output, observed over the last 15 minutes.
    pub latency_p50_ms: Option<u32>,
    pub latency_p95_ms: Option<u32>,
    pub latency_samples: u32,
    /// Session failures observed in the last 60 minutes.
    pub recent_failures: u32,
    pub last_failure: Option<HealthFailure>,
    pub capacity: CapacityState,
    /// Only when the provider reported when to retry. Never estimated.
    pub backoff_until: Option<String>,
    pub trend: HealthTrend,
    pub recoverability: Recoverability,
    /// Stable machine code for the current state, e.g. `signed_out`, `rate_limited`.
    pub reason_code: Option<String>,
    /// User-safe explanation of the current state.
    pub reason: Option<String>,
    /// When the detection this is based on ran.
    pub checked_at: Option<String>,
    pub observed_at: String,
}

/// One hour of observations for trend views (`provider_health_trend`). Kept in memory for 30
/// days; persistence arrives with the PH rollup table (v13).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HealthRollup {
    pub provider_id: ProviderId,
    pub hour_start: String,
    pub sessions_started: u32,
    pub failures: u32,
    pub backoffs: u32,
    pub latency_p50_ms: Option<u32>,
    pub latency_p95_ms: Option<u32>,
    pub samples: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_states_are_snake_case_on_the_wire() {
        assert_eq!(
            serde_json::to_string(&CapacityState::BackingOff).expect("json"),
            "\"backing_off\""
        );
        assert_eq!(
            serde_json::to_string(&HealthTrend::InsufficientData).expect("json"),
            "\"insufficient_data\""
        );
        assert_eq!(
            serde_json::to_string(&Recoverability::SignIn).expect("json"),
            "\"sign_in\""
        );
    }
}
