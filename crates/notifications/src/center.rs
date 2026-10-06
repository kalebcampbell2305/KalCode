//! The notification center: one store and policy, used by every system that notifies, and the
//! listener that turns runtime events into notifications.
//!
//! Backends: the v10 SQLite table when it exists (row and `notification.created` event commit in
//! one transaction), otherwise an in-memory table (bounded, lost on exit) until the lead registers
//! v10. Both run the same policy (`store.rs`).

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use kalcode_contracts::events::{Correlation, EventEnvelope, EventPayload, NewEvent};
use kalcode_contracts::notifications::{
    Notification, NotificationEntityKind, NotificationMark, NotificationPage,
};
use kalcode_core::events::SubscriptionId;
use kalcode_core::{Core, Result};
use time::OffsetDateTime;

use crate::derive::{Derived, Draft, Lookup, ThreadInfo, derive};
use crate::store::{self, Budget, Key, MemoryTable, SqlTable};

/// Time source (injectable for tests).
pub trait Clock: Send + Sync {
    fn now(&self) -> OffsetDateTime;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}

enum Backend {
    Sql,
    Memory(Mutex<MemoryTable>),
}

pub struct NotificationCenter {
    core: Arc<Core>,
    backend: Backend,
    budget: Mutex<Budget>,
    clock: Arc<dyn Clock>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn created_event(n: &Notification) -> NewEvent {
    let entity = n.entity_id.clone();
    let correlation = Correlation {
        workspace_id: n.workspace_id.clone(),
        thread_id: (n.entity_kind == Some(NotificationEntityKind::Thread))
            .then(|| entity.clone())
            .flatten(),
        provider_id: (n.entity_kind == Some(NotificationEntityKind::Provider))
            .then(|| entity.clone())
            .flatten(),
        ..Correlation::default()
    };
    NewEvent::core(EventPayload::NotificationCreated {
        notification_id: n.id.clone(),
        kind: n.kind,
        severity: n.severity,
        entity_kind: n.entity_kind,
        entity_id: n.entity_id.clone(),
    })
    .with_correlation(correlation)
}

impl NotificationCenter {
    pub fn open(core: Arc<Core>) -> Result<Self> {
        Self::with_clock(core, Arc::new(SystemClock))
    }

    pub fn with_clock(core: Arc<Core>, clock: Arc<dyn Clock>) -> Result<Self> {
        let persisted = core.read(store::table_exists)?;
        let backend = if persisted {
            Backend::Sql
        } else {
            tracing::warn!(
                event = "notifications.not_persisted",
                reason = "the notifications table (migration v10) is missing; notifications last until KalCode closes"
            );
            Backend::Memory(Mutex::new(MemoryTable::default()))
        };
        Ok(Self {
            core,
            backend,
            budget: Mutex::new(Budget::default()),
            clock,
        })
    }

    /// Whether notifications survive a restart (the v10 table exists).
    pub fn persisted(&self) -> bool {
        matches!(self.backend, Backend::Sql)
    }

    /// Raises a notification (the API other systems use). Returns it when it was created or
    /// re-raised, `None` when the rate limit dropped it. Emits `notification.created`.
    pub fn raise(&self, draft: &Draft) -> Result<Option<Notification>> {
        let now = self.clock.now();
        match &self.backend {
            Backend::Sql => {
                let (raised, _) = self.core.write_with_events(|tx| {
                    let mut budget = lock(&self.budget);
                    let raised = store::raise(&mut SqlTable(tx), &mut budget, draft, now)?;
                    let events = raised.iter().map(created_event).collect();
                    Ok((raised, events))
                })?;
                Ok(raised)
            }
            Backend::Memory(table) => {
                let raised = {
                    let mut table = lock(table);
                    let mut budget = lock(&self.budget);
                    store::raise(&mut *table, &mut budget, draft, now)?
                };
                if let Some(n) = &raised {
                    self.core.emit(created_event(n))?;
                }
                Ok(raised)
            }
        }
    }

    /// Marks the unread notifications for `key` read (handled elsewhere).
    pub fn settle(&self, key: &Key) -> Result<u32> {
        let now = self.clock.now();
        match &self.backend {
            Backend::Sql => Ok(self
                .core
                .write_with_events(|tx| Ok((store::settle(&mut SqlTable(tx), key, now)?, vec![])))?
                .0),
            Backend::Memory(table) => store::settle(&mut *lock(table), key, now),
        }
    }

    /// Applies what an event means.
    pub fn apply(&self, derived: &Derived) -> Result<Option<Notification>> {
        match derived {
            Derived::Raise(draft) => self.raise(draft),
            Derived::Settle {
                kind,
                entity_kind,
                entity_id,
            } => {
                self.settle(&Key {
                    kind: *kind,
                    entity_kind: Some(*entity_kind),
                    entity_id: Some(entity_id.clone()),
                })?;
                Ok(None)
            }
        }
    }

    /// Derives and applies one event.
    pub fn handle(
        &self,
        event: &EventEnvelope,
        lookup: &dyn Lookup,
    ) -> Result<Option<Notification>> {
        match derive(event, lookup) {
            Some(derived) => self.apply(&derived),
            None => Ok(None),
        }
    }

    /// `notification_list`.
    pub fn list(
        &self,
        unread_only: bool,
        limit: u32,
        before: Option<&str>,
    ) -> Result<NotificationPage> {
        match &self.backend {
            Backend::Sql => self
                .core
                .read(|conn| store::list(&mut SqlTable(conn), unread_only, limit, before)),
            Backend::Memory(table) => store::list(&mut *lock(table), unread_only, limit, before),
        }
    }

    /// `notification_mark`.
    pub fn mark(&self, ids: Option<&[String]>, mark: NotificationMark) -> Result<u32> {
        let now = self.clock.now();
        match &self.backend {
            Backend::Sql => Ok(self
                .core
                .write_with_events(|tx| {
                    Ok((store::mark(&mut SqlTable(tx), ids, mark, now)?, vec![]))
                })?
                .0),
            Backend::Memory(table) => store::mark(&mut *lock(table), ids, mark, now),
        }
    }
}

// ---------- Listener ----------

/// Events the listener queues; everything else is ignored at the subscriber.
fn relevant(event: &EventEnvelope) -> bool {
    matches!(
        event.event,
        EventPayload::ThreadCompleted { .. }
            | EventPayload::ThreadFailed { .. }
            | EventPayload::ThreadStatusChanged { .. }
            | EventPayload::ApprovalRequested { .. }
            | EventPayload::ApprovalApproved { .. }
            | EventPayload::ApprovalDenied { .. }
            | EventPayload::ApprovalExpired { .. }
            | EventPayload::ProviderDisconnected { .. }
    )
}

/// Queued events beyond this are dropped (with a warning) rather than blocking the event bus.
const QUEUE: usize = 1024;

/// A lookup that knows nothing: used when nothing was bound in time.
struct Unbound;

impl Lookup for Unbound {
    fn thread(&self, _: &str) -> Option<ThreadInfo> {
        None
    }
}

/// Turns runtime events into notifications on a worker thread.
///
/// Subscribe early (before the thread runtime starts, so its crash-recovery events are seen),
/// then [`Listener::bind`] the lookup once the other runtimes exist. The worker waits up to
/// `bind_timeout` for it, then carries on with neutral names.
pub struct Listener {
    core: Arc<Core>,
    subscription: SubscriptionId,
    lookup: Arc<OnceLock<Arc<dyn Lookup + Send + Sync>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Listener {
    pub fn start(core: Arc<Core>, center: Arc<NotificationCenter>, bind_timeout: Duration) -> Self {
        let (tx, rx): (SyncSender<EventEnvelope>, Receiver<EventEnvelope>) =
            mpsc::sync_channel(QUEUE);
        // Subscribers run while the core's connection lock is held: never call back into the
        // core here, never block. Only forward.
        let subscription = core.subscribe(move |event| {
            if !relevant(event) {
                return true;
            }
            match tx.try_send(event.clone()) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => {
                    tracing::warn!(event = "notifications.queue_full", seq = event.seq);
                    true
                }
                Err(TrySendError::Disconnected(_)) => false,
            }
        });
        let lookup: Arc<OnceLock<Arc<dyn Lookup + Send + Sync>>> = Arc::new(OnceLock::new());
        let bound = Arc::clone(&lookup);
        let worker = std::thread::Builder::new()
            .name("kalcode-notifications".into())
            .spawn(move || run(&center, &rx, &bound, bind_timeout))
            .map_err(|error| {
                tracing::error!(event = "notifications.worker_failed", error = %error);
            })
            .ok();
        Self {
            core,
            subscription,
            lookup,
            worker: Mutex::new(worker),
        }
    }

    /// Supplies names and thread facts. Only the first call counts.
    pub fn bind(&self, lookup: Arc<dyn Lookup + Send + Sync>) {
        let _ = self.lookup.set(lookup);
    }

    /// Stops listening and waits for queued events to be processed.
    pub fn shutdown(&self) {
        // Dropping the subscription drops its sender, which ends the worker.
        self.core.unsubscribe(self.subscription);
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
    }
}

fn run(
    center: &NotificationCenter,
    rx: &Receiver<EventEnvelope>,
    lookup: &OnceLock<Arc<dyn Lookup + Send + Sync>>,
    bind_timeout: Duration,
) {
    let started = Instant::now();
    let unbound = Unbound;
    loop {
        let event = match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(event) => event,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        // Wait (bounded) for the lookup, so early events get real names.
        while lookup.get().is_none() && started.elapsed() < bind_timeout {
            std::thread::sleep(Duration::from_millis(25));
        }
        let current: &dyn Lookup = match lookup.get() {
            Some(bound) => bound.as_ref(),
            None => &unbound,
        };
        if let Err(error) = center.handle(&event, current) {
            tracing::error!(event = "notifications.handle_failed", seq = event.seq, error = %error.diagnostic());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::events::EventSource;
    use kalcode_contracts::notifications::NotificationKind;
    use kalcode_contracts::threads::ThreadStatus;
    use kalcode_core::db::Migration;

    const RECOVERED: &str = "KalCode closed while this thread was running";

    struct Names;

    impl Lookup for Names {
        fn thread(&self, thread_id: &str) -> Option<ThreadInfo> {
            Some(ThreadInfo {
                name: format!("Thread {thread_id}"),
                provider_name: Some("Claude Code".into()),
                workspace_id: Some("w".into()),
                workspace_name: Some("kalcode".into()),
                pending_approvals: 0,
            })
        }

        fn recovered_detail(&self) -> Option<&str> {
            Some(RECOVERED)
        }
    }

    fn core(dir: &std::path::Path, migrations: &[Migration]) -> Arc<Core> {
        Arc::new(
            Core::open_with_migrations(
                kalcode_core::CoreConfig {
                    paths: kalcode_core::Paths::new(dir),
                    app_version: "0.1.0-test".into(),
                    channel: kalcode_core::flags::BuildChannel::Development,
                },
                migrations,
            )
            .expect("core"),
        )
    }

    fn with_notifications() -> Vec<Migration> {
        kalcode_core::db::MIGRATIONS.to_vec()
    }

    fn emit(core: &Core, payload: EventPayload) {
        core.emit(NewEvent::core(payload)).expect("emit");
    }

    fn wait_for(center: &NotificationCenter, n: usize) -> NotificationPage {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let page = center.list(false, 200, None).expect("list");
            if page.notifications.len() >= n || Instant::now() > deadline {
                return page;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn created_events(core: &Core) -> usize {
        core.recent_events(500, None)
            .expect("events")
            .iter()
            .filter(|e| e.event.type_name() == "notification.created")
            .count()
    }

    fn listener_flow(migrations: &[Migration], persisted: bool) {
        let dir = tempfile::tempdir().expect("dir");
        let core = core(dir.path(), migrations);
        let center = Arc::new(NotificationCenter::open(core.clone()).expect("center"));
        assert_eq!(center.persisted(), persisted);
        let listener = Listener::start(core.clone(), center.clone(), Duration::from_secs(5));
        // Events before bind wait for it (up to the timeout).
        emit(
            &core,
            EventPayload::ThreadStatusChanged {
                thread_id: "a".into(),
                from: ThreadStatus::Active,
                to: ThreadStatus::Interrupted,
                detail: Some(RECOVERED.into()),
            },
        );
        listener.bind(Arc::new(Names));
        emit(
            &core,
            EventPayload::ThreadStatusChanged {
                thread_id: "b".into(),
                from: ThreadStatus::Thinking,
                to: ThreadStatus::Interrupted,
                detail: Some(RECOVERED.into()),
            },
        );
        emit(
            &core,
            EventPayload::ThreadCompleted {
                thread_id: "t1".into(),
            },
        );
        let page = wait_for(&center, 2);
        listener.shutdown();
        assert_eq!(page.notifications.len(), 2);
        assert_eq!(page.unread_count, 2);
        let of = |kind| {
            page.notifications
                .iter()
                .find(|n| n.kind == kind)
                .expect("notification of kind")
        };
        let done = of(NotificationKind::ThreadCompleted);
        assert_eq!(done.title, "Thread t1 completed");
        let recovery = of(NotificationKind::RecoveryAvailable);
        assert_eq!(recovery.count, 2);
        assert_eq!(recovery.title, "2 threads can be resumed");
        // One `notification.created` per raise (2 recoveries + 1 completion), never re-derived.
        assert_eq!(created_events(&core), 3);

        assert_eq!(
            center
                .mark(Some(std::slice::from_ref(&done.id)), NotificationMark::Read)
                .expect("mark"),
            1
        );
        assert_eq!(center.list(true, 10, None).expect("unread").unread_count, 1);
    }

    #[test]
    fn the_listener_works_on_the_sqlite_table() {
        listener_flow(&with_notifications(), true);
    }

    #[test]
    fn the_listener_falls_back_to_memory_without_the_v10_table() {
        // A database from a build without migration v10 (an older KalCode) has no table.
        let before_v10: Vec<Migration> = kalcode_core::db::MIGRATIONS
            .iter()
            .filter(|m| m.version < 10)
            .cloned()
            .collect();
        listener_flow(&before_v10, false);
    }

    /// The thread runtime lowers its pending count on its own event thread, so the center can
    /// see an answered approval while the count still includes it.
    struct StalePending;

    impl Lookup for StalePending {
        fn thread(&self, thread_id: &str) -> Option<ThreadInfo> {
            Some(ThreadInfo {
                name: format!("Thread {thread_id}"),
                pending_approvals: 1,
                ..ThreadInfo::default()
            })
        }
    }

    #[test]
    fn a_permission_notice_settles_when_the_count_lags_the_answer() {
        use kalcode_contracts::permissions::ApprovalDecision;
        let dir = tempfile::tempdir().expect("dir");
        let core = core(dir.path(), &with_notifications());
        let center = NotificationCenter::open(core).expect("center");
        let envelope = |seq, event| EventEnvelope {
            id: format!("e{seq}"),
            seq,
            version: 1,
            occurred_at: String::new(),
            source: EventSource::Core,
            correlation: Correlation::default(),
            event,
        };
        let raised = center
            .handle(
                &envelope(
                    1,
                    EventPayload::ApprovalRequested {
                        request_id: "r".into(),
                        thread_id: "t".into(),
                        scopes: Vec::new(),
                        summary: "Run npm test".into(),
                    },
                ),
                &StalePending,
            )
            .expect("handle")
            .expect("raised");
        assert_eq!(raised.kind, NotificationKind::PermissionRequired);
        center
            .handle(
                &envelope(
                    2,
                    EventPayload::ApprovalApproved {
                        request_id: "r".into(),
                        thread_id: "t".into(),
                        decision: ApprovalDecision::ApproveOnce,
                    },
                ),
                &StalePending,
            )
            .expect("handle");
        // The runtime then records the answer and resumes the thread.
        center
            .handle(
                &envelope(
                    3,
                    EventPayload::ThreadStatusChanged {
                        thread_id: "t".into(),
                        from: ThreadStatus::WaitingForPermission,
                        to: ThreadStatus::Active,
                        detail: None,
                    },
                ),
                &StalePending,
            )
            .expect("handle");
        let page = center.list(false, 10, None).expect("list");
        assert_eq!(
            page.unread_count, 0,
            "the answered request's notice is read"
        );
        assert!(page.notifications[0].read_at.is_some());
    }

    #[test]
    fn sqlite_notifications_survive_a_restart() {
        let dir = tempfile::tempdir().expect("dir");
        let migrations = with_notifications();
        let id = {
            let core = core(dir.path(), &migrations);
            let center = NotificationCenter::open(core.clone()).expect("center");
            let n = center
                .handle(
                    &EventEnvelope {
                        id: "e".into(),
                        seq: 1,
                        version: 1,
                        occurred_at: String::new(),
                        source: EventSource::Core,
                        correlation: Correlation::default(),
                        event: EventPayload::ThreadFailed {
                            thread_id: "t".into(),
                            code: "x".into(),
                            message: "It stopped.".into(),
                        },
                    },
                    &Names,
                )
                .expect("handle")
                .expect("created");
            center
                .mark(Some(std::slice::from_ref(&n.id)), NotificationMark::Read)
                .expect("read");
            core.shutdown();
            n.id
        };
        let core = core(dir.path(), &migrations);
        let center = NotificationCenter::open(core).expect("center");
        let page = center.list(false, 10, None).expect("list");
        assert_eq!(page.notifications.len(), 1);
        assert_eq!(page.notifications[0].id, id);
        assert!(
            page.notifications[0].read_at.is_some(),
            "read state persists"
        );
        assert_eq!(page.unread_count, 0);
    }
}
