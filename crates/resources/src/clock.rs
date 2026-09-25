//! Time sources. The governor reads time only through [`Clock`], so tests drive it with a manual
//! clock and every cadence/hysteresis decision is reproducible.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    /// Monotonic time since an arbitrary origin.
    fn monotonic(&self) -> Duration;
    /// Wall-clock time, Unix milliseconds (UTC). Used only to label samples.
    fn unix_ms(&self) -> i64;
}

/// The real clock.
#[derive(Debug, Clone)]
pub struct SystemClock {
    origin: Instant,
}

impl Default for SystemClock {
    fn default() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl Clock for SystemClock {
    fn monotonic(&self) -> Duration {
        self.origin.elapsed()
    }

    fn unix_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
    }
}

#[cfg(test)]
pub(crate) mod manual {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    use super::Clock;

    /// A test clock. It moves when told to, and additionally by `auto_step` every time it is
    /// read (a "racing" clock makes every sample due at once, so thread tests run fast).
    #[derive(Debug, Default)]
    pub struct ManualClock {
        nanos: AtomicU64,
        auto_step: u64,
    }

    impl ManualClock {
        pub fn racing(step: Duration) -> Self {
            Self {
                nanos: AtomicU64::new(0),
                auto_step: nanos(step),
            }
        }

        pub fn advance(&self, by: Duration) {
            self.nanos.fetch_add(nanos(by), Ordering::SeqCst);
        }
    }

    fn nanos(d: Duration) -> u64 {
        u64::try_from(d.as_nanos()).unwrap_or(u64::MAX)
    }

    impl Clock for ManualClock {
        fn monotonic(&self) -> Duration {
            Duration::from_nanos(self.nanos.fetch_add(self.auto_step, Ordering::SeqCst))
        }

        fn unix_ms(&self) -> i64 {
            let now = Duration::from_nanos(self.nanos.load(Ordering::SeqCst));
            1_800_000_000_000 + i64::try_from(now.as_millis()).unwrap_or(0)
        }
    }

    #[test]
    fn manual_clock_moves_only_when_told_or_when_racing() {
        let clock = ManualClock::default();
        assert_eq!(clock.monotonic(), Duration::ZERO);
        clock.advance(Duration::from_secs(3));
        assert_eq!(clock.monotonic(), Duration::from_secs(3));
        assert_eq!(clock.unix_ms(), 1_800_000_003_000);
        let racing = ManualClock::racing(Duration::from_secs(10));
        assert_eq!(racing.monotonic(), Duration::ZERO);
        assert_eq!(racing.monotonic(), Duration::from_secs(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_clock_is_monotonic_and_labels_with_wall_time() {
        let clock = SystemClock::default();
        let a = clock.monotonic();
        let b = clock.monotonic();
        assert!(b >= a);
        assert!(clock.unix_ms() > 1_700_000_000_000);
    }
}
