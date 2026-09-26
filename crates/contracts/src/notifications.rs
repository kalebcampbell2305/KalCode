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
    /// Removed from the center (never listed again).
    Dismissed,
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
    pub created_at: String,
    /// Last time it was raised (creation or a coalesced repeat). Lists are ordered by this.
    pub updated_at: String,
    /// `null` while unread.
    pub read_at: Option<String>,
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn implemented_notification_ipc_payload_round_trips_without_unavailable_attention_state() {
        let notification = serde_json::json!({
            "id": "notification-1", "kind": "permission_required", "severity": "warning",
            "title": "Permission needed", "body": "Review the request in its thread.",
            "entityKind": "thread", "entityId": "thread-1", "workspaceId": "workspace-1",
            "createdAt": "2026-09-25T12:00:00Z", "updatedAt": "2026-09-25T12:00:00Z",
            "readAt": null, "count": 1
        });
        let decoded: Notification =
            serde_json::from_value(notification.clone()).expect("implemented row shape");
        assert_eq!(
            serde_json::to_value(decoded).expect("serialize row"),
            notification
        );
        let page = serde_json::json!({ "notifications": [notification], "nextCursor": null, "unreadCount": 1 });
        let decoded: NotificationPage =
            serde_json::from_value(page.clone()).expect("implemented page shape");
        assert_eq!(serde_json::to_value(decoded).expect("serialize page"), page);
    }

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
            created_at: "c".into(),
            updated_at: "u".into(),
            read_at: None,
            count: 1,
        })
        .expect("json");
        assert_eq!(json["kind"], "permission_required");
        assert_eq!(json["entityKind"], "thread");
        assert_eq!(json["readAt"], serde_json::Value::Null);
        assert_eq!(json["updatedAt"], "u");
    }
}
