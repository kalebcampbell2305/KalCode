//! Bounded in-memory sample history. Nothing is persisted (no table, no migration): samples are
//! never events and never stored (`docs/CONTRACTS_ADVANCED.md` §9, v14 note).

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::MIB;
use crate::model::{PressureLevel, ResourceSnapshot};

/// A compact history row (about 60 bytes), enough for sparklines.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub seq: u64,
    pub at_unix_ms: i64,
    pub cpu_percent: Option<f32>,
    pub memory_used_percent: Option<f32>,
    pub kalcode_cpu_percent: Option<f32>,
    pub kalcode_rss_mb: Option<u64>,
    pub disk_read_bytes_per_sec: Option<u64>,
    pub disk_write_bytes_per_sec: Option<u64>,
    pub overall: Option<PressureLevel>,
}

impl HistoryPoint {
    pub fn from_snapshot(snapshot: &ResourceSnapshot) -> Self {
        let tree = snapshot.kalcode_tree.value();
        let io = snapshot.disk_io.value();
        Self {
            seq: snapshot.seq,
            at_unix_ms: snapshot.sampled_at_unix_ms,
            cpu_percent: snapshot.cpu.value().map(|c| c.total_percent),
            memory_used_percent: snapshot.memory.value().map(|m| m.used_percent),
            kalcode_cpu_percent: tree.map(|t| t.total_cpu_percent),
            kalcode_rss_mb: tree.map(|t| t.total_rss_bytes / MIB),
            disk_read_bytes_per_sec: io.map(|r| r.read_bytes_per_sec),
            disk_write_bytes_per_sec: io.map(|r| r.write_bytes_per_sec),
            overall: snapshot.pressure.overall(),
        }
    }
}

/// A fixed-capacity ring: pushing onto a full ring drops the oldest item.
#[derive(Debug, Clone)]
pub struct Ring<T> {
    items: VecDeque<T>,
    capacity: usize,
}

impl<T: Clone> Ring<T> {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            items: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    pub fn push(&mut self, item: T) {
        if self.items.len() == self.capacity {
            self.items.pop_front();
        }
        self.items.push_back(item);
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Oldest first.
    pub fn to_vec(&self) -> Vec<T> {
        self.items.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_the_newest_items() {
        let mut ring = Ring::new(3);
        assert!(ring.is_empty());
        for i in 0..5 {
            ring.push(i);
        }
        assert_eq!(ring.to_vec(), vec![2, 3, 4]);
        assert_eq!((ring.len(), ring.capacity()), (3, 3));
        assert_eq!(Ring::<u8>::new(0).capacity(), 1);
    }
}
