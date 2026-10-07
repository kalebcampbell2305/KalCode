//! Request de-duplication (§1 replay protection, §4 offline queue).
//!
//! Every request carries a unique `id`. The host remembers the last [`CAPACITY`] results per
//! device and answers a repeated id with the stored result instead of acting twice, across
//! reconnects. A repeat that arrives while the first is still running is answered `conflict`
//! by the connection driver; at most [`MAX_PENDING`] requests per device run at once.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::wire::Response;

/// Results remembered per device.
pub const CAPACITY: usize = 512;

/// Requests running at once per device, across its sessions.
pub const MAX_PENDING: usize = 64;

/// What to do with an incoming request id.
#[derive(Debug)]
pub enum Begin {
    /// First time: run it, then call [`Dedupe::finish`] (or [`Dedupe::abandon`]).
    Run,
    /// Already answered: resend this.
    Done(Response),
    /// Still running.
    Pending,
    /// The device already has [`MAX_PENDING`] requests running.
    Full,
}

#[derive(Default)]
struct DeviceSlots {
    done: HashMap<String, Response>,
    /// Least recently used first.
    order: VecDeque<String>,
    pending: HashSet<String>,
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
        if slots.pending.contains(id) {
            return Begin::Pending;
        }
        if slots.pending.len() >= MAX_PENDING {
            return Begin::Full;
        }
        slots.pending.insert(id.to_owned());
        Begin::Run
    }

    /// Forgets a request started with [`Begin::Run`] that was refused before it ran (rate
    /// limited, too many in flight): a later retry with the same id runs normally.
    pub fn abandon(&self, device: &str, id: &str) {
        if let Some(slots) = self.lock().get_mut(device) {
            slots.pending.remove(id);
        }
    }

    /// Stores the result of a request started with [`Begin::Run`].
    pub fn finish(&self, device: &str, id: &str, response: Response) {
        let mut devices = self.lock();
        let slots = devices.entry(device.to_owned()).or_default();
        slots.pending.remove(id);
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
        assert!(matches!(dedupe.begin("dev_a", "r1"), Begin::Pending));
        let response = Response::success("r1", json!({"summary":"ok"}));
        dedupe.finish("dev_a", "r1", response.clone());
        let Begin::Done(again) = dedupe.begin("dev_a", "r1") else {
            panic!("expected done")
        };
        assert_eq!(again, response);
        // Ids are per device.
        assert!(matches!(dedupe.begin("dev_b", "r1"), Begin::Run));
    }

    #[test]
    fn pending_is_bounded_and_abandon_forgets() {
        let dedupe = Dedupe::new();
        for i in 0..MAX_PENDING {
            assert!(matches!(dedupe.begin("d", &format!("p{i}")), Begin::Run));
        }
        assert!(matches!(dedupe.begin("d", "one-more"), Begin::Full));
        assert!(matches!(dedupe.begin("other", "x"), Begin::Run));
        dedupe.abandon("d", "p0");
        assert!(dedupe.get("d", "p0").is_none());
        assert!(matches!(dedupe.begin("d", "p0"), Begin::Run));
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
