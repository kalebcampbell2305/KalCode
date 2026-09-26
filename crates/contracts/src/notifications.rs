//! Notification center contracts (Z7-W3; `docs/CONTRACTS_ADVANCED.md` §5.10, §6.10, §9 v11).
//!
//! One notification store (`crates/notifications`) is shared by every system that notifies: the
//! Dashboard's thread events today; missions, automations, the Environment Doctor, Provider Health,
//! Process Continuity and hand-offs later. Notifications carry short, KalCode-written facts only —
//! never model prose, prompts, file contents or secrets.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What a notification is about. Kinds whose systems do not exist yet (missions, automations,
/// doctor, health) are reserved so stored rows and the wire stay stable when they arrive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum NotificationKind {
    ThreadCompleted,
    ThreadFailed,
    PermissionRequired,
    MissionDone,
    ProviderDisconnected,
    RecoveryAvailable,
    AutomationFinished,
    DoctorFinding,
    HealthChanged,
}

impl NotificationKind {
    pub const ALL: [NotificationKind; 9] = [
        Self::ThreadCompleted,
        Self::ThreadFailed,
        Self::PermissionRequired,
        Self::MissionDone,
        Self::ProviderDisconnected,
        Self::RecoveryAvailable,
        Self::AutomationFinished,
        Self::DoctorFinding,
        Self::HealthChanged,
    ];

    /// The wire / stored name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ThreadCompleted => "thread_completed",
            Self::ThreadFailed => "thread_failed",
            Self::PermissionRequired => "permission_required",
            Self::MissionDone => "mission_done",
            Self::ProviderDisconnected => "provider_disconnected",
            Self::RecoveryAvailable => "recovery_available",
            Self::AutomationFinished => "automation_finished",
            Self::DoctorFinding => "doctor_finding",
            Self::HealthChanged => "health_changed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == value)
    }
}

/// How much a notification matters. Critical is for failures that stop work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Severity {
    Info,
    Warning,
    Critical,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Critical => "critical",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        [Self::Info, Self::Warning, Self::Critical]
            .into_iter()
            .find(|s| s.as_str() == value)
    }
}

/// What activating a notification navigates to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum NotificationEntityKind {
    Thread,
    Workspace,
    Provider,
    Approval,
}

impl NotificationEntityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Thread => "thread",
            Self::Workspace => "workspace",
            Self::Provider => "provider",
            Self::Approval => "approval",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        [
            Self::Thread,
            Self::Workspace,
            Self::Provider,
            Self::Approval,
        ]
        .into_iter()
        .find(|k| k.as_str() == value)
    }
}

/// `notification_mark`: what to record for the given notifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum NotificationMark {
    Read,
    Unread,
    /// Compatibility spelling for resolving an item from older clients.
    Dismissed,
}

/// The subsystem that raised an attention item. This is presentation and routing provenance, not
/// arbitrary provider text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum NotificationSourceKind {
    Thread,
    Provider,
    Doctor,
    Continuity,
    Mission,
    Automation,
    System,
}

impl NotificationSourceKind {
    pub const ALL: [Self; 7] = [
        Self::Thread,
        Self::Provider,
        Self::Doctor,
        Self::Continuity,
        Self::Mission,
        Self::Automation,
        Self::System,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Thread => "thread",
            Self::Provider => "provider",
            Self::Doctor => "doctor",
            Self::Continuity => "continuity",
            Self::Mission => "mission",
            Self::Automation => "automation",
            Self::System => "system",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|source| source.as_str() == value)
    }
}

/// A durable view in the Attention Center.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum NotificationView {
    /// Unresolved, due items that require the owner's action.
    #[default]
    Attention,
    /// Every unresolved, due item, including informational completions.
    Open,
    /// Unresolved items whose reminder time has not arrived.
    Snoozed,
    /// Resolved items retained as history.
    History,
}

/// Why an item moved into history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum NotificationResolution {
    SourceResolved,
    UserResolved,
    Superseded,
}

impl NotificationResolution {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SourceResolved => "source_resolved",
            Self::UserResolved => "user_resolved",
            Self::Superseded => "superseded",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        [Self::SourceResolved, Self::UserResolved, Self::Superseded]
            .into_iter()
            .find(|resolution| resolution.as_str() == value)
    }
}

/// Bounded snooze choices. Native code computes the deadline so the WebView cannot supply an
/// arbitrary timestamp.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum NotificationSnooze {
    OneHour,
    OneDay,
    OneWeek,
    Clear,
}

/// The route owned by an attention item. The UI executes only one of these typed destinations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum NotificationAction {
    Thread {
        thread_id: String,
        workspace_id: Option<String>,
    },
    Provider {
        provider_id: String,
        provider_account_id: Option<String>,
    },
    Doctor,
    Recovery,
    Mission {
        mission_id: String,
    },
    Automation {
        automation_id: String,
    },
    None,
}

/// Operating-system permission truth. KalCode never treats a prompt or error as granted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum NativeNotificationPermission {
    Unsupported,
    Prompt,
    Granted,
    Denied,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NativeNotificationStatus {
    /// The owner explicitly opted in on this device.
    pub enabled: bool,
    pub permission: NativeNotificationPermission,
    /// True only when enabled and the operating system currently reports Granted.
    pub effective: bool,
    pub reason: Option<String>,
}

/// One notification as the center shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Notification {
    pub id: String,
    pub kind: NotificationKind,
    pub severity: Severity,
    pub title: String,
    pub body: String,
    pub entity_kind: Option<NotificationEntityKind>,
    pub entity_id: Option<String>,
    /// The workspace of the entity, when known (focusing a thread opens its workspace).
    pub workspace_id: Option<String>,
    pub source_kind: NotificationSourceKind,
    pub source_id: Option<String>,
    pub source_label: Option<String>,
    /// Credential-free managed provider-account metadata id, when the source is account-bound.
    pub provider_account_id: Option<String>,
    pub action: NotificationAction,
    /// Reading does not clear this. Only source settlement or an explicit resolve does.
    pub requires_action: bool,
    pub created_at: String,
    /// Last time it was raised (creation or a coalesced repeat). Lists are ordered by this.
    pub updated_at: String,
    /// `null` while unread.
    pub read_at: Option<String>,
    pub snoozed_until: Option<String>,
    pub resolved_at: Option<String>,
    pub resolution: Option<NotificationResolution>,
    /// How many events were coalesced into this notification (≥ 1).
    pub count: u32,
}

/// `notification_list` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NotificationPage {
    pub notifications: Vec<Notification>,
    /// Pass as `before` for the next page; `null` on the last page.
    pub next_cursor: Option<String>,
    /// Unread, undismissed notifications in the whole center (the badge count).
    pub unread_count: u32,
    /// Unresolved, due items that still require action, including already-read items.
    pub attention_count: u32,
    pub snoozed_count: u32,
    pub history_count: u32,
    /// Earliest future snooze deadline, used for one bounded UI refresh timer.
    pub next_wake_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_and_match_serde() {
        for kind in NotificationKind::ALL {
            assert_eq!(NotificationKind::parse(kind.as_str()), Some(kind));
            assert_eq!(serde_json::to_value(kind).expect("json"), kind.as_str());
        }
        for severity in [Severity::Info, Severity::Warning, Severity::Critical] {
            assert_eq!(Severity::parse(severity.as_str()), Some(severity));
            assert_eq!(
                serde_json::to_value(severity).expect("json"),
                severity.as_str()
            );
        }
        for kind in [
            NotificationEntityKind::Thread,
            NotificationEntityKind::Workspace,
            NotificationEntityKind::Provider,
            NotificationEntityKind::Approval,
        ] {
            assert_eq!(NotificationEntityKind::parse(kind.as_str()), Some(kind));
            assert_eq!(serde_json::to_value(kind).expect("json"), kind.as_str());
        }
        assert_eq!(NotificationKind::parse("nope"), None);
    }

    #[test]
    fn notification_is_camel_case() {
        let json = serde_json::to_value(Notification {
            id: "n".into(),
            kind: NotificationKind::PermissionRequired,
            severity: Severity::Warning,
            title: "t".into(),
            body: "b".into(),
            entity_kind: Some(NotificationEntityKind::Thread),
            entity_id: Some("x".into()),
            workspace_id: None,
            source_kind: NotificationSourceKind::Thread,
            source_id: Some("x".into()),
            source_label: Some("Thread".into()),
            provider_account_id: None,
            action: NotificationAction::Thread {
                thread_id: "x".into(),
                workspace_id: None,
            },
            requires_action: true,
            created_at: "c".into(),
            updated_at: "u".into(),
            read_at: None,
            snoozed_until: None,
            resolved_at: None,
            resolution: None,
            count: 1,
        })
        .expect("json");
        assert_eq!(json["kind"], "permission_required");
        assert_eq!(json["entityKind"], "thread");
        assert_eq!(json["readAt"], serde_json::Value::Null);
        assert_eq!(json["updatedAt"], "u");
        assert_eq!(json["sourceKind"], "thread");
        assert_eq!(json["action"]["kind"], "thread");
        assert_eq!(json["requiresAction"], true);
    }
}
