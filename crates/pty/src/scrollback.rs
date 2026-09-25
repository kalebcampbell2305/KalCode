//! Bounded byte history for replaying terminal output.

use std::collections::VecDeque;

/// Keeps the most recent `capacity` bytes. When trimming, it drops whole lines where possible
/// so a replay does not start in the middle of an escape sequence or a UTF-8 character.
#[derive(Debug)]
pub struct Scrollback {
    bytes: VecDeque<u8>,
    capacity: usize,
}

impl Scrollback {
    pub fn new(capacity: usize) -> Self {
        Self {
            bytes: VecDeque::with_capacity(capacity.min(64 * 1024)),
            capacity,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        if chunk.len() >= self.capacity {
            self.bytes.clear();
            self.bytes.extend(&chunk[chunk.len() - self.capacity..]);
        } else {
            self.bytes.extend(chunk);
        }
        if self.bytes.len() > self.capacity {
            let mut excess = self.bytes.len() - self.capacity;
            // Advance to just past the next newline within a small window, if there is one.
            if let Some(newline) = self
                .bytes
                .iter()
                .skip(excess)
                .take(4096)
                .position(|&b| b == b'\n')
            {
                excess += newline + 1;
            }
            self.bytes.drain(..excess.min(self.bytes.len()));
        }
    }

    pub fn contents(&self) -> Vec<u8> {
        self.bytes.iter().copied().collect()
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}
