//! Request de-duplication (§1 replay protection, §4 offline queue).
//!
//! Every request carries a unique `id`. The host remembers the last [`CAPACITY`] results per
//! device and answers a repeated id with the stored result instead of acting twice, across
//! reconnects. A repeat that arrives while the first is still running waits for its result.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard, PoisonError};

use tokio::sync::watch;

use crate::wire::Response;

/// Results remembered per device.
pub const CAPACITY: usize = 512;

/// What to do with an incoming request id.
#[derive(Debug)]
pub enum Begin {
    /// First time: run it, then call [`Dedupe::finish`].
    Run,
    /// Already answered: resend this.
    Done(Response),
    /// Still running: wait for the value to become `Some`.
    Pending(watch::Receiver<Option<Response>>),
}

#[derive(Default)]
struct DeviceSlots {
    done: HashMap<String, Response>,
    /// Least recently used first.
    order: VecDeque<String>,
    pending: HashMap<String, watch::Sender<Option<Response>>>,
}

/// Per-device LRU of request id → response.
#[derive(Default)]
pub struct Dedupe {
    devices: Mutex<HashMap<String, DeviceSlots>>,
}

impl Dedupe {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, DeviceSlots>> {
        self.devices.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Classifies request `id` from `device`, marking it running when new.
    pub fn begin(&self, device: &str, id: &str) -> Begin {
        let mut devices = self.lock();
        let slots = devices.entry(device.to_owned()).or_default();
        if let Some(response) = slots.done.get(id).cloned() {
            touch(&mut slots.order, id);
            return Begin::Done(response);
        }
        if let Some(sender) = slots.pending.get(id) {
            return Begin::Pending(sender.subscribe());
        }
        slots.pending.insert(id.to_owned(), watch::channel(None).0);
        Begin::Run
    }

    /// Stores the result of a request started with [`Begin::Run`] and wakes any waiters.
    pub fn finish(&self, device: &str, id: &str, response: Response) {
        let mut devices = self.lock();
        let slots = devices.entry(device.to_owned()).or_default();
        if let Some(sender) = slots.pending.remove(id) {
            sender.send_replace(Some(response.clone()));
        }
        if slots.done.insert(id.to_owned(), response).is_some() {
            touch(&mut slots.order, id);
        } else {
            slots.order.push_back(id.to_owned());
        }
        while slots.order.len() > CAPACITY {
            if let Some(old) = slots.order.pop_front() {
                slots.done.remove(&old);
            }
        }
    }

    /// The stored result for `id`, if remembered.
    pub fn get(&self, device: &str, id: &str) -> Option<Response> {
        self.lock()
            .get(device)
            .and_then(|s| s.done.get(id).cloned())
    }
}

fn touch(order: &mut VecDeque<String>, id: &str) {
    if let Some(at) = order.iter().position(|x| x == id)
        && let Some(entry) = order.remove(at)
    {
        order.push_back(entry);
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]
    use serde_json::json;

    use super::*;

    #[test]
    fn repeated_id_returns_stored_result() {
        let dedupe = Dedupe::new();
        assert!(matches!(dedupe.begin("dev_a", "r1"), Begin::Run));
        let Begin::Pending(mut waiter) = dedupe.begin("dev_a", "r1") else {
            panic!("expected pending")
        };
        let response = Response::success("r1", json!({"summary":"ok"}));
        dedupe.finish("dev_a", "r1", response.clone());
        assert_eq!(waiter.borrow_and_update().clone(), Some(response.clone()));
        let Begin::Done(again) = dedupe.begin("dev_a", "r1") else {
            panic!("expected done")
        };
        assert_eq!(again, response);
        // Ids are per device.
        assert!(matches!(dedupe.begin("dev_b", "r1"), Begin::Run));
    }

    #[test]
    fn keeps_the_last_512() {
        let dedupe = Dedupe::new();
        for i in 0..=CAPACITY {
            let id = format!("r{i}");
            assert!(matches!(dedupe.begin("d", &id), Begin::Run));
            dedupe.finish("d", &id, Response::success(id.clone(), json!(i)));
            if i == 0 {
                // Recently used entries survive eviction.
                continue;
            }
            if i == 1 {
                assert!(matches!(dedupe.begin("d", "r0"), Begin::Done(_)));
            }
        }
        assert!(
            dedupe.get("d", "r0").is_some(),
            "r0 was touched, so r1 is the oldest"
        );
        assert!(dedupe.get("d", "r1").is_none());
        assert!(dedupe.get("d", "r512").is_some());
    }
}
