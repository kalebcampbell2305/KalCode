//! `context.*` event facts, in the payload shapes of `docs/CONTRACTS_ADVANCED.md` §3.3. CA-1
//! declared the matching `EventPayload` variants; `EventPayload::from(ContextEvent)` maps them
//! one-to-one (payloads are ids and short facts only — never content).

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::events::EventPayload;
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

impl From<ContextEvent> for EventPayload {
    fn from(event: ContextEvent) -> Self {
        match event {
            ContextEvent::PackageCreated {
                package_id,
                purpose,
                items,
                bytes,
            } => EventPayload::ContextPackageCreated {
                package_id,
                purpose,
                items,
                bytes,
            },
            ContextEvent::Blocked {
                package_id,
                rule,
                items,
            } => EventPayload::ContextBlocked {
                package_id,
                rule,
                items,
            },
            ContextEvent::Redacted {
                package_id,
                items,
                spans,
            } => EventPayload::ContextRedacted {
                package_id,
                items,
                spans,
            },
            ContextEvent::OverrideConfirmed {
                package_id,
                position,
                rule,
            } => EventPayload::ContextOverrideConfirmed {
                package_id,
                position,
                rule,
            },
            ContextEvent::Shared {
                package_id,
                thread_id,
                provider_id,
                items,
                bytes,
                redactions,
            } => EventPayload::ContextShared {
                package_id,
                thread_id,
                provider_id: ProviderId::new(provider_id),
                items,
                bytes,
                redactions,
            },
            ContextEvent::Discarded { package_id } => EventPayload::ContextDiscarded { package_id },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ContextPurpose;

    /// The crate's facts carry exactly the contract payload: same type name, same fields.
    #[test]
    fn every_context_event_maps_to_the_contract_payload() {
        let events = [
            ContextEvent::PackageCreated {
                package_id: "p".into(),
                purpose: ContextPurpose::Handoff,
                items: 2,
                bytes: 3,
            },
            ContextEvent::Blocked {
                package_id: "p".into(),
                rule: "secret_detected".into(),
                items: 1,
            },
            ContextEvent::Redacted {
                package_id: "p".into(),
                items: 1,
                spans: 4,
            },
            ContextEvent::OverrideConfirmed {
                package_id: "p".into(),
                position: 0,
                rule: "ignored_path.gitignore".into(),
            },
            ContextEvent::Shared {
                package_id: "p".into(),
                thread_id: Some("t".into()),
                provider_id: "claude-code".into(),
                items: 1,
                bytes: 2,
                redactions: 0,
            },
            ContextEvent::Discarded {
                package_id: "p".into(),
            },
        ];
        for event in events {
            let mut ours = serde_json::to_value(&event).expect("json");
            let object = ours.as_object_mut().expect("object");
            let kind = object.remove("type").expect("type");
            let payload = EventPayload::from(event.clone());
            assert_eq!(kind, payload.type_name());
            assert_eq!(payload.type_name(), event.event_type());
            let wire = serde_json::to_value(&payload).expect("json");
            assert_eq!(wire["payload"], ours);
        }
    }
}
