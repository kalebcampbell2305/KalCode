//! Resource modes and the thresholds they resolve to.
//!
//! The mode is a **setting, not a permission** (RG-03): it only changes pressure thresholds and
//! the advisory capacity limits. Every number here is documented in `docs/RESOURCE_GOVERNOR.md`
//! (§ Thresholds); change both together.

use std::collections::BTreeMap;
use std::time::Duration;

use kalcode_contracts::agent::ProviderId;
use serde::{Deserialize, Serialize};

/// The mode without its custom limits (for events, snapshots and hold reasons).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModeKind {
    Conservative,
    Balanced,
    Performance,
    Custom,
}

/// The user's selected resource mode. `Balanced` is the default.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ResourceMode {
    Conservative,
    #[default]
    Balanced,
    Performance,
    Custom(CustomLimits),
}

impl ResourceMode {
    pub fn kind(&self) -> ModeKind {
        match self {
            ResourceMode::Conservative => ModeKind::Conservative,
            ResourceMode::Balanced => ModeKind::Balanced,
            ResourceMode::Performance => ModeKind::Performance,
            ResourceMode::Custom(_) => ModeKind::Custom,
        }
    }

    /// Validates custom limits (presets are always valid).
    pub fn validate(&self) -> Result<(), ModeError> {
        match self {
            ResourceMode::Custom(limits) => limits.validate(),
            _ => Ok(()),
        }
    }

    /// Resolves the mode into concrete thresholds and limits. Custom limits are validated first.
    pub fn limits(&self) -> Result<ModeLimits, ModeError> {
        self.validate()?;
        Ok(match self {
            ResourceMode::Conservative => ModeLimits::conservative(),
            ResourceMode::Balanced => ModeLimits::balanced(),
            ResourceMode::Performance => ModeLimits::performance(),
            ResourceMode::Custom(custom) => ModeLimits::custom(custom),
        })
    }
}

/// User-set limits for `Custom` mode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomLimits {
    /// Machine CPU use (percent) above which new agent work is held. 20–100.
    pub max_cpu_percent: u8,
    /// Most memory the KalCode process tree (agents included) should use, MiB. `None` = no cap.
    pub max_kalcode_memory_mb: Option<u64>,
    /// Physical memory to keep available for everything else, MiB. 256–262,144.
    pub min_available_memory_mb: u64,
    /// Free space to keep on workspace volumes, MiB. 256–1,048,576.
    pub min_disk_free_mb: u64,
    /// Most simultaneous agent tasks. 1–64.
    pub max_agents: u32,
    /// Most simultaneous tasks per provider (0 = do not start tasks for that provider). ≤ 64.
    pub per_provider: BTreeMap<ProviderId, u32>,
    pub gpu: GpuLimits,
}

impl Default for CustomLimits {
    /// Balanced's values, as a starting point for the settings UI.
    fn default() -> Self {
        Self {
            max_cpu_percent: 75,
            max_kalcode_memory_mb: None,
            min_available_memory_mb: 2048,
            min_disk_free_mb: 5120,
            max_agents: 4,
            per_provider: BTreeMap::new(),
            gpu: GpuLimits::default(),
        }
    }
}

impl CustomLimits {
    pub fn validate(&self) -> Result<(), ModeError> {
        range("maxCpuPercent", u64::from(self.max_cpu_percent), 20, 100)?;
        range("maxAgents", u64::from(self.max_agents), 1, 64)?;
        range(
            "minAvailableMemoryMb",
            self.min_available_memory_mb,
            256,
            262_144,
        )?;
        range("minDiskFreeMb", self.min_disk_free_mb, 256, 1_048_576)?;
        if let Some(cap) = self.max_kalcode_memory_mb {
            range("maxKalcodeMemoryMb", cap, 512, 4_194_304)?;
        }
        for limit in self.per_provider.values() {
            range("perProvider", u64::from(*limit), 0, 64)?;
        }
        if self
            .per_provider
            .keys()
            .any(|provider| provider.as_str().is_empty())
        {
            return Err(ModeError::Invalid {
                field: "perProvider",
                reason: "provider ids must not be empty".into(),
            });
        }
        if let Some(percent) = self.gpu.max_utilization_percent {
            range("gpu.maxUtilizationPercent", u64::from(percent), 1, 100)?;
        }
        if let Some(vram) = self.gpu.max_vram_mb {
            range("gpu.maxVramMb", vram, 256, 1_048_576)?;
        }
        Ok(())
    }
}

fn range(field: &'static str, value: u64, min: u64, max: u64) -> Result<(), ModeError> {
    if (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(ModeError::Invalid {
            field,
            reason: format!("{value} is outside {min}–{max}"),
        })
    }
}

/// GPU limits. Applied only where GPU metrics are measured; otherwise capacity says so in a note
/// instead of pretending to enforce them.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuLimits {
    pub max_utilization_percent: Option<u8>,
    pub max_vram_mb: Option<u64>,
}

impl GpuLimits {
    pub fn is_set(&self) -> bool {
        self.max_utilization_percent.is_some() || self.max_vram_mb.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ModeError {
    #[error("invalid custom resource limit {field}: {reason}")]
    Invalid { field: &'static str, reason: String },
}

/// Which way a signal gets worse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    HigherIsWorse,
    LowerIsWorse,
}

/// Enter thresholds for one signal, plus its hysteresis.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalThresholds {
    pub elevated: f64,
    pub high: f64,
    pub critical: f64,
    pub direction: Direction,
    /// A level is left only once the value is this far back past its enter threshold.
    pub exit_margin: f64,
    /// Within this distance of the next level up, the signal counts as "approaching".
    pub approach_margin: f64,
}

impl SignalThresholds {
    const fn higher(
        elevated: f64,
        high: f64,
        critical: f64,
        exit_margin: f64,
        approach: f64,
    ) -> Self {
        Self {
            elevated,
            high,
            critical,
            direction: Direction::HigherIsWorse,
            exit_margin,
            approach_margin: approach,
        }
    }

    const fn lower(
        elevated: f64,
        high: f64,
        critical: f64,
        exit_margin: f64,
        approach: f64,
    ) -> Self {
        Self {
            elevated,
            high,
            critical,
            direction: Direction::LowerIsWorse,
            exit_margin,
            approach_margin: approach,
        }
    }

    /// The enter threshold of `level` (`None` for `Normal`).
    pub fn threshold(&self, level: crate::PressureLevel) -> Option<f64> {
        use crate::PressureLevel::*;
        match level {
            Normal => None,
            Elevated => Some(self.elevated),
            High => Some(self.high),
            Critical => Some(self.critical),
        }
    }

    fn worse_or_equal(&self, value: f64, threshold: f64) -> bool {
        match self.direction {
            Direction::HigherIsWorse => value >= threshold,
            Direction::LowerIsWorse => value <= threshold,
        }
    }

    /// The level a value enters, ignoring hysteresis.
    pub fn level_for(&self, value: f64) -> crate::PressureLevel {
        use crate::PressureLevel::*;
        if self.worse_or_equal(value, self.critical) {
            Critical
        } else if self.worse_or_equal(value, self.high) {
            High
        } else if self.worse_or_equal(value, self.elevated) {
            Elevated
        } else {
            Normal
        }
    }

    /// The value moved `margin` in the "better" direction, used to test for leaving a level.
    pub fn relaxed(&self, value: f64) -> f64 {
        match self.direction {
            Direction::HigherIsWorse => value + self.exit_margin,
            Direction::LowerIsWorse => value - self.exit_margin,
        }
    }

    /// True when `value` is below `level`'s next level up but within the approach margin.
    pub fn approaching(&self, value: f64, level: crate::PressureLevel) -> bool {
        use crate::PressureLevel::*;
        let next = match level {
            Normal => self.elevated,
            Elevated => self.high,
            High => self.critical,
            Critical => return false,
        };
        match self.direction {
            Direction::HigherIsWorse => value < next && value >= next - self.approach_margin,
            Direction::LowerIsWorse => value > next && value <= next + self.approach_margin,
        }
    }
}

/// A cap on the memory of the KalCode process tree.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum MemoryCap {
    None,
    /// A share of physical memory (0–1).
    ShareOfPhysical(f64),
    Mb(u64),
}

impl MemoryCap {
    /// The cap in bytes for a machine with `total_bytes` of physical memory.
    pub fn bytes(&self, total_bytes: u64) -> Option<u64> {
        match *self {
            MemoryCap::None => None,
            MemoryCap::ShareOfPhysical(share) => Some((total_bytes as f64 * share) as u64),
            MemoryCap::Mb(mb) => Some(mb.saturating_mul(crate::MIB)),
        }
    }
}

/// What one more agent task is assumed to cost when nothing better is observed.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEstimate {
    /// Assumed resident memory of one agent session and its tools, MiB. Capacity uses the larger
    /// of this and the observed average of live provider sessions.
    pub memory_mb: u64,
    /// Assumed sustained CPU of one agent session, in logical cores.
    pub cpu_cores: f64,
}

pub const DEFAULT_AGENT_ESTIMATE: AgentEstimate = AgentEstimate {
    memory_mb: 512,
    cpu_cores: 0.5,
};

/// A mode resolved into concrete numbers. Pure data; `capacity()` and the pressure trackers read
/// only this.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeLimits {
    pub kind: ModeKind,
    pub cpu: SignalThresholds,
    pub memory_used_percent: SignalThresholds,
    pub memory_available_mb: SignalThresholds,
    pub commit_percent: SignalThresholds,
    pub disk_free_mb: SignalThresholds,
    /// New agent work is held while projected machine CPU would exceed this (percent).
    pub cpu_target_percent: f64,
    /// Physical memory capacity keeps free, MiB.
    pub memory_reserve_mb: u64,
    pub kalcode_memory_cap: MemoryCap,
    pub max_agents: u32,
    pub per_provider: BTreeMap<ProviderId, u32>,
    /// How many more tasks may start while the worst level is `Elevated` (`None` = no extra
    /// limit beyond headroom).
    pub elevated_allowance: Option<u32>,
    pub gpu: GpuLimits,
    pub agent_estimate: AgentEstimate,
    /// A level must be held this long before it may drop (it may rise at any time).
    pub min_dwell: Duration,
}

/// Commit thresholds are the same in every mode: running out of commit fails allocations.
const COMMIT: SignalThresholds = SignalThresholds::higher(85.0, 92.0, 97.0, 3.0, 5.0);
const MIN_DWELL: Duration = Duration::from_secs(20);

impl ModeLimits {
    pub fn conservative() -> Self {
        Self {
            kind: ModeKind::Conservative,
            cpu: SignalThresholds::higher(50.0, 70.0, 90.0, 7.0, 10.0),
            memory_used_percent: SignalThresholds::higher(70.0, 80.0, 90.0, 3.0, 5.0),
            memory_available_mb: SignalThresholds::lower(4096.0, 2048.0, 1024.0, 256.0, 1024.0),
            commit_percent: COMMIT,
            disk_free_mb: SignalThresholds::lower(20_480.0, 10_240.0, 4096.0, 512.0, 5120.0),
            cpu_target_percent: 60.0,
            memory_reserve_mb: 4096,
            kalcode_memory_cap: MemoryCap::ShareOfPhysical(0.25),
            max_agents: 2,
            per_provider: BTreeMap::new(),
            elevated_allowance: Some(0),
            gpu: GpuLimits::default(),
            agent_estimate: DEFAULT_AGENT_ESTIMATE,
            min_dwell: MIN_DWELL,
        }
    }

    pub fn balanced() -> Self {
        Self {
            kind: ModeKind::Balanced,
            cpu: SignalThresholds::higher(65.0, 85.0, 95.0, 7.0, 10.0),
            memory_used_percent: SignalThresholds::higher(80.0, 88.0, 94.0, 3.0, 5.0),
            memory_available_mb: SignalThresholds::lower(2048.0, 1024.0, 512.0, 256.0, 1024.0),
            commit_percent: COMMIT,
            disk_free_mb: SignalThresholds::lower(10_240.0, 5120.0, 2048.0, 512.0, 5120.0),
            cpu_target_percent: 75.0,
            memory_reserve_mb: 2048,
            kalcode_memory_cap: MemoryCap::ShareOfPhysical(0.5),
            max_agents: 4,
            per_provider: BTreeMap::new(),
            elevated_allowance: Some(1),
            gpu: GpuLimits::default(),
            agent_estimate: DEFAULT_AGENT_ESTIMATE,
            min_dwell: MIN_DWELL,
        }
    }

    pub fn performance() -> Self {
        Self {
            kind: ModeKind::Performance,
            cpu: SignalThresholds::higher(80.0, 92.0, 98.0, 7.0, 10.0),
            memory_used_percent: SignalThresholds::higher(85.0, 92.0, 96.0, 3.0, 5.0),
            memory_available_mb: SignalThresholds::lower(1536.0, 768.0, 384.0, 256.0, 1024.0),
            commit_percent: COMMIT,
            disk_free_mb: SignalThresholds::lower(5120.0, 2048.0, 1024.0, 512.0, 2560.0),
            cpu_target_percent: 90.0,
            memory_reserve_mb: 1024,
            kalcode_memory_cap: MemoryCap::ShareOfPhysical(0.75),
            max_agents: 8,
            per_provider: BTreeMap::new(),
            elevated_allowance: None,
            gpu: GpuLimits::default(),
            agent_estimate: DEFAULT_AGENT_ESTIMATE,
            min_dwell: MIN_DWELL,
        }
    }

    /// Custom mode: thresholds derive from the user's numbers (documented formulas).
    /// CPU: target `T` → Elevated `max(T−10, 10)`, High `min(T+10, 97)` (at least Elevated + 2),
    /// Critical `min(max(High+5, 90), 99)` (at least High + 1). Memory used-% bands are
    /// Balanced's. Available memory `R` → Elevated `2R`, High `R`, Critical `R/2`; reserve `R`.
    /// Disk free `D` → Elevated `2D`, High `D`, Critical `D/2`.
    pub fn custom(custom: &CustomLimits) -> Self {
        let target = f64::from(custom.max_cpu_percent);
        let elevated = (target - 10.0).max(10.0);
        let high = (target + 10.0).min(97.0).max(elevated + 2.0);
        let critical = (high + 5.0).clamp(90.0, 99.0).max(high + 1.0);
        let reserve = custom.min_available_memory_mb as f64;
        let disk = custom.min_disk_free_mb as f64;
        Self {
            kind: ModeKind::Custom,
            cpu: SignalThresholds::higher(elevated, high, critical, 7.0, 10.0),
            memory_used_percent: SignalThresholds::higher(80.0, 88.0, 94.0, 3.0, 5.0),
            memory_available_mb: SignalThresholds::lower(
                reserve * 2.0,
                reserve,
                reserve / 2.0,
                (reserve / 8.0).max(128.0),
                reserve,
            ),
            commit_percent: COMMIT,
            disk_free_mb: SignalThresholds::lower(
                disk * 2.0,
                disk,
                disk / 2.0,
                (disk / 10.0).max(256.0),
                disk,
            ),
            cpu_target_percent: target,
            memory_reserve_mb: custom.min_available_memory_mb,
            kalcode_memory_cap: custom
                .max_kalcode_memory_mb
                .map_or(MemoryCap::None, MemoryCap::Mb),
            max_agents: custom.max_agents,
            per_provider: custom.per_provider.clone(),
            elevated_allowance: Some(1),
            gpu: custom.gpu.clone(),
            agent_estimate: DEFAULT_AGENT_ESTIMATE,
            min_dwell: MIN_DWELL,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PressureLevel::*;

    #[test]
    fn presets_are_ordered_from_cautious_to_permissive() {
        let (c, b, p) = (
            ModeLimits::conservative(),
            ModeLimits::balanced(),
            ModeLimits::performance(),
        );
        assert!(c.cpu.elevated < b.cpu.elevated && b.cpu.elevated < p.cpu.elevated);
        assert!(c.cpu_target_percent < b.cpu_target_percent);
        assert!(b.cpu_target_percent < p.cpu_target_percent);
        assert!(c.memory_reserve_mb > b.memory_reserve_mb);
        assert!(b.memory_reserve_mb > p.memory_reserve_mb);
        assert!(c.max_agents < b.max_agents && b.max_agents < p.max_agents);
        assert!(c.disk_free_mb.elevated > b.disk_free_mb.elevated);
        for limits in [c, b, p] {
            for t in [
                limits.cpu,
                limits.memory_used_percent,
                limits.commit_percent,
            ] {
                assert!(t.elevated < t.high && t.high < t.critical);
            }
            for t in [limits.memory_available_mb, limits.disk_free_mb] {
                assert!(t.elevated > t.high && t.high > t.critical);
            }
        }
    }

    #[test]
    fn level_for_respects_direction() {
        let cpu = ModeLimits::balanced().cpu;
        assert_eq!(cpu.level_for(10.0), Normal);
        assert_eq!(cpu.level_for(65.0), Elevated);
        assert_eq!(cpu.level_for(85.0), High);
        assert_eq!(cpu.level_for(99.0), Critical);
        let disk = ModeLimits::balanced().disk_free_mb;
        assert_eq!(disk.level_for(100_000.0), Normal);
        assert_eq!(disk.level_for(9000.0), Elevated);
        assert_eq!(disk.level_for(5000.0), High);
        assert_eq!(disk.level_for(100.0), Critical);
    }

    #[test]
    fn approaching_is_within_margin_below_the_next_level() {
        let cpu = ModeLimits::balanced().cpu; // elevated 65, approach 10
        assert!(!cpu.approaching(54.0, Normal));
        assert!(cpu.approaching(55.0, Normal));
        assert!(!cpu.approaching(65.0, Normal));
        let disk = ModeLimits::balanced().disk_free_mb; // elevated 10 240, approach 5 120
        assert!(disk.approaching(12_000.0, Normal));
        assert!(!disk.approaching(20_000.0, Normal));
        assert!(!disk.approaching(1.0, Critical));
    }

    #[test]
    fn custom_thresholds_follow_the_documented_formulas() {
        let mut custom = CustomLimits {
            max_cpu_percent: 60,
            ..CustomLimits::default()
        };
        let limits = ModeLimits::custom(&custom);
        assert_eq!(
            (limits.cpu.elevated, limits.cpu.high, limits.cpu.critical),
            (50.0, 70.0, 90.0)
        );
        custom.max_cpu_percent = 100;
        let limits = ModeLimits::custom(&custom);
        assert_eq!(
            (limits.cpu.elevated, limits.cpu.high, limits.cpu.critical),
            (90.0, 97.0, 99.0)
        );
        custom.max_cpu_percent = 20;
        let limits = ModeLimits::custom(&custom);
        assert_eq!(
            (limits.cpu.elevated, limits.cpu.high, limits.cpu.critical),
            (10.0, 30.0, 90.0)
        );
        assert_eq!(limits.memory_available_mb.high, 2048.0);
        assert_eq!(limits.memory_available_mb.elevated, 4096.0);
        assert_eq!(limits.disk_free_mb.high, 5120.0);
        assert_eq!(limits.kalcode_memory_cap, MemoryCap::None);
    }

    #[test]
    fn custom_validation_rejects_out_of_range_values() {
        let ok = CustomLimits::default();
        assert!(ResourceMode::Custom(ok.clone()).limits().is_ok());
        let bad = [
            CustomLimits {
                max_cpu_percent: 5,
                ..ok.clone()
            },
            CustomLimits {
                max_agents: 0,
                ..ok.clone()
            },
            CustomLimits {
                max_agents: 65,
                ..ok.clone()
            },
            CustomLimits {
                min_available_memory_mb: 10,
                ..ok.clone()
            },
            CustomLimits {
                min_disk_free_mb: 1,
                ..ok.clone()
            },
            CustomLimits {
                max_kalcode_memory_mb: Some(100),
                ..ok.clone()
            },
            CustomLimits {
                per_provider: BTreeMap::from([(ProviderId::new("codex"), 65)]),
                ..ok.clone()
            },
            CustomLimits {
                per_provider: BTreeMap::from([(ProviderId::new(""), 1)]),
                ..ok.clone()
            },
            CustomLimits {
                gpu: GpuLimits {
                    max_utilization_percent: Some(0),
                    max_vram_mb: None,
                },
                ..ok.clone()
            },
        ];
        for limits in bad {
            assert!(
                ResourceMode::Custom(limits.clone()).limits().is_err(),
                "{limits:?}"
            );
        }
    }

    #[test]
    fn memory_cap_resolves_against_physical_memory() {
        let total = 16 * 1024 * crate::MIB;
        assert_eq!(
            MemoryCap::ShareOfPhysical(0.5).bytes(total),
            Some(8 * 1024 * crate::MIB)
        );
        assert_eq!(MemoryCap::Mb(1024).bytes(total), Some(1024 * crate::MIB));
        assert_eq!(MemoryCap::None.bytes(total), None);
    }
}
