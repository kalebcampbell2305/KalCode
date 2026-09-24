//! Application-level contract types.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BuildChannel {
    Stable,
    Beta,
    Development,
}

impl BuildChannel {
    /// Channel baked in at compile time via `KALCODE_CHANNEL` (default: development).
    pub fn current() -> Self {
        Self::parse(option_env!("KALCODE_CHANNEL").unwrap_or("development"))
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "stable" => Self::Stable,
            "beta" => Self::Beta,
            _ => Self::Development,
        }
    }
}
