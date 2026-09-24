//! KalCode Event Protocol v1 (docs/EVENT_PROTOCOL.md): persistence and live delivery.

mod bus;
mod store;

pub use bus::{EventBus, SubscriptionId};
pub use store::EventStore;

// Event types are shared contracts (crates/contracts); this module stores and delivers them.
pub use kalcode_contracts::events::{
    Correlation, EventEnvelope, EventPayload, EventSource, NewEvent,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flags::BuildChannel;

    fn envelope(event: EventPayload) -> EventEnvelope {
        EventEnvelope {
            id: "0192f3c4-0000-7000-8000-000000000000".into(),
            seq: 7,
            version: event.version(),
            occurred_at: "2026-09-24T18:02:11.412Z".into(),
            source: EventSource::Core,
            correlation: Correlation::default(),
            event,
        }
    }

    #[test]
    fn envelope_wire_format_is_flat() {
        let json = serde_json::to_value(envelope(EventPayload::SettingsChanged {
            keys: vec!["appearance.theme".into()],
        }))
        .expect("serialize");
        assert_eq!(json["type"], "settings.changed");
        assert_eq!(json["payload"]["keys"][0], "appearance.theme");
        assert_eq!(json["seq"], 7);
        assert_eq!(json["occurredAt"], "2026-09-24T18:02:11.412Z");
        assert_eq!(json["correlation"]["threadId"], serde_json::Value::Null);
    }

    #[test]
    fn payload_fields_are_camel_case() {
        let json = serde_json::to_value(EventPayload::DatabaseMigrated {
            from_version: 1,
            to_version: 2,
            backup_created: true,
        })
        .expect("serialize");
        assert_eq!(json["payload"]["fromVersion"], 1);
        assert_eq!(json["payload"]["backupCreated"], true);
    }

    #[test]
    fn envelope_round_trips() {
        let original = envelope(EventPayload::AppStarted {
            version: "0.1.0".into(),
            channel: BuildChannel::Development,
            platform: "windows".into(),
            arch: "x86_64".into(),
        });
        let json = serde_json::to_string(&original).expect("serialize");
        let back: EventEnvelope = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, original);
    }

    #[test]
    fn type_names_match_serde_tags() {
        let samples = [
            EventPayload::AppStarted {
                version: String::new(),
                channel: BuildChannel::Stable,
                platform: String::new(),
                arch: String::new(),
            },
            EventPayload::AppStopped { uptime_ms: 1 },
            EventPayload::PreviousSessionInterrupted {
                last_event_at: String::new(),
            },
            EventPayload::DatabaseMigrated {
                from_version: 0,
                to_version: 1,
                backup_created: false,
            },
            EventPayload::SettingsChanged { keys: vec![] },
            EventPayload::SecureStoreChecked {
                ok: true,
                backend: String::new(),
            },
            EventPayload::Unrecognized {
                original_type: "x".into(),
                original_version: 1,
            },
        ];
        for sample in samples {
            let json = serde_json::to_value(&sample).expect("serialize");
            assert_eq!(json["type"], sample.type_name());
        }
    }
}
