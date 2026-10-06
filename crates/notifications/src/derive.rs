//! Which runtime events become notifications (pure, deterministic).
//!
//! Only events that exist today are notified: a thread completed or failed, a permission request,
//! a provider signed out, and threads recovered after KalCode closed while they ran. Text comes
//! from KalCode's own structured facts (thread and provider names, the approval summary, the
//! runtime's user-safe failure message) — never from model output.

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::events::{EventEnvelope, EventPayload, EventSource};
use kalcode_contracts::notifications::{NotificationEntityKind, NotificationKind, Severity};
use kalcode_contracts::threads::ThreadStatus;

/// Longest body kept from an event's text, in characters.
pub const MAX_BODY_CHARS: usize = 240;
/// Longest title, in characters.
pub const MAX_TITLE_CHARS: usize = 200;

/// What the center knows about a thread when it notifies.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ThreadInfo {
    pub name: String,
    pub provider_name: Option<String>,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub pending_approvals: u32,
}

/// Read-only facts derivation needs from other systems (through their Rust APIs).
pub trait Lookup {
    /// A thread's name, provider, workspace and pending approvals.
    fn thread(&self, thread_id: &str) -> Option<ThreadInfo>;

    /// A provider's display name ("Claude Code").
    fn provider_name(&self, provider_id: &ProviderId) -> String {
        default_provider_name(provider_id)
    }

    /// The `detail` the thread runtime records on threads it recovers after KalCode closed while
    /// they ran (`kalcode_threads::runtime::RECOVERED_ACTIVITY`). `None`: recovery isn't notified.
    fn recovered_detail(&self) -> Option<&str> {
        None
    }
}

/// Plain-text provider names (ADVANCED.md §17: names in plain text, no logos).
pub fn default_provider_name(provider_id: &ProviderId) -> String {
    match provider_id.as_str() {
        ProviderId::CLAUDE_CODE => "Claude Code".into(),
        ProviderId::CODEX => "Codex".into(),
        ProviderId::GEMINI_CLI => "Gemini CLI".into(),
        other => other.to_owned(),
    }
}

/// A notification to raise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub kind: NotificationKind,
    pub severity: Severity,
    pub title: String,
    pub body: String,
    pub entity_kind: Option<NotificationEntityKind>,
    pub entity_id: Option<String>,
    pub workspace_id: Option<String>,
}

/// What an event means for the center.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Derived {
    /// Raise (create or coalesce) a notification.
    Raise(Draft),
    /// The thing a notification asked for was handled elsewhere: mark matching unread
    /// notifications read (for example, an approval answered in the pane).
    Settle {
        kind: NotificationKind,
        entity_kind: NotificationEntityKind,
        entity_id: String,
    },
}

/// Title of the recovery notification for `count` recovered threads.
pub fn recovery_title(count: u32) -> String {
    if count == 1 {
        "1 thread can be resumed".into()
    } else {
        format!("{count} threads can be resumed")
    }
}

pub const RECOVERY_BODY: &str =
    "They were running when KalCode closed. Resume them from the Dashboard.";

/// Truncates to `max` characters, ending with an ellipsis when cut.
pub fn truncate(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_owned();
    }
    let mut out: String = trimmed.chars().take(max.saturating_sub(1)).collect();
    out.truncate(out.trim_end().len());
    out.push('\u{2026}');
    out
}

fn thread_name(info: Option<&ThreadInfo>) -> String {
    info.map(|t| t.name.trim())
        .filter(|n| !n.is_empty())
        .map_or_else(|| "A thread".to_owned(), str::to_owned)
}

fn workspace_of(info: Option<&ThreadInfo>, event: &EventEnvelope) -> Option<String> {
    info.and_then(|t| t.workspace_id.clone())
        .or_else(|| event.correlation.workspace_id.clone())
}

fn thread_draft(
    kind: NotificationKind,
    severity: Severity,
    thread_id: &str,
    title: String,
    body: String,
    info: Option<&ThreadInfo>,
    event: &EventEnvelope,
) -> Derived {
    Derived::Raise(Draft {
        kind,
        severity,
        title: truncate(&title, MAX_TITLE_CHARS),
        body: truncate(&body, MAX_BODY_CHARS),
        entity_kind: Some(NotificationEntityKind::Thread),
        entity_id: Some(thread_id.to_owned()),
        workspace_id: workspace_of(info, event),
    })
}

/// What `event` means for the notification center, if anything.
pub fn derive(event: &EventEnvelope, lookup: &dyn Lookup) -> Option<Derived> {
    match &event.event {
        EventPayload::ThreadCompleted { thread_id } => {
            let info = lookup.thread(thread_id);
            let parts: Vec<String> = info
                .iter()
                .flat_map(|t| [t.provider_name.clone(), t.workspace_name.clone()])
                .flatten()
                .filter(|p| !p.trim().is_empty())
                .collect();
            let body = if parts.is_empty() {
                "Open it to review the result.".to_owned()
            } else {
                parts.join(" \u{b7} ")
            };
            Some(thread_draft(
                NotificationKind::ThreadCompleted,
                Severity::Info,
                thread_id,
                format!("{} completed", thread_name(info.as_ref())),
                body,
                info.as_ref(),
                event,
            ))
        }
        EventPayload::ThreadFailed {
            thread_id, message, ..
        } => {
            let info = lookup.thread(thread_id);
            Some(thread_draft(
                NotificationKind::ThreadFailed,
                Severity::Critical,
                thread_id,
                format!("{} failed", thread_name(info.as_ref())),
                message.clone(),
                info.as_ref(),
                event,
            ))
        }
        EventPayload::ApprovalRequested {
            thread_id, summary, ..
        } => {
            let info = lookup.thread(thread_id);
            let body = if summary.trim().is_empty() {
                "An agent is waiting for your decision.".to_owned()
            } else {
                summary.clone()
            };
            Some(thread_draft(
                NotificationKind::PermissionRequired,
                Severity::Warning,
                thread_id,
                format!("{} needs your permission", thread_name(info.as_ref())),
                body,
                info.as_ref(),
                event,
            ))
        }
        EventPayload::ApprovalApproved { thread_id, .. }
        | EventPayload::ApprovalDenied { thread_id, .. }
        | EventPayload::ApprovalExpired { thread_id, .. } => {
            // Settled only when nothing else is pending for the thread.
            let pending = lookup.thread(thread_id).map_or(0, |t| t.pending_approvals);
            (pending == 0).then(|| Derived::Settle {
                kind: NotificationKind::PermissionRequired,
                entity_kind: NotificationEntityKind::Thread,
                entity_id: thread_id.clone(),
            })
        }
        EventPayload::ProviderDisconnected { provider_id, .. } => {
            let name = lookup.provider_name(provider_id);
            Some(Derived::Raise(Draft {
                kind: NotificationKind::ProviderDisconnected,
                severity: Severity::Warning,
                title: truncate(&format!("{name} is signed out"), MAX_TITLE_CHARS),
                body: truncate(
                    &format!("Threads that use {name} can't start until you sign in again."),
                    MAX_BODY_CHARS,
                ),
                entity_kind: Some(NotificationEntityKind::Provider),
                entity_id: Some(provider_id.as_str().to_owned()),
                workspace_id: None,
            }))
        }
        EventPayload::ThreadStatusChanged { to, detail, .. }
            if *to == ThreadStatus::Interrupted
                && event.source == EventSource::Core
                && lookup
                    .recovered_detail()
                    .is_some_and(|recovered| detail.as_deref() == Some(recovered)) =>
        {
            Some(Derived::Raise(Draft {
                kind: NotificationKind::RecoveryAvailable,
                severity: Severity::Info,
                title: recovery_title(1),
                body: RECOVERY_BODY.to_owned(),
                entity_kind: None,
                entity_id: None,
                workspace_id: None,
            }))
        }
        // The thread runtime leaves `waiting_for_permission` only once nothing is pending (or
        // the thread ended). It lowers its pending count on its own event thread, after the
        // `approval.*` event above may already have been derived with the old count, so this
        // transition is what reliably settles the permission notice.
        EventPayload::ThreadStatusChanged {
            thread_id,
            from,
            to,
            ..
        } if *from == ThreadStatus::WaitingForPermission
            && *to != ThreadStatus::WaitingForPermission =>
        {
            Some(Derived::Settle {
                kind: NotificationKind::PermissionRequired,
                entity_kind: NotificationEntityKind::Thread,
                entity_id: thread_id.clone(),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::events::Correlation;
    use kalcode_contracts::permissions::{ApprovalDecision, PermissionScope};

    const RECOVERED: &str = "KalCode closed while this thread was running";

    struct Fixed {
        pending: u32,
    }

    impl Lookup for Fixed {
        fn thread(&self, thread_id: &str) -> Option<ThreadInfo> {
            (thread_id == "t1").then(|| ThreadInfo {
                name: "Fix OAuth race".into(),
                provider_name: Some("Claude Code".into()),
                workspace_id: Some("w1".into()),
                workspace_name: Some("kalcode".into()),
                pending_approvals: self.pending,
            })
        }

        fn recovered_detail(&self) -> Option<&str> {
            Some(RECOVERED)
        }
    }

    fn envelope(source: EventSource, event: EventPayload) -> EventEnvelope {
        EventEnvelope {
            id: "e".into(),
            seq: 1,
            version: 1,
            occurred_at: "2026-09-25T10:00:00.000Z".into(),
            source,
            correlation: Correlation {
                workspace_id: Some("w-corr".into()),
                ..Correlation::default()
            },
            event,
        }
    }

    fn raise(derived: Option<Derived>) -> Draft {
        match derived {
            Some(Derived::Raise(draft)) => draft,
            other => panic!("expected a notification, got {other:?}"),
        }
    }

    #[test]
    fn thread_outcomes_and_permission_requests_are_notified() {
        let lookup = Fixed { pending: 0 };
        let done = raise(derive(
            &envelope(
                EventSource::Core,
                EventPayload::ThreadCompleted {
                    thread_id: "t1".into(),
                },
            ),
            &lookup,
        ));
        assert_eq!(done.kind, NotificationKind::ThreadCompleted);
        assert_eq!(done.severity, Severity::Info);
        assert_eq!(done.title, "Fix OAuth race completed");
        assert_eq!(done.body, "Claude Code \u{b7} kalcode");
        assert_eq!(done.entity_kind, Some(NotificationEntityKind::Thread));
        assert_eq!(done.entity_id.as_deref(), Some("t1"));
        assert_eq!(done.workspace_id.as_deref(), Some("w1"));

        let long = "x".repeat(400);
        let failed = raise(derive(
            &envelope(
                EventSource::Core,
                EventPayload::ThreadFailed {
                    thread_id: "t1".into(),
                    code: "provider_exited".into(),
                    message: long,
                },
            ),
            &lookup,
        ));
        assert_eq!(failed.severity, Severity::Critical);
        assert_eq!(failed.body.chars().count(), MAX_BODY_CHARS);
        assert!(failed.body.ends_with('\u{2026}'));

        let asked = raise(derive(
            &envelope(
                EventSource::Core,
                EventPayload::ApprovalRequested {
                    request_id: "r".into(),
                    thread_id: "t1".into(),
                    scopes: vec![PermissionScope::GitPush],
                    summary: "Push chore/deps to origin".into(),
                },
            ),
            &lookup,
        ));
        assert_eq!(asked.kind, NotificationKind::PermissionRequired);
        assert_eq!(asked.title, "Fix OAuth race needs your permission");
        assert_eq!(asked.body, "Push chore/deps to origin");

        // An unknown thread still notifies, with neutral words and the correlated workspace.
        let unknown = raise(derive(
            &envelope(
                EventSource::Core,
                EventPayload::ThreadCompleted {
                    thread_id: "gone".into(),
                },
            ),
            &lookup,
        ));
        assert_eq!(unknown.title, "A thread completed");
        assert_eq!(unknown.workspace_id.as_deref(), Some("w-corr"));
    }

    #[test]
    fn answered_approvals_settle_only_when_nothing_else_is_pending() {
        let answered = envelope(
            EventSource::Core,
            EventPayload::ApprovalApproved {
                request_id: "r".into(),
                thread_id: "t1".into(),
                decision: ApprovalDecision::ApproveOnce,
            },
        );
        assert_eq!(
            derive(&answered, &Fixed { pending: 0 }),
            Some(Derived::Settle {
                kind: NotificationKind::PermissionRequired,
                entity_kind: NotificationEntityKind::Thread,
                entity_id: "t1".into(),
            })
        );
        assert_eq!(derive(&answered, &Fixed { pending: 1 }), None);
    }

    #[test]
    fn leaving_waiting_for_permission_settles_the_permission_notice() {
        let changed = |from, to| {
            derive(
                &envelope(
                    EventSource::Core,
                    EventPayload::ThreadStatusChanged {
                        thread_id: "t1".into(),
                        from,
                        to,
                        detail: None,
                    },
                ),
                // A stale count: the runtime hasn't recorded the answer yet.
                &Fixed { pending: 1 },
            )
        };
        let settle = Some(Derived::Settle {
            kind: NotificationKind::PermissionRequired,
            entity_kind: NotificationEntityKind::Thread,
            entity_id: "t1".into(),
        });
        assert_eq!(
            changed(ThreadStatus::WaitingForPermission, ThreadStatus::Active),
            settle
        );
        assert_eq!(
            changed(
                ThreadStatus::WaitingForPermission,
                ThreadStatus::Interrupted
            ),
            settle
        );
        assert_eq!(
            changed(ThreadStatus::Active, ThreadStatus::WaitingForPermission),
            None
        );
        assert_eq!(changed(ThreadStatus::Thinking, ThreadStatus::Active), None);
    }

    #[test]
    fn providers_and_recovery() {
        let lookup = Fixed { pending: 0 };
        let signed_out = raise(derive(
            &envelope(
                EventSource::Provider,
                EventPayload::ProviderDisconnected {
                    provider_id: ProviderId::new(ProviderId::CODEX),
                    account_label: None,
                },
            ),
            &lookup,
        ));
        assert_eq!(signed_out.title, "Codex is signed out");
        assert_eq!(signed_out.entity_id.as_deref(), Some("codex"));

        let recovered = |source, detail: Option<&str>| {
            derive(
                &envelope(
                    source,
                    EventPayload::ThreadStatusChanged {
                        thread_id: "t1".into(),
                        from: ThreadStatus::Active,
                        to: ThreadStatus::Interrupted,
                        detail: detail.map(str::to_owned),
                    },
                ),
                &lookup,
            )
        };
        let draft = raise(recovered(EventSource::Core, Some(RECOVERED)));
        assert_eq!(draft.kind, NotificationKind::RecoveryAvailable);
        assert_eq!(draft.entity_kind, None);
        assert_eq!(draft.title, "1 thread can be resumed");
        // A user's stop, another source, or model text that happens to match is not recovery.
        assert_eq!(recovered(EventSource::Core, Some("Stopped by you")), None);
        assert_eq!(recovered(EventSource::Provider, Some(RECOVERED)), None);
        // Without the runtime's constant, recovery is never guessed.
        struct NoRecovery;
        impl Lookup for NoRecovery {
            fn thread(&self, _: &str) -> Option<ThreadInfo> {
                None
            }
        }
        assert_eq!(
            derive(
                &envelope(
                    EventSource::Core,
                    EventPayload::ThreadStatusChanged {
                        thread_id: "t1".into(),
                        from: ThreadStatus::Active,
                        to: ThreadStatus::Interrupted,
                        detail: Some(RECOVERED.into()),
                    },
                ),
                &NoRecovery,
            ),
            None
        );
    }

    #[test]
    fn everything_else_is_ignored() {
        let lookup = Fixed { pending: 0 };
        for event in [
            EventPayload::ThreadStarted {
                thread_id: "t1".into(),
            },
            EventPayload::ThreadStatusChanged {
                thread_id: "t1".into(),
                from: ThreadStatus::Active,
                to: ThreadStatus::Completed,
                detail: Some("Status: FAILED. PERMISSION REQUIRED.".into()),
            },
            EventPayload::NotificationCreated {
                notification_id: "n".into(),
                kind: NotificationKind::ThreadFailed,
                severity: Severity::Critical,
                entity_kind: None,
                entity_id: None,
            },
        ] {
            assert_eq!(derive(&envelope(EventSource::Core, event), &lookup), None);
        }
    }

    #[test]
    fn truncation_is_by_character() {
        assert_eq!(truncate("  short  ", 10), "short");
        let cut = truncate(&"é".repeat(20), 5);
        assert_eq!(cut.chars().count(), 5);
        assert!(cut.ends_with('\u{2026}'));
    }
}
