//! Adaptive sampling cadence (RG-02).
//!
//! Pure functions of activity, pressure, failures and injected time. The governor thread only
//! asks "how long until the next sample, and which tiers are due".

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::model::{CadenceReason, PressureSummary, Tiers};

/// What KalCode is doing, reported by the host. Faster sampling is driven only by this and by
/// developing pressure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// Agent tasks currently running (provider sessions doing work).
    pub active_tasks: u32,
    /// A resource view is visible (Settings → Resources, a Command Center panel, the process
    /// monitor). Hidden views must report `false`: background samplers pause with their views.
    pub resource_view_open: bool,
}

/// Sampling intervals. Floors are enforced by [`CadenceConfig::sanitized`] so no configuration
/// can turn the governor into an aggressive poller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CadenceConfig {
    /// Nothing running, no pressure developing. Default 15 s; floor 10 s.
    pub idle: Duration,
    /// Pressure developing (a resource above Normal, or approaching Elevated). Default 5 s
    /// (0.2 Hz); floor 2 s.
    pub watch: Duration,
    /// Active work or an open resource view. Default 1 s (1 Hz); floor 1 s.
    pub active: Duration,
    /// Upper bound of the failure backoff. Default 60 s.
    pub max_backoff: Duration,
    /// Minimum spacing of the slow tier (commit, network, free space). Default 5 s.
    pub slow_tier_min: Duration,
    /// Minimum spacing of the process tier (process count and the KalCode tree). The process
    /// snapshot is by far the costliest call (tens of milliseconds of CPU on a busy machine), so
    /// it never runs faster than this. Default 10 s; floor 5 s.
    pub process_tier_min: Duration,
    /// Spacing of volume / interface re-enumeration. Default 5 min.
    pub inventory_every: Duration,
}

impl Default for CadenceConfig {
    fn default() -> Self {
        Self {
            idle: Duration::from_secs(15),
            watch: Duration::from_secs(5),
            active: Duration::from_secs(1),
            max_backoff: Duration::from_secs(60),
            slow_tier_min: Duration::from_secs(5),
            process_tier_min: Duration::from_secs(10),
            inventory_every: Duration::from_secs(300),
        }
    }
}

impl CadenceConfig {
    pub const IDLE_FLOOR: Duration = Duration::from_secs(10);
    pub const WATCH_FLOOR: Duration = Duration::from_secs(2);
    pub const ACTIVE_FLOOR: Duration = Duration::from_secs(1);
    pub const SLOW_TIER_FLOOR: Duration = Duration::from_secs(2);
    pub const PROCESS_TIER_FLOOR: Duration = Duration::from_secs(5);
    pub const INVENTORY_FLOOR: Duration = Duration::from_secs(60);

    /// The config with every interval raised to its floor and ordered
    /// `active ≤ watch ≤ idle ≤ max_backoff`.
    pub fn sanitized(self) -> Self {
        let active = self.active.max(Self::ACTIVE_FLOOR);
        let watch = self.watch.max(Self::WATCH_FLOOR).max(active);
        let idle = self.idle.max(Self::IDLE_FLOOR).max(watch);
        Self {
            idle,
            watch,
            active,
            max_backoff: self.max_backoff.max(idle),
            slow_tier_min: self.slow_tier_min.max(Self::SLOW_TIER_FLOOR),
            process_tier_min: self.process_tier_min.max(Self::PROCESS_TIER_FLOOR),
            inventory_every: self.inventory_every.max(Self::INVENTORY_FLOOR),
        }
    }

    /// The delay until the next sample and why.
    ///
    /// Priority: active work → resource view → developing pressure → idle. After failures the
    /// base delay doubles per consecutive failure, capped at `max_backoff`.
    pub fn next_delay(
        &self,
        activity: Activity,
        pressure: &PressureSummary,
        consecutive_failures: u32,
    ) -> (Duration, CadenceReason) {
        let (base, reason) = if activity.active_tasks > 0 {
            (self.active, CadenceReason::ActiveWork)
        } else if activity.resource_view_open {
            (self.active, CadenceReason::ResourceViewOpen)
        } else if pressure.developing() {
            (self.watch, CadenceReason::PressureDeveloping)
        } else {
            (self.idle, CadenceReason::Idle)
        };
        if consecutive_failures == 0 {
            return (base, reason);
        }
        let factor = 1u32 << consecutive_failures.min(6);
        let backoff = base.saturating_mul(factor).min(self.max_backoff).max(base);
        (backoff, CadenceReason::Backoff)
    }
}

/// Tracks when each tier last ran and decides which are due.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TierClock {
    last_slow: Option<Duration>,
    last_processes: Option<Duration>,
    last_inventory: Option<Duration>,
    force_slow: bool,
    force_processes: bool,
    force_inventory: bool,
}

impl TierClock {
    /// The tiers due at `now`. The fast tier always runs; the first call runs every tier.
    pub fn due(&self, config: &CadenceConfig, now: Duration) -> Tiers {
        let elapsed = |last: Option<Duration>, every: Duration| {
            last.is_none_or(|at| now.saturating_sub(at) >= every)
        };
        let inventory =
            self.force_inventory || elapsed(self.last_inventory, config.inventory_every);
        Tiers {
            fast: true,
            slow: inventory || self.force_slow || elapsed(self.last_slow, config.slow_tier_min),
            processes: inventory
                || self.force_processes
                || elapsed(self.last_processes, config.process_tier_min),
            inventory,
        }
    }

    /// Records that `tiers` ran at `now`.
    pub fn ran(&mut self, tiers: Tiers, now: Duration) {
        if tiers.slow {
            self.last_slow = Some(now);
            self.force_slow = false;
        }
        if tiers.processes {
            self.last_processes = Some(now);
            self.force_processes = false;
        }
        if tiers.inventory {
            self.last_inventory = Some(now);
            self.force_inventory = false;
        }
    }

    /// Makes the slow tier due at the next sample.
    pub fn force_slow(&mut self) {
        self.force_slow = true;
    }

    /// Makes the process tier due at the next sample (tracked processes changed).
    pub fn force_processes(&mut self) {
        self.force_processes = true;
    }

    /// Makes the inventory (and slow) tier due at the next sample (workspace roots changed).
    pub fn force_inventory(&mut self) {
        self.force_inventory = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mode::ModeKind;
    use crate::model::{PressureEntry, Signal};
    use crate::{PressureLevel, ResourceKind};

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    fn pressure(level: PressureLevel, approaching: bool) -> PressureSummary {
        PressureSummary {
            entries: vec![PressureEntry {
                resource: ResourceKind::Cpu,
                level,
                signal: Signal::CpuPercent,
                value: 50.0,
                threshold: None,
                approaching,
            }],
            unknown: vec![],
        }
    }

    #[test]
    fn idle_is_slow_and_active_work_is_1_hz() {
        let c = CadenceConfig::default();
        let calm = pressure(PressureLevel::Normal, false);
        assert_eq!(
            c.next_delay(Activity::default(), &calm, 0),
            (secs(15), CadenceReason::Idle)
        );
        let busy = Activity {
            active_tasks: 2,
            resource_view_open: false,
        };
        assert_eq!(
            c.next_delay(busy, &calm, 0),
            (secs(1), CadenceReason::ActiveWork)
        );
        let view = Activity {
            active_tasks: 0,
            resource_view_open: true,
        };
        assert_eq!(
            c.next_delay(view, &calm, 0),
            (secs(1), CadenceReason::ResourceViewOpen)
        );
    }

    #[test]
    fn developing_pressure_speeds_up_to_watch_rate() {
        let c = CadenceConfig::default();
        let idle = Activity::default();
        let approaching = pressure(PressureLevel::Normal, true);
        assert_eq!(
            c.next_delay(idle, &approaching, 0),
            (secs(5), CadenceReason::PressureDeveloping)
        );
        let elevated = pressure(PressureLevel::Elevated, false);
        assert_eq!(c.next_delay(idle, &elevated, 0).0, secs(5));
        // Unknown pressure (no entries) is not "developing".
        assert_eq!(
            c.next_delay(idle, &PressureSummary::default(), 0).0,
            secs(15)
        );
        // Active work wins over pressure.
        let busy = Activity {
            active_tasks: 1,
            resource_view_open: false,
        };
        assert_eq!(c.next_delay(busy, &elevated, 0).0, secs(1));
    }

    #[test]
    fn failures_back_off_exponentially_up_to_the_cap() {
        let c = CadenceConfig::default();
        let calm = pressure(PressureLevel::Normal, false);
        let busy = Activity {
            active_tasks: 1,
            resource_view_open: false,
        };
        let delays: Vec<_> = (0..8)
            .map(|f| c.next_delay(busy, &calm, f).0.as_secs())
            .collect();
        assert_eq!(delays, vec![1, 2, 4, 8, 16, 32, 60, 60]);
        assert_eq!(c.next_delay(busy, &calm, 1).1, CadenceReason::Backoff);
        assert_eq!(c.next_delay(Activity::default(), &calm, 3).0, secs(60));
        assert_eq!(
            c.next_delay(Activity::default(), &calm, u32::MAX).0,
            secs(60)
        );
    }

    #[test]
    fn sanitized_enforces_floors_and_order() {
        let aggressive = CadenceConfig {
            idle: Duration::from_millis(10),
            watch: Duration::from_millis(10),
            active: Duration::from_millis(10),
            max_backoff: Duration::ZERO,
            slow_tier_min: Duration::ZERO,
            process_tier_min: Duration::ZERO,
            inventory_every: Duration::ZERO,
        }
        .sanitized();
        assert_eq!(aggressive.active, secs(1));
        assert_eq!(aggressive.watch, secs(2));
        assert_eq!(aggressive.idle, secs(10));
        assert_eq!(aggressive.max_backoff, secs(10));
        assert_eq!(aggressive.slow_tier_min, secs(2));
        assert_eq!(aggressive.process_tier_min, secs(5));
        assert_eq!(aggressive.inventory_every, secs(60));
        assert_eq!(
            CadenceConfig::default().sanitized(),
            CadenceConfig::default()
        );
    }

    #[test]
    fn slow_tier_is_spaced_even_at_1_hz() {
        let c = CadenceConfig::default();
        let mut clock = TierClock::default();
        let mut slow_runs = vec![];
        let mut process_runs = vec![];
        for s in 0..=20 {
            let due = clock.due(&c, secs(s));
            assert!(due.fast);
            if due.slow {
                slow_runs.push(s);
            }
            if due.processes {
                process_runs.push(s);
            }
            clock.ran(due, secs(s));
        }
        assert_eq!(slow_runs, vec![0, 5, 10, 15, 20]);
        assert_eq!(process_runs, vec![0, 10, 20]);
    }

    #[test]
    fn inventory_runs_first_then_every_period_or_when_forced() {
        let c = CadenceConfig::default();
        let mut clock = TierClock::default();
        let first = clock.due(&c, secs(0));
        assert!(first.inventory && first.slow && first.processes);
        clock.ran(first, secs(0));
        assert!(!clock.due(&c, secs(1)).inventory);
        clock.force_inventory();
        let forced = clock.due(&c, secs(1));
        assert!(forced.inventory && forced.slow);
        clock.ran(forced, secs(1));
        assert!(!clock.due(&c, secs(2)).inventory);
        assert!(clock.due(&c, secs(301)).inventory);
        clock.force_slow();
        let due = clock.due(&c, secs(3));
        assert!(due.slow && !due.inventory && !due.processes);
        clock.force_processes();
        let due = clock.due(&c, secs(3));
        assert!(due.processes && !due.inventory);
    }

    #[test]
    fn mode_kind_is_irrelevant_to_cadence() {
        // Cadence depends on activity and pressure only, never on the mode: the mode is a
        // setting for thresholds, not a sampling-rate knob.
        let _ = ModeKind::Performance;
        let c = CadenceConfig::default();
        assert_eq!(
            c.next_delay(Activity::default(), &PressureSummary::default(), 0),
            (secs(15), CadenceReason::Idle)
        );
    }
}
