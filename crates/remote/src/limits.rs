//! Resource limits and timeouts (§3, §4). [`Limits::default`] holds the production values;
//! tests shrink them so timeouts fire in milliseconds.

use std::time::Duration;

/// A token bucket: up to `burst` requests at once, refilled by one every `refill`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rate {
    pub burst: u32,
    pub refill: Duration,
}

impl Rate {
    /// `n` per minute, with a burst of `n`.
    pub const fn per_minute(n: u32) -> Self {
        Self {
            burst: n,
            refill: Duration::from_millis(60_000 / n as u64),
        }
    }
}

/// Every limit the connection driver enforces. Shared through [`crate::server::Hub`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// Handshakes in progress at once, across all sources ([`crate::server::Hub::admit`]).
    pub max_handshakes: usize,
    /// Handshakes in progress at once from one source IP.
    pub max_handshakes_per_ip: usize,
    /// A write that makes no progress for this long drops the connection, and a closing
    /// connection gets this long to flush its `bye`.
    pub write_timeout: Duration,
    /// Either side treats this much silence as a dead connection.
    pub silence_timeout: Duration,
    /// State changes are coalesced into one patch per this window.
    pub patch_debounce: Duration,
    /// Largest device → desktop application message (desktop → device stays 8 MiB).
    pub max_inbound_message: usize,
    /// Bytes queued for a device that is not reading before the connection is dropped.
    pub max_outbound_queue: usize,
    /// Requests running at once per connection; more are answered `unavailable`.
    pub max_in_flight: usize,
    /// Live sessions per device; a newer one closes the oldest with `bye replaced`.
    pub max_sessions_per_device: usize,
    /// `agent.launch`.
    pub launch_rate: Rate,
    /// `agent.prompt`, `agent.stop`, `agent.retry`, `needs.decide`, `voice.command`,
    /// `tidy.closeIdle`.
    pub action_rate: Rate,
    /// `agent.detail`, `agent.diff`, `agent.log`, `launch.options`, `run.detail`.
    pub read_rate: Rate,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_handshakes: 32,
            max_handshakes_per_ip: 4,
            write_timeout: Duration::from_secs(10),
            silence_timeout: crate::SILENCE_TIMEOUT,
            patch_debounce: crate::PATCH_DEBOUNCE,
            max_inbound_message: crate::transport::MAX_INBOUND_MESSAGE,
            max_outbound_queue: 2 * crate::transport::MAX_APP_MESSAGE,
            max_in_flight: 16,
            max_sessions_per_device: 2,
            launch_rate: Rate::per_minute(5),
            action_rate: Rate::per_minute(30),
            read_rate: Rate {
                burst: 20,
                refill: Duration::from_millis(100),
            },
        }
    }
}
