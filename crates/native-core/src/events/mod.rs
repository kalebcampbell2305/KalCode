//! KalCode Event Protocol v1 (docs/EVENT_PROTOCOL.md).

mod bus;
mod store;

pub use bus::{EventBus, SubscriptionId};
pub use store::EventStore;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::flags::BuildChannel;

/// Where an event originated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EventSource {
    Core,
    Ui,
    Provider,
    Jarvis,
    Supervisor,
    Automation,
}

impl EventSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Ui => "ui",
            Self::Provider => "provider",
            Self::Jarvis => "jarvis",
            Self::Supervisor => "supervisor",
            Self::Automation => "automation",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "ui" => Self::Ui,
            "provider" => Self::Provider,
            "jarvis" => Self::Jarvis,
            "supervisor" => Self::Supervisor,
            "automation" => Self::Automation,
            _ => Self::Core,
        }
    }
}

/// Optional identifiers that relate an event to KalCode entities. Indexed in storage.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Correlation {
    pub workspace_id: Option<String>,
    pub thread_id: Option<String>,
    pub mission_id: Option<String>,
    pub provider_id: Option<String>,
    pub request_id: Option<String>,
}

/// Typed event payloads. The serde tag is the wire `type`; the content is `payload`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "payload", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum EventPayload {
    #[serde(rename = "app.started")]
    AppStarted {
        version: String,
        channel: BuildChannel,
        platform: String,
        arch: String,
    },
    #[serde(rename = "app.stopped")]
    AppStopped { uptime_ms: u64 },
    /// The previous session ended without `app.stopped` (crash, force quit, power loss).
    #[serde(rename = "app.previous_session_interrupted")]
    PreviousSessionInterrupted { last_event_at: String },
    #[serde(rename = "database.migrated")]
    DatabaseMigrated {
        from_version: i64,
        to_version: i64,
        backup_created: bool,
    },
    #[serde(rename = "settings.changed")]
    SettingsChanged { keys: Vec<String> },
    #[serde(rename = "secure_store.checked")]
    SecureStoreChecked { ok: bool, backend: String },
    /// A folder was opened in KalCode for the first time.
    #[serde(rename = "workspace.created")]
    WorkspaceCreated { workspace_id: String, name: String },
    /// An existing workspace became the active one.
    #[serde(rename = "workspace.opened")]
    WorkspaceOpened { workspace_id: String, name: String },
    /// A workspace was removed from KalCode's list (its folder is untouched).
    #[serde(rename = "workspace.removed")]
    WorkspaceRemoved { workspace_id: String, name: String },
    /// A shell started in a terminal tab.
    #[serde(rename = "shell.started")]
    ShellStarted {
        terminal_id: String,
        shell_id: String,
        shell_name: String,
    },
    /// A shell exited with code 0, or was ended by the user closing its tab.
    #[serde(rename = "shell.completed")]
    ShellCompleted {
        terminal_id: String,
        exit_code: i64,
        closed_by_user: bool,
    },
    /// A shell exited with a non-zero code on its own.
    #[serde(rename = "shell.failed")]
    ShellFailed { terminal_id: String, exit_code: i64 },
    /// A stored event this build does not understand (written by a newer build or a removed
    /// type). Kept so history stays complete.
    #[serde(rename = "unrecognized")]
    Unrecognized {
        original_type: String,
        original_version: u32,
    },
}

impl EventPayload {
    /// Wire type name.
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::AppStarted { .. } => "app.started",
            Self::AppStopped { .. } => "app.stopped",
            Self::PreviousSessionInterrupted { .. } => "app.previous_session_interrupted",
            Self::DatabaseMigrated { .. } => "database.migrated",
            Self::SettingsChanged { .. } => "settings.changed",
            Self::SecureStoreChecked { .. } => "secure_store.checked",
            Self::WorkspaceCreated { .. } => "workspace.created",
            Self::WorkspaceOpened { .. } => "workspace.opened",
            Self::WorkspaceRemoved { .. } => "workspace.removed",
            Self::ShellStarted { .. } => "shell.started",
            Self::ShellCompleted { .. } => "shell.completed",
            Self::ShellFailed { .. } => "shell.failed",
            Self::Unrecognized { .. } => "unrecognized",
        }
    }

    /// Payload schema version for this type.
    pub fn version(&self) -> u32 {
        match self {
            Self::Unrecognized {
                original_version, ..
            } => *original_version,
            _ => 1,
        }
    }
}

/// A persisted event as delivered to consumers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EventEnvelope {
    pub id: String,
    pub seq: i64,
    pub version: u32,
    pub occurred_at: String,
    pub source: EventSource,
    pub correlation: Correlation,
    #[serde(flatten)]
    pub event: EventPayload,
}

/// An event before it is persisted (no `seq` yet).
#[derive(Debug, Clone)]
pub struct NewEvent {
    pub source: EventSource,
    pub correlation: Correlation,
    pub event: EventPayload,
}

impl NewEvent {
    pub fn core(event: EventPayload) -> Self {
        Self {
            source: EventSource::Core,
            correlation: Correlation::default(),
            event,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            EventPayload::WorkspaceCreated {
                workspace_id: String::new(),
                name: String::new(),
            },
            EventPayload::WorkspaceOpened {
                workspace_id: String::new(),
                name: String::new(),
            },
            EventPayload::WorkspaceRemoved {
                workspace_id: String::new(),
                name: String::new(),
            },
            EventPayload::ShellStarted {
                terminal_id: String::new(),
                shell_id: String::new(),
                shell_name: String::new(),
            },
            EventPayload::ShellCompleted {
                terminal_id: String::new(),
                exit_code: 0,
                closed_by_user: false,
            },
            EventPayload::ShellFailed {
                terminal_id: String::new(),
                exit_code: 1,
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

    #[test]
    fn workspace_and_shell_payloads_use_camel_case() {
        let json = serde_json::to_value(EventPayload::ShellCompleted {
            terminal_id: "t".into(),
            exit_code: 0,
            closed_by_user: true,
        })
        .expect("serialize");
        assert_eq!(json["type"], "shell.completed");
        assert_eq!(json["payload"]["terminalId"], "t");
        assert_eq!(json["payload"]["exitCode"], 0);
        assert_eq!(json["payload"]["closedByUser"], true);

        let json = serde_json::to_value(EventPayload::WorkspaceCreated {
            workspace_id: "w".into(),
            name: "site".into(),
        })
        .expect("serialize");
        assert_eq!(json["payload"]["workspaceId"], "w");
        let back: EventPayload = serde_json::from_value(json).expect("deserialize");
        assert_eq!(
            back,
            EventPayload::WorkspaceCreated {
                workspace_id: "w".into(),
                name: "site".into()
            }
        );
    }
}
