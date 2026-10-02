//! Short, local spoken lifecycle callbacks for KalVoice.
//!
//! This listener consumes only events published after it subscribes. It never reads event
//! history, message bodies, provider output, prompts, terminal output, or approval summaries.
//! A bounded worker keeps speech and thread-name lookup off the Core event bus. Operations use
//! the same queue after their durable finish write commits, so paired thread/operation signals
//! share one deduplication policy.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use kalcode_contracts::agent::ProviderId;
use kalcode_contracts::events::{EventEnvelope, EventPayload};
use kalcode_contracts::operations::{OperationKind, OperationStatus};
use kalcode_contracts::threads::{ThreadErrorKind, ThreadStatus};
use kalcode_core::Core;
use kalcode_core::events::SubscriptionId;
use kalcode_kalvoice::signals::{LifecycleCallbackClass, LifecycleTargetKind};
use kalcode_threads::ThreadRuntime;

const QUEUE_CAPACITY: usize = 128;
const EVENT_DEDUPE_CAPACITY: usize = 512;
const SEMANTIC_DEDUPE_TTL: Duration = Duration::from_secs(30);
const DELIVERY_ACK_TIMEOUT: Duration = Duration::from_secs(15);
const DELIVERY_ACK_POLL: Duration = Duration::from_millis(100);
const MAX_LABEL_CHARS: usize = 80;

pub(crate) const fn delivery_allowed(
    voice_replies: bool,
    output_available: bool,
    microphone_active: bool,
    shutting_down: bool,
) -> bool {
    voice_replies && output_available && !microphone_active && !shutting_down
}

/// A concise, trusted sentence and the canonical object it describes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Announcement {
    pub request_id: String,
    pub text: String,
    pub class: LifecycleCallbackClass,
    pub target_kind: Option<LifecycleTargetKind>,
    pub target_id: Option<String>,
    pub workspace_id: Option<String>,
}

/// The only Operations fields the live callback policy needs. The full record remains in the
/// existing Operations projection for "what did it do?" and "open it" follow-ups.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OperationCallback {
    pub id: String,
    pub name: String,
    pub kind: OperationKind,
    pub status: OperationStatus,
    /// The provider thread, when this run owns one. Using it only as the semantic dedupe key
    /// prevents the same failure from being spoken once by Core and again by Operations.
    pub thread_id: Option<String>,
    pub workspace_id: Option<String>,
}

pub(crate) type OperationAnnouncer = Arc<dyn Fn(OperationCallback) + Send + Sync>;
pub(crate) type DeliveryDone = Box<dyn FnOnce() + Send>;
type Speaker = Arc<dyn Fn(Announcement, DeliveryDone) -> bool + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
struct ThreadFacts {
    name: String,
    provider_id: Option<ProviderId>,
    provider_name: String,
    workspace_id: Option<String>,
}

trait CallbackLookup: Send + Sync {
    fn thread(&self, thread_id: &str) -> Option<ThreadFacts>;
}

struct RuntimeLookup {
    threads: Option<Arc<ThreadRuntime>>,
}

impl CallbackLookup for RuntimeLookup {
    fn thread(&self, thread_id: &str) -> Option<ThreadFacts> {
        let thread = self.threads.as_ref()?.get(thread_id).ok()?;
        Some(ThreadFacts {
            name: thread.name,
            provider_id: Some(thread.provider_id),
            provider_name: thread.provider_name,
            workspace_id: Some(thread.workspace_id),
        })
    }
}

enum Message {
    Event(Box<EventEnvelope>, Instant),
    Operation(OperationCallback, Instant),
    Shutdown,
}

/// One live, account-generation-scoped listener. `shutdown` is explicit because Operations keeps
/// a sender clone until its own worker stops immediately before KalVoice does.
pub(crate) struct Callbacks {
    core: Arc<Core>,
    subscription: SubscriptionId,
    sender: SyncSender<Message>,
    stopping: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Callbacks {
    pub(crate) fn start(
        core: Arc<Core>,
        threads: Option<Arc<ThreadRuntime>>,
        speaker: Speaker,
    ) -> Option<Self> {
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        let event_sender = sender.clone();
        let subscription = core.subscribe(move |event| {
            if !relevant(event) {
                return true;
            }
            match event_sender.try_send(Message::Event(Box::new(event.clone()), Instant::now())) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => {
                    tracing::warn!(event = "kalvoice.callbacks_queue_full", seq = event.seq);
                    true
                }
                Err(TrySendError::Disconnected(_)) => false,
            }
        });
        let stopping = Arc::new(AtomicBool::new(false));
        let worker_stopping = stopping.clone();
        let worker = std::thread::Builder::new()
            .name("kalvoice-callbacks".into())
            .spawn(move || {
                run(
                    receiver,
                    RuntimeLookup { threads },
                    speaker,
                    worker_stopping,
                )
            });
        match worker {
            Ok(worker) => Some(Self {
                core,
                subscription,
                sender,
                stopping,
                worker: Mutex::new(Some(worker)),
            }),
            Err(error) => {
                core.unsubscribe(subscription);
                tracing::warn!(event = "kalvoice.callbacks_worker_unavailable", error = %error);
                None
            }
        }
    }

    pub(crate) fn operation_announcer(&self) -> OperationAnnouncer {
        let sender = self.sender.clone();
        let stopping = self.stopping.clone();
        Arc::new(move |operation| {
            if stopping.load(Ordering::Acquire) {
                return;
            }
            if let Err(TrySendError::Full(_)) =
                sender.try_send(Message::Operation(operation, Instant::now()))
            {
                tracing::warn!(
                    event = "kalvoice.callbacks_queue_full",
                    source = "operations"
                );
            }
        })
    }

    pub(crate) fn shutdown(&self) {
        if self.stopping.swap(true, Ordering::AcqRel) {
            return;
        }
        self.core.unsubscribe(self.subscription);
        let _ = self.sender.try_send(Message::Shutdown);
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            let _ = worker.join();
        }
    }
}

fn relevant(event: &EventEnvelope) -> bool {
    matches!(
        event.event,
        EventPayload::AgentTurnCompleted { .. }
            | EventPayload::ThreadCompleted { .. }
            | EventPayload::ThreadFailed { .. }
            | EventPayload::ThreadStatusChanged { .. }
            | EventPayload::ApprovalRequested { .. }
            | EventPayload::ProviderDisconnected { .. }
    )
}

fn run(
    receiver: Receiver<Message>,
    lookup: RuntimeLookup,
    speaker: Speaker,
    stopping: Arc<AtomicBool>,
) {
    let mut policy = Policy::default();
    while !stopping.load(Ordering::Acquire) {
        let message = match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let announcement = match message {
            Message::Event(event, observed_at) => policy.event(&event, &lookup, observed_at),
            Message::Operation(operation, observed_at) => policy.operation(&operation, observed_at),
            Message::Shutdown => return,
        };
        if let Some(announcement) = announcement {
            let (done, delivered) = mpsc::sync_channel(1);
            let accepted = speaker(
                announcement,
                Box::new(move || {
                    let _ = done.send(());
                }),
            );
            if accepted {
                wait_for_delivery(delivered, stopping.as_ref());
            }
        }
    }
}

/// `SpeechOutput` deliberately interrupts its current utterance when asked to speak again. The
/// callback worker therefore waits for the existing output's completion seam before dequeuing the
/// next name. Waiting is bounded, and account shutdown interrupts it within one poll interval.
fn wait_for_delivery(delivered: Receiver<()>, stopping: &AtomicBool) {
    let deadline = Instant::now() + DELIVERY_ACK_TIMEOUT;
    while !stopping.load(Ordering::Acquire) {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            tracing::warn!(event = "kalvoice.callback_delivery_timeout");
            return;
        };
        match delivered.recv_timeout(remaining.min(DELIVERY_ACK_POLL)) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Topic {
    Completed,
    Failed,
    NeedsUser,
    Permission,
    Auth,
    Deployment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
    AgentTurn,
    ThreadLifecycle,
    Status,
    Approval,
    Provider,
    Operation,
}

#[derive(Default)]
struct Policy {
    event_ids: HashSet<String>,
    event_order: VecDeque<String>,
    recent: HashMap<(Topic, String), (Origin, Instant)>,
}

impl Policy {
    fn event(
        &mut self,
        event: &EventEnvelope,
        lookup: &dyn CallbackLookup,
        now: Instant,
    ) -> Option<Announcement> {
        if !self.admit_event(&event.id) {
            return None;
        }
        let candidate = match &event.event {
            EventPayload::AgentTurnCompleted {
                thread_id,
                ok,
                interrupted,
            } if !interrupted => {
                let facts = facts(lookup, thread_id)?;
                let (topic, text) = if *ok {
                    (Topic::Completed, format!("{} finished.", facts.name))
                } else {
                    (Topic::Failed, format!("{} failed.", facts.name))
                };
                Some(candidate(
                    topic,
                    Origin::AgentTurn,
                    thread_id,
                    event.id.clone(),
                    text,
                    facts.workspace_id,
                ))
            }
            EventPayload::ThreadCompleted { thread_id } => {
                let facts = facts(lookup, thread_id)?;
                Some(candidate(
                    Topic::Completed,
                    Origin::ThreadLifecycle,
                    thread_id,
                    event.id.clone(),
                    format!("{} finished.", facts.name),
                    facts.workspace_id,
                ))
            }
            EventPayload::ThreadFailed {
                thread_id, code, ..
            } => {
                let facts = facts(lookup, thread_id)?;
                if ThreadErrorKind::of_code(code) == ThreadErrorKind::AuthRequired {
                    let key = facts
                        .provider_id
                        .as_ref()
                        .map_or_else(|| thread_id.clone(), ToString::to_string);
                    Some(
                        candidate(
                            Topic::Auth,
                            Origin::ThreadLifecycle,
                            &key,
                            event.id.clone(),
                            format!(
                                "{} needs you to sign in to {}.",
                                facts.name, facts.provider_name
                            ),
                            facts.workspace_id,
                        )
                        .with_target(thread_id.clone()),
                    )
                } else {
                    Some(candidate(
                        Topic::Failed,
                        Origin::ThreadLifecycle,
                        thread_id,
                        event.id.clone(),
                        format!("{} failed.", facts.name),
                        facts.workspace_id,
                    ))
                }
            }
            EventPayload::ThreadStatusChanged {
                thread_id,
                to: ThreadStatus::WaitingForUser,
                ..
            } => {
                let facts = facts(lookup, thread_id)?;
                Some(candidate(
                    Topic::NeedsUser,
                    Origin::Status,
                    thread_id,
                    event.id.clone(),
                    format!("{} needs you.", facts.name),
                    facts.workspace_id,
                ))
            }
            EventPayload::ApprovalRequested { thread_id, .. } => {
                let facts = facts(lookup, thread_id)?;
                Some(candidate(
                    Topic::Permission,
                    Origin::Approval,
                    thread_id,
                    event.id.clone(),
                    format!("{} needs your permission.", facts.name),
                    facts.workspace_id,
                ))
            }
            EventPayload::ProviderDisconnected {
                provider_id,
                account_label,
            } => {
                let provider = provider_name(provider_id);
                let subject = account_label
                    .as_deref()
                    .map(label)
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| provider.clone());
                Some(
                    candidate(
                        Topic::Auth,
                        Origin::Provider,
                        provider_id.as_str(),
                        event.id.clone(),
                        format!("{subject} needs you to sign in to {provider}."),
                        event.correlation.workspace_id.clone(),
                    )
                    .without_target(),
                )
            }
            _ => None,
        }?;
        self.admit(candidate, now)
    }

    fn operation(&mut self, operation: &OperationCallback, now: Instant) -> Option<Announcement> {
        let name = label(&operation.name);
        let request_id = format!("operation:{}:{:?}", operation.id, operation.status);
        if !self.admit_event(&request_id) {
            return None;
        }
        let semantic_id = operation.thread_id.as_deref().unwrap_or(&operation.id);
        let candidate = match (operation.kind, operation.status) {
            (_, OperationStatus::Failed) => candidate(
                Topic::Failed,
                Origin::Operation,
                semantic_id,
                request_id,
                format!("{name} failed."),
                operation.workspace_id.clone(),
            )
            .with_target(operation.id.clone())
            .with_target_kind(LifecycleTargetKind::Operation),
            (OperationKind::Deploy, OperationStatus::Succeeded) => candidate(
                Topic::Deployment,
                Origin::Operation,
                &operation.id,
                request_id,
                format!("{name} deployment completed."),
                operation.workspace_id.clone(),
            )
            .with_target_kind(LifecycleTargetKind::Operation),
            (OperationKind::Release, OperationStatus::Succeeded) => candidate(
                Topic::Deployment,
                Origin::Operation,
                &operation.id,
                request_id,
                format!("{name} release completed."),
                operation.workspace_id.clone(),
            )
            .with_target_kind(LifecycleTargetKind::Operation),
            _ => return None,
        };
        self.admit(candidate, now)
    }

    fn admit_event(&mut self, id: &str) -> bool {
        if !self.event_ids.insert(id.to_owned()) {
            return false;
        }
        self.event_order.push_back(id.to_owned());
        if self.event_order.len() > EVENT_DEDUPE_CAPACITY
            && let Some(oldest) = self.event_order.pop_front()
        {
            self.event_ids.remove(&oldest);
        }
        true
    }

    fn admit(&mut self, candidate: Candidate, now: Instant) -> Option<Announcement> {
        self.recent
            .retain(|_, (_, last)| now.saturating_duration_since(*last) < SEMANTIC_DEDUPE_TTL);
        let key = (candidate.topic, candidate.key);
        if let Some((previous_origin, _)) = self.recent.get(&key)
            && (key.0 == Topic::Auth || *previous_origin != candidate.origin)
        {
            return None;
        }
        self.recent.insert(key, (candidate.origin, now));
        Some(candidate.announcement)
    }
}

struct Candidate {
    topic: Topic,
    origin: Origin,
    key: String,
    announcement: Announcement,
}

impl Candidate {
    fn with_target(mut self, target_id: String) -> Self {
        self.announcement.target_id = Some(target_id);
        self
    }

    fn with_target_kind(mut self, target_kind: LifecycleTargetKind) -> Self {
        self.announcement.target_kind = Some(target_kind);
        self
    }

    fn without_target(mut self) -> Self {
        self.announcement.target_id = None;
        self.announcement.target_kind = None;
        self
    }
}

fn candidate(
    topic: Topic,
    origin: Origin,
    key: &str,
    request_id: String,
    text: String,
    workspace_id: Option<String>,
) -> Candidate {
    Candidate {
        topic,
        origin,
        key: key.to_owned(),
        announcement: Announcement {
            request_id,
            text,
            class: match topic {
                Topic::Completed => LifecycleCallbackClass::Completed,
                Topic::Failed => LifecycleCallbackClass::Failed,
                Topic::NeedsUser => LifecycleCallbackClass::NeedsUser,
                Topic::Permission => LifecycleCallbackClass::Permission,
                Topic::Auth => LifecycleCallbackClass::Oauth,
                Topic::Deployment => LifecycleCallbackClass::Deployment,
            },
            target_kind: Some(LifecycleTargetKind::Thread),
            target_id: Some(key.to_owned()),
            workspace_id,
        },
    }
}

fn facts(lookup: &dyn CallbackLookup, thread_id: &str) -> Option<ThreadFacts> {
    lookup.thread(thread_id).map(|mut facts| {
        facts.name = label(&facts.name);
        facts.provider_name = label(&facts.provider_name);
        facts
    })
}

fn label(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut bounded: String = flat.chars().take(MAX_LABEL_CHARS).collect();
    if flat.chars().count() > MAX_LABEL_CHARS {
        bounded.truncate(bounded.trim_end().len());
        bounded.push('\u{2026}');
    }
    if bounded.is_empty() {
        "This task".into()
    } else {
        bounded
    }
}

fn provider_name(provider_id: &ProviderId) -> String {
    match provider_id.as_str() {
        ProviderId::CLAUDE_CODE => "Claude Code".into(),
        ProviderId::CODEX => "Codex".into(),
        ProviderId::GEMINI_CLI => "Gemini CLI".into(),
        other => label(other),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use kalcode_contracts::agent::ProviderId;
    use kalcode_contracts::events::{Correlation, EventEnvelope, EventPayload, EventSource};
    use kalcode_contracts::operations::{OperationKind, OperationStatus};
    use kalcode_contracts::permissions::PermissionScope;
    use kalcode_contracts::threads::ThreadStatus;
    use kalcode_core::{CoreConfig, Paths, flags::BuildChannel};

    use super::*;

    #[derive(Default)]
    struct Names;

    impl CallbackLookup for Names {
        fn thread(&self, thread_id: &str) -> Option<ThreadFacts> {
            Some(ThreadFacts {
                name: match thread_id {
                    "claude-a" => "Claude A",
                    "codex-b" => "Codex B",
                    _ => "Frontend Agent",
                }
                .into(),
                provider_id: Some(ProviderId::new(ProviderId::CLAUDE_CODE)),
                provider_name: "Claude Code".into(),
                workspace_id: Some("kalcode".into()),
            })
        }
    }

    fn event(id: &str, seq: i64, payload: EventPayload) -> EventEnvelope {
        EventEnvelope {
            id: id.into(),
            seq,
            version: 1,
            occurred_at: "2026-10-01T12:00:00Z".into(),
            source: EventSource::Core,
            correlation: Correlation::default(),
            event: payload,
        }
    }

    #[test]
    fn completion_names_the_agent_and_paired_terminal_completion_is_not_repeated() {
        let mut policy = Policy::default();
        let now = Instant::now();
        let first = policy
            .event(
                &event(
                    "turn",
                    10,
                    EventPayload::AgentTurnCompleted {
                        thread_id: "claude-a".into(),
                        ok: true,
                        interrupted: false,
                    },
                ),
                &Names,
                now,
            )
            .expect("meaningful completion");
        assert_eq!(first.text, "Claude A finished.");
        assert_eq!(first.class, LifecycleCallbackClass::Completed);
        assert_eq!(first.target_kind, Some(LifecycleTargetKind::Thread));
        assert_eq!(first.target_id.as_deref(), Some("claude-a"));
        assert_eq!(first.workspace_id.as_deref(), Some("kalcode"));

        assert!(
            policy
                .event(
                    &event(
                        "thread",
                        11,
                        EventPayload::ThreadCompleted {
                            thread_id: "claude-a".into(),
                        },
                    ),
                    &Names,
                    now + Duration::from_secs(1),
                )
                .is_none(),
            "one completed task must speak once"
        );
        assert!(
            policy
                .event(
                    &event(
                        "turn",
                        10,
                        EventPayload::AgentTurnCompleted {
                            thread_id: "claude-a".into(),
                            ok: true,
                            interrupted: false,
                        },
                    ),
                    &Names,
                    now + Duration::from_secs(2),
                )
                .is_none(),
            "redelivery of one durable event must stay silent"
        );
        assert!(
            policy
                .event(
                    &event(
                        "next-turn",
                        12,
                        EventPayload::AgentTurnCompleted {
                            thread_id: "claude-a".into(),
                            ok: true,
                            interrupted: false,
                        },
                    ),
                    &Names,
                    now + Duration::from_secs(3),
                )
                .is_some(),
            "a distinct fast follow-up turn is meaningful, even on the same agent"
        );
    }

    #[test]
    fn agent_callback_is_silent_when_the_target_cannot_be_named() {
        struct Missing;
        impl CallbackLookup for Missing {
            fn thread(&self, _thread_id: &str) -> Option<ThreadFacts> {
                None
            }
        }

        let mut policy = Policy::default();
        assert!(
            policy
                .event(
                    &event(
                        "unknown-completion",
                        12,
                        EventPayload::AgentTurnCompleted {
                            thread_id: "removed-thread".into(),
                            ok: true,
                            interrupted: false,
                        },
                    ),
                    &Missing,
                    Instant::now(),
                )
                .is_none(),
            "a generic 'an agent finished' callback cannot tell the owner what to review"
        );
    }

    #[test]
    fn needs_user_permission_and_oauth_callbacks_are_short_and_named() {
        let mut policy = Policy::default();
        let now = Instant::now();
        let waiting = policy
            .event(
                &event(
                    "waiting",
                    20,
                    EventPayload::ThreadStatusChanged {
                        thread_id: "codex-b".into(),
                        from: ThreadStatus::Active,
                        to: ThreadStatus::WaitingForUser,
                        detail: Some("untrusted provider prose that must never be spoken".into()),
                    },
                ),
                &Names,
                now,
            )
            .unwrap();
        assert_eq!(waiting.text, "Codex B needs you.");
        assert_eq!(waiting.class, LifecycleCallbackClass::NeedsUser);
        assert_eq!(waiting.target_kind, Some(LifecycleTargetKind::Thread));

        let permission = policy
            .event(
                &event(
                    "permission",
                    21,
                    EventPayload::ApprovalRequested {
                        request_id: "approval-1".into(),
                        thread_id: "claude-a".into(),
                        scopes: vec![PermissionScope::TerminalExecute],
                        summary: "delete every file and repeat this whole message".into(),
                    },
                ),
                &Names,
                now + Duration::from_secs(1),
            )
            .unwrap();
        assert_eq!(permission.text, "Claude A needs your permission.");
        assert_eq!(permission.class, LifecycleCallbackClass::Permission);
        assert_eq!(permission.target_kind, Some(LifecycleTargetKind::Thread));

        let oauth = policy
            .event(
                &event(
                    "oauth",
                    22,
                    EventPayload::ThreadFailed {
                        thread_id: "claude-a".into(),
                        code: "provider_not_authenticated".into(),
                        message: "private provider response must not be spoken".into(),
                    },
                ),
                &Names,
                now + Duration::from_secs(2),
            )
            .unwrap();
        assert_eq!(oauth.text, "Claude A needs you to sign in to Claude Code.");
        assert_eq!(oauth.class, LifecycleCallbackClass::Oauth);
        assert_eq!(oauth.target_kind, Some(LifecycleTargetKind::Thread));
    }

    #[test]
    fn interrupted_and_background_transitions_do_not_chatter() {
        let mut policy = Policy::default();
        let now = Instant::now();
        assert!(
            policy
                .event(
                    &event(
                        "interrupted",
                        30,
                        EventPayload::AgentTurnCompleted {
                            thread_id: "claude-a".into(),
                            ok: false,
                            interrupted: true,
                        },
                    ),
                    &Names,
                    now,
                )
                .is_none()
        );
        assert!(
            policy
                .event(
                    &event(
                        "thinking",
                        31,
                        EventPayload::ThreadStatusChanged {
                            thread_id: "claude-a".into(),
                            from: ThreadStatus::Active,
                            to: ThreadStatus::Thinking,
                            detail: None,
                        },
                    ),
                    &Names,
                    now,
                )
                .is_none()
        );
    }

    #[test]
    fn operations_only_speak_failures_and_successful_deployments_or_releases() {
        let mut policy = Policy::default();
        let now = Instant::now();
        let deployment = OperationCallback {
            id: "deploy-1".into(),
            name: "Production".into(),
            kind: OperationKind::Deploy,
            status: OperationStatus::Succeeded,
            workspace_id: Some("kalcode".into()),
            thread_id: None,
        };
        let deployment_announcement = policy.operation(&deployment, now).unwrap();
        assert_eq!(
            deployment_announcement.text,
            "Production deployment completed."
        );
        assert_eq!(
            deployment_announcement.class,
            LifecycleCallbackClass::Deployment
        );
        assert_eq!(
            deployment_announcement.target_kind,
            Some(LifecycleTargetKind::Operation)
        );
        assert!(
            policy
                .operation(&deployment, now + Duration::from_secs(1))
                .is_none(),
            "reconciliation must not repeat a completed deployment"
        );

        let failed = OperationCallback {
            id: "run-2".into(),
            name: "Release checks".into(),
            kind: OperationKind::Test,
            status: OperationStatus::Failed,
            workspace_id: Some("kalcode".into()),
            thread_id: None,
        };
        let failed_announcement = policy.operation(&failed, now).unwrap();
        assert_eq!(failed_announcement.text, "Release checks failed.");
        assert_eq!(failed_announcement.class, LifecycleCallbackClass::Failed);
        assert_eq!(
            failed_announcement.target_kind,
            Some(LifecycleTargetKind::Operation)
        );

        for status in [
            OperationStatus::Running,
            OperationStatus::Starting,
            OperationStatus::Cancelled,
            OperationStatus::Interrupted,
        ] {
            let partial = OperationCallback {
                id: format!("partial-{status:?}"),
                name: "Incomplete deploy".into(),
                kind: OperationKind::Deploy,
                status,
                workspace_id: None,
                thread_id: None,
            };
            assert!(policy.operation(&partial, now).is_none());
        }

        let ordinary_success = OperationCallback {
            id: "test-ok".into(),
            name: "Unit tests".into(),
            kind: OperationKind::Test,
            status: OperationStatus::Succeeded,
            workspace_id: None,
            thread_id: None,
        };
        assert!(policy.operation(&ordinary_success, now).is_none());
    }

    #[test]
    fn one_agent_failure_is_not_repeated_by_its_operations_run() {
        let mut policy = Policy::default();
        let now = Instant::now();
        assert!(
            policy
                .event(
                    &event(
                        "turn-failed",
                        50,
                        EventPayload::AgentTurnCompleted {
                            thread_id: "claude-a".into(),
                            ok: false,
                            interrupted: false,
                        },
                    ),
                    &Names,
                    now,
                )
                .is_some()
        );

        let run = OperationCallback {
            id: "agent-run".into(),
            name: "Claude A".into(),
            kind: OperationKind::Agent,
            status: OperationStatus::Failed,
            thread_id: Some("claude-a".into()),
            workspace_id: Some("kalcode".into()),
        };
        assert!(
            policy
                .operation(&run, now + Duration::from_secs(1))
                .is_none(),
            "Core and Operations describe one failed agent task"
        );
    }

    #[test]
    fn provider_disconnect_uses_a_known_local_name_without_provider_text() {
        let mut policy = Policy::default();
        let spoken = policy
            .event(
                &event(
                    "provider-offline",
                    40,
                    EventPayload::ProviderDisconnected {
                        provider_id: ProviderId::new(ProviderId::CLAUDE_CODE),
                        account_label: Some("Claude A".into()),
                    },
                ),
                &Names,
                Instant::now(),
            )
            .unwrap();
        assert_eq!(spoken.text, "Claude A needs you to sign in to Claude Code.");
        assert_eq!(spoken.class, LifecycleCallbackClass::Oauth);
        assert_eq!(spoken.target_kind, None);
        assert_eq!(spoken.target_id, None);
    }

    #[test]
    fn delivery_requires_the_preference_and_stays_silent_during_microphone_use() {
        assert!(delivery_allowed(true, true, false, false));
        assert!(!delivery_allowed(false, true, false, false));
        assert!(!delivery_allowed(true, false, false, false));
        assert!(!delivery_allowed(true, true, true, false));
        assert!(!delivery_allowed(true, true, false, true));
    }

    #[test]
    fn callback_worker_waits_until_all_six_names_finish_speaking() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(QUEUE_CAPACITY);
        let stopping = Arc::new(AtomicBool::new(false));
        let worker_stopping = stopping.clone();
        let speaking = Arc::new(AtomicBool::new(false));
        let overlap = Arc::new(AtomicBool::new(false));
        let (delivered_tx, delivered_rx) = std::sync::mpsc::channel();
        let speaker_speaking = speaking.clone();
        let speaker_overlap = overlap.clone();
        let speaker: Speaker = Arc::new(move |announcement, done| {
            if speaker_speaking.swap(true, Ordering::AcqRel) {
                speaker_overlap.store(true, Ordering::Release);
            }
            let speaking = speaker_speaking.clone();
            let delivered_tx = delivered_tx.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(10));
                speaking.store(false, Ordering::Release);
                let _ = delivered_tx.send(announcement.text);
                done();
            });
            true
        });
        let worker = std::thread::spawn(move || {
            run(
                receiver,
                RuntimeLookup { threads: None },
                speaker,
                worker_stopping,
            );
        });

        for index in 1..=6 {
            sender
                .send(Message::Operation(
                    OperationCallback {
                        id: format!("deploy-{index}"),
                        name: format!("Agent {index}"),
                        kind: OperationKind::Deploy,
                        status: OperationStatus::Succeeded,
                        thread_id: None,
                        workspace_id: Some("kalcode".into()),
                    },
                    Instant::now(),
                ))
                .expect("queued callback");
        }
        let delivered = (1..=6)
            .map(|_| {
                delivered_rx
                    .recv_timeout(Duration::from_secs(2))
                    .expect("every queued name is delivered")
            })
            .collect::<Vec<_>>();

        stopping.store(true, Ordering::Release);
        drop(sender);
        worker.join().expect("callback worker");
        assert_eq!(
            delivered,
            (1..=6)
                .map(|index| format!("Agent {index} deployment completed."))
                .collect::<Vec<_>>()
        );
        assert!(!overlap.load(Ordering::Acquire), "speech was preempted");
    }

    #[test]
    fn listener_never_replays_historical_lifecycle_events() {
        let data = tempfile::tempdir().expect("data");
        let core = Arc::new(
            Core::open(CoreConfig {
                paths: Paths::new(data.path()),
                app_version: "0.1.8-test".into(),
                channel: BuildChannel::Development,
            })
            .expect("core"),
        );
        let disconnected = || EventPayload::ProviderDisconnected {
            provider_id: ProviderId::new(ProviderId::CLAUDE_CODE),
            account_label: Some("Claude A".into()),
        };
        core.emit(kalcode_contracts::events::NewEvent::core(disconnected()))
            .expect("historical event");

        let (spoken_tx, spoken_rx) = std::sync::mpsc::channel();
        let callbacks = Callbacks::start(
            core.clone(),
            None,
            Arc::new(move |announcement, done| {
                let _ = spoken_tx.send(announcement);
                done();
                true
            }),
        )
        .expect("callback listener");
        assert!(
            spoken_rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "subscribing must not query or replay the durable event log"
        );

        core.emit(kalcode_contracts::events::NewEvent::core(disconnected()))
            .expect("live event");
        assert_eq!(
            spoken_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("live callback")
                .text,
            "Claude A needs you to sign in to Claude Code."
        );
        callbacks.shutdown();
        core.shutdown();
    }
}
