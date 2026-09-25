//! `context.*` event facts, in the payload shapes proposed in `docs/CONTRACTS_ADVANCED.md`
//! §3.3. This crate does not touch `EventPayload`; the lead maps these one-to-one when the
//! CA-0 contract PR lands (payloads are ids and short facts only — never content).

use serde::{Deserialize, Serialize};

use crate::model::ContextPurpose;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum ContextEvent {
    #[serde(rename = "context.package_created")]
    PackageCreated {
        package_id: String,
        purpose: ContextPurpose,
        items: u32,
        bytes: u64,
    },
    #[serde(rename = "context.blocked")]
    Blocked {
        package_id: String,
        /// The most frequent blocking rule code.
        rule: String,
        items: u32,
    },
    #[serde(rename = "context.redacted")]
    Redacted {
        package_id: String,
        items: u32,
        spans: u32,
    },
    /// *Proposed addition*: a user confirmed an overridable item.
    #[serde(rename = "context.override_confirmed")]
    OverrideConfirmed {
        package_id: String,
        position: u32,
        rule: String,
    },
    #[serde(rename = "context.shared")]
    Shared {
        package_id: String,
        thread_id: Option<String>,
        provider_id: String,
        items: u32,
        bytes: u64,
        redactions: u32,
    },
    #[serde(rename = "context.discarded")]
    Discarded { package_id: String },
}

impl ContextEvent {
    pub fn event_type(&self) -> &'static str {
        match self {
            Self::PackageCreated { .. } => "context.package_created",
            Self::Blocked { .. } => "context.blocked",
            Self::Redacted { .. } => "context.redacted",
            Self::OverrideConfirmed { .. } => "context.override_confirmed",
            Self::Shared { .. } => "context.shared",
            Self::Discarded { .. } => "context.discarded",
        }
    }
}
