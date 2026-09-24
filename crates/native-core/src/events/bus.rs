//! In-process fan-out of persisted events to live subscribers (e.g. Tauri channels).

use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use super::EventEnvelope;

pub type SubscriptionId = u64;

/// A subscriber returns `false` when it can no longer receive events (e.g. its window closed);
/// it is then removed.
type Subscriber = Box<dyn Fn(&EventEnvelope) -> bool + Send + Sync>;

#[derive(Default)]
pub struct EventBus {
    next_id: AtomicU64,
    subscribers: Mutex<Vec<(SubscriptionId, Subscriber)>>,
}

impl EventBus {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(
        &self,
        subscriber: impl Fn(&EventEnvelope) -> bool + Send + Sync + 'static,
    ) -> SubscriptionId {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.lock().push((id, Box::new(subscriber)));
        id
    }

    /// Returns `true` if the subscription existed.
    pub fn unsubscribe(&self, id: SubscriptionId) -> bool {
        let mut subs = self.lock();
        let before = subs.len();
        subs.retain(|(sid, _)| *sid != id);
        subs.len() != before
    }

    pub fn publish(&self, event: &EventEnvelope) {
        self.lock().retain(|(id, deliver)| {
            let alive = deliver(event);
            if !alive {
                tracing::debug!(event = "events.subscriber_dropped", subscription = id);
            }
            alive
        });
    }

    pub fn subscriber_count(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<(SubscriptionId, Subscriber)>> {
        // A panicking subscriber must not take the bus down with it.
        self.subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use crate::events::{Correlation, EventPayload, EventSource};

    fn event(seq: i64) -> EventEnvelope {
        EventEnvelope {
            id: seq.to_string(),
            seq,
            version: 1,
            occurred_at: String::new(),
            source: EventSource::Core,
            correlation: Correlation::default(),
            event: EventPayload::AppStopped { uptime_ms: 0 },
        }
    }

    #[test]
    fn delivers_to_all_until_unsubscribed() {
        let bus = EventBus::new();
        let count = Arc::new(AtomicUsize::new(0));
        let c1 = count.clone();
        let c2 = count.clone();
        let a = bus.subscribe(move |_| {
            c1.fetch_add(1, Ordering::SeqCst);
            true
        });
        bus.subscribe(move |_| {
            c2.fetch_add(1, Ordering::SeqCst);
            true
        });
        bus.publish(&event(1));
        assert_eq!(count.load(Ordering::SeqCst), 2);
        assert!(bus.unsubscribe(a));
        assert!(!bus.unsubscribe(a));
        bus.publish(&event(2));
        assert_eq!(count.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn dead_subscribers_are_removed() {
        let bus = EventBus::new();
        bus.subscribe(|_| false);
        bus.subscribe(|_| true);
        bus.publish(&event(1));
        assert_eq!(bus.subscriber_count(), 1);
    }
}
