//! Smoothing and hysteresis.
//!
//! Every function here takes time as an argument (a monotonic `Duration` from the injected
//! clock), so behaviour is deterministic and unit-testable.

use std::time::Duration;

use crate::PressureLevel;
use crate::mode::SignalThresholds;

/// Time-based exponential smoothing: `alpha = 1 − e^(−Δt/τ)`, so the result does not depend on
/// the sampling rate (a 15 s idle interval and a 1 s active interval smooth alike).
#[derive(Debug, Clone, PartialEq)]
pub struct Ema {
    tau: Duration,
    state: Option<(f64, Duration)>,
}

impl Ema {
    pub fn new(tau: Duration) -> Self {
        Self { tau, state: None }
    }

    pub fn value(&self) -> Option<f64> {
        self.state.map(|(value, _)| value)
    }

    /// Adds a measurement taken at `now` and returns the smoothed value.
    pub fn update(&mut self, sample: f64, now: Duration) -> f64 {
        let next = match self.state {
            None => sample,
            Some((value, at)) => {
                let dt = now.saturating_sub(at).as_secs_f64();
                let tau = self.tau.as_secs_f64();
                let alpha = if tau <= 0.0 {
                    1.0
                } else {
                    1.0 - (-dt / tau).exp()
                };
                value + alpha * (sample - value)
            }
        };
        self.state = Some((next, now));
        next
    }

    pub fn reset(&mut self) {
        self.state = None;
    }
}

/// Hysteresis for one signal. Rising is immediate; falling needs the value to be `exit_margin`
/// past the current level's enter threshold **and** the level to have been held `min_dwell`.
#[derive(Debug, Clone, PartialEq)]
pub struct HysteresisTracker {
    level: PressureLevel,
    since: Duration,
    initialized: bool,
}

impl Default for HysteresisTracker {
    fn default() -> Self {
        Self {
            level: PressureLevel::Normal,
            since: Duration::ZERO,
            initialized: false,
        }
    }
}

impl HysteresisTracker {
    pub fn level(&self) -> PressureLevel {
        self.level
    }

    /// Feeds a (smoothed) value and returns the level after hysteresis.
    pub fn update(
        &mut self,
        value: f64,
        thresholds: &SignalThresholds,
        min_dwell: Duration,
        now: Duration,
    ) -> PressureLevel {
        let entered = thresholds.level_for(value);
        if !self.initialized {
            self.initialized = true;
            self.level = entered;
            self.since = now;
        } else if entered > self.level {
            self.level = entered;
            self.since = now;
        } else if entered < self.level {
            let relaxed = thresholds.level_for(thresholds.relaxed(value));
            let dwelled = now.saturating_sub(self.since) >= min_dwell;
            if relaxed < self.level && dwelled {
                self.level = relaxed;
                self.since = now;
            }
        }
        self.level
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PressureLevel::*;
    use crate::mode::ModeLimits;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn ema_first_value_is_taken_as_is_and_then_smoothed_by_time() {
        let mut ema = Ema::new(secs(10));
        assert_eq!(ema.update(50.0, secs(0)), 50.0);
        // One time constant later the value has moved 63.2 % of the way.
        let v = ema.update(100.0, secs(10));
        assert!((v - (50.0 + 50.0 * (1.0 - (-1.0f64).exp()))).abs() < 1e-9);
        // Zero elapsed time: no movement.
        assert!((ema.update(0.0, secs(10)) - v).abs() < 1e-9);
    }

    #[test]
    fn ema_is_rate_independent() {
        // Ten 1 s steps and one 10 s step towards a constant reach the same value.
        let mut fine = Ema::new(secs(10));
        let mut coarse = Ema::new(secs(10));
        fine.update(0.0, secs(0));
        coarse.update(0.0, secs(0));
        for s in 1..=10 {
            fine.update(100.0, secs(s));
        }
        coarse.update(100.0, secs(10));
        assert!((fine.value().unwrap() - coarse.value().unwrap()).abs() < 1e-9);
    }

    #[test]
    fn rises_immediately_and_falls_only_after_margin_and_dwell() {
        let cpu = ModeLimits::balanced().cpu; // 65 / 85 / 95, exit margin 7
        let dwell = secs(20);
        let mut t = HysteresisTracker::default();
        assert_eq!(t.update(10.0, &cpu, dwell, secs(0)), Normal);
        assert_eq!(t.update(86.0, &cpu, dwell, secs(1)), High);
        // Below High's threshold but inside the margin: stays High.
        assert_eq!(t.update(80.0, &cpu, dwell, secs(40)), High);
        // Past the margin but before the dwell time: stays High.
        let mut u = HysteresisTracker::default();
        u.update(90.0, &cpu, dwell, secs(0));
        assert_eq!(u.update(55.0, &cpu, dwell, secs(5)), High);
        // Past the margin and the dwell: drops straight to the relaxed level (55 + 7 < 65).
        assert_eq!(u.update(55.0, &cpu, dwell, secs(20)), Normal);
        // From the earlier tracker: 77 relaxed is 84 < 85 → Elevated.
        assert_eq!(t.update(77.0, &cpu, dwell, secs(41)), Elevated);
    }

    #[test]
    fn oscillation_around_a_threshold_does_not_flap() {
        let cpu = ModeLimits::balanced().cpu;
        let mut t = HysteresisTracker::default();
        let mut changes = 0;
        let mut last = t.update(64.0, &cpu, secs(20), secs(0));
        for s in 1..200 {
            let value = if s % 2 == 0 { 66.0 } else { 63.0 };
            let level = t.update(value, &cpu, secs(20), secs(s));
            if level != last {
                changes += 1;
                last = level;
            }
        }
        assert_eq!(changes, 1, "one rise to Elevated, no flapping back");
        assert_eq!(last, Elevated);
    }

    #[test]
    fn lower_is_worse_signals_use_the_margin_upwards() {
        let disk = ModeLimits::balanced().disk_free_mb; // 10 240 / 5 120 / 2 048, margin 512
        let mut t = HysteresisTracker::default();
        assert_eq!(t.update(4000.0, &disk, secs(0), secs(0)), High);
        assert_eq!(
            t.update(5300.0, &disk, secs(0), secs(1)),
            High,
            "inside the margin"
        );
        assert_eq!(t.update(5700.0, &disk, secs(0), secs(2)), Elevated);
        assert_eq!(
            t.update(10_600.0, &disk, secs(0), secs(3)),
            Elevated,
            "inside the margin"
        );
        assert_eq!(t.update(10_800.0, &disk, secs(0), secs(4)), Normal);
    }

    #[test]
    fn first_value_sets_the_level_without_dwell() {
        let cpu = ModeLimits::balanced().cpu;
        let mut t = HysteresisTracker::default();
        assert_eq!(t.update(99.0, &cpu, secs(20), secs(0)), Critical);
    }
}
