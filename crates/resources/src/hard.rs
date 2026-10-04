//! Hard resource pressure: the only machine conditions that may delay a user-requested coding
//! agent.
//!
//! Owner directive (2026-10-04): KalCode's Resource Governor must protect system responsiveness
//! without becoming an artificial agent limit. A coding agent the person asked for starts
//! immediately whenever the OS can reasonably run it. High CPU, a soft memory reserve, elevated
//! pressure levels and late telemetry throttle optional background work instead
//! ([`crate::evaluate_admission`]); they never delay a user-requested agent.
//!
//! "Hard" means starting one more process is likely to fail or to destabilise the machine:
//!
//! - **Memory critically low**: available physical memory (both the latest reading and its
//!   smoothed value) is under [`memory_floor_mib`] — 2 % of physical memory, never less than
//!   [`HARD_MEMORY_FLOOR_MIN_MIB`] and never more than [`HARD_MEMORY_FLOOR_MAX_MIB`].
//! - **Commit exhausted** (Windows): the exact commit charge leaves less than the same floor
//!   before the commit limit, where allocations and process creation start failing.
//! - **Disk effectively full**: KalCode's data volume or the launching workspace's volume has
//!   less than [`HARD_DISK_FLOOR_MIB`] free.
//! - **Process creation refused**: the OS itself refused to spawn the provider
//!   ([`process_creation_exhausted`]); detected at spawn time, not from a sample.
//!
//! Only a current, valid sample can show hard pressure. Missing, stale or invalid readings are
//! not evidence of pressure, so they never hold a user-requested agent.

use serde::{Deserialize, Serialize};

use crate::model::{CommitUsed, MIB, Reading, ResourceSnapshot};

/// The hard memory floor never drops below this, MiB (small machines).
pub const HARD_MEMORY_FLOOR_MIN_MIB: u64 = 512;
/// ...and never rises above this, MiB (large machines still have room at 1.5 GiB free).
pub const HARD_MEMORY_FLOOR_MAX_MIB: u64 = 1536;
/// The relative part of the hard memory floor: this percent of physical memory.
pub const HARD_MEMORY_FLOOR_PERCENT: u64 = 2;
/// A governed volume with less free space than this is effectively full, MiB.
pub const HARD_DISK_FLOOR_MIB: u64 = 1024;

/// One genuine hard-pressure condition, with the values behind it (logged, and shown to the
/// person as the real reason).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HardPressure {
    /// Available physical memory is under the hard floor.
    MemoryCritical { available_mb: u64, floor_mb: u64 },
    /// The Windows commit charge is within the hard floor of the commit limit.
    CommitExhausted { remaining_mb: u64, floor_mb: u64 },
    /// A volume KalCode or the workspace writes to is effectively full.
    DiskFull {
        mount: String,
        free_mb: u64,
        floor_mb: u64,
    },
}

impl HardPressure {
    /// A stable, log-friendly code.
    pub fn code(&self) -> &'static str {
        match self {
            Self::MemoryCritical { .. } => "memory_critical",
            Self::CommitExhausted { .. } => "commit_exhausted",
            Self::DiskFull { .. } => "disk_full",
        }
    }

    /// MiB free now and the floor it fell under.
    pub fn evidence_mb(&self) -> (u64, u64) {
        match self {
            Self::MemoryCritical {
                available_mb,
                floor_mb,
            } => (*available_mb, *floor_mb),
            Self::CommitExhausted {
                remaining_mb,
                floor_mb,
            } => (*remaining_mb, *floor_mb),
            Self::DiskFull {
                free_mb, floor_mb, ..
            } => (*free_mb, *floor_mb),
        }
    }
}

/// The hard memory floor for a machine with `total_bytes` of physical memory, MiB:
/// 2 % of physical memory, clamped to 512..=1536 MiB.
pub fn memory_floor_mib(total_bytes: u64) -> u64 {
    (total_bytes / MIB)
        .saturating_mul(HARD_MEMORY_FLOOR_PERCENT)
        .saturating_div(100)
        .clamp(HARD_MEMORY_FLOOR_MIN_MIB, HARD_MEMORY_FLOOR_MAX_MIB)
}

/// Every hard-pressure condition `snapshot` shows for a launch in `workspace_id` (`None`: only
/// KalCode's own data volume is checked). Unknown or invalid readings show nothing.
pub fn hard_pressure(snapshot: &ResourceSnapshot, workspace_id: Option<&str>) -> Vec<HardPressure> {
    let mut found = Vec::new();
    if let Reading::Value(memory) = &snapshot.memory
        && memory.total_bytes > 0
        && memory.available_bytes <= memory.total_bytes
    {
        let floor_mb = memory_floor_mib(memory.total_bytes);
        // Both the latest reading and its smoothed value must be under the floor: a momentary
        // dip is not a reason to keep the person waiting.
        let available_mb = memory.available_bytes.max(memory.smoothed_available_bytes) / MIB;
        if available_mb < floor_mb {
            found.push(HardPressure::MemoryCritical {
                available_mb,
                floor_mb,
            });
        }
        if let Reading::Value(commit) = &memory.commit
            && let CommitUsed::Exact(used) = commit.used
            && commit.limit_bytes > 0
            && used <= commit.limit_bytes
        {
            let remaining_mb = (commit.limit_bytes - used) / MIB;
            if remaining_mb < floor_mb {
                found.push(HardPressure::CommitExhausted {
                    remaining_mb,
                    floor_mb,
                });
            }
        }
    }
    if let Reading::Value(volumes) = &snapshot.volumes {
        for volume in volumes {
            let governs_launch = volume.workspace_ids.iter().any(|id| match id {
                None => true,
                Some(id) => workspace_id == Some(id.as_str()),
            });
            if !governs_launch || volume.total_bytes == 0 || volume.free_bytes > volume.total_bytes
            {
                continue;
            }
            let free_mb = volume.free_bytes / MIB;
            if free_mb < HARD_DISK_FLOOR_MIB {
                found.push(HardPressure::DiskFull {
                    mount: volume.mount.clone(),
                    free_mb,
                    floor_mb: HARD_DISK_FLOOR_MIB,
                });
            }
        }
    }
    found
}

/// The OS error codes that mean "the system can't create another process right now".
#[cfg(windows)]
const PROCESS_EXHAUSTION_OS_ERRORS: &[i32] = &[
    8,    // ERROR_NOT_ENOUGH_MEMORY
    14,   // ERROR_OUTOFMEMORY
    1450, // ERROR_NO_SYSTEM_RESOURCES
    1455, // ERROR_COMMITMENT_LIMIT (paging file too small)
];
#[cfg(not(windows))]
const PROCESS_EXHAUSTION_OS_ERRORS: &[i32] = &[
    11, // EAGAIN: fork() hit the process or memory limit
    12, // ENOMEM
];

/// True when a provider spawn failure's text carries an OS error that means process creation is
/// exhausted (`"... (os error 1450)"` from `std::io::Error`). Any other failure — a missing
/// binary, access denied — stays a provider start failure.
pub fn process_creation_exhausted(detail: &str) -> bool {
    detail.match_indices("os error ").any(|(at, marker)| {
        let digits: String = detail[at + marker.len()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        digits
            .parse::<i32>()
            .is_ok_and(|code| PROCESS_EXHAUSTION_OS_ERRORS.contains(&code))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mode::ModeKind;
    use crate::model::{CommitReading, MemoryReading, VolumeReading};

    const GIB: u64 = 1024 * MIB;

    fn snapshot(total: u64, available: u64, smoothed: u64) -> ResourceSnapshot {
        let mut snapshot = ResourceSnapshot::unknown("test", ModeKind::Balanced);
        snapshot.seq = 1;
        snapshot.memory = Reading::Value(MemoryReading {
            total_bytes: total,
            available_bytes: available,
            used_bytes: total - available,
            used_percent: 0.0,
            smoothed_used_percent: 0.0,
            smoothed_available_bytes: smoothed,
            commit: Reading::unavailable("not windows"),
        });
        snapshot
    }

    #[test]
    fn the_memory_floor_is_relative_with_sane_absolute_bounds() {
        assert_eq!(
            memory_floor_mib(8 * GIB),
            512,
            "small machines keep 512 MiB"
        );
        assert_eq!(memory_floor_mib(31 * GIB), 634);
        assert_eq!(memory_floor_mib(64 * GIB), 1310);
        assert_eq!(
            memory_floor_mib(256 * GIB),
            1536,
            "capped on large machines"
        );
    }

    #[test]
    fn only_memory_under_the_floor_in_both_readings_is_critical() {
        // 31 GiB machine, floor 634 MiB.
        assert!(hard_pressure(&snapshot(31 * GIB, 2 * GIB, 2 * GIB), None).is_empty());
        assert_eq!(
            hard_pressure(&snapshot(31 * GIB, 300 * MIB, 320 * MIB), None),
            [HardPressure::MemoryCritical {
                available_mb: 320,
                floor_mb: 634
            }]
        );
        // A momentary dip with a healthy smoothed value is not hard pressure.
        assert!(hard_pressure(&snapshot(31 * GIB, 300 * MIB, 4 * GIB), None).is_empty());
    }

    #[test]
    fn commit_near_its_limit_is_hard_pressure() {
        let mut s = snapshot(16 * GIB, 8 * GIB, 8 * GIB);
        if let Reading::Value(memory) = &mut s.memory {
            memory.commit = Reading::Value(CommitReading {
                limit_bytes: 20 * GIB,
                used: CommitUsed::Exact(20 * GIB - 100 * MIB),
            });
        }
        assert_eq!(
            hard_pressure(&s, None),
            [HardPressure::CommitExhausted {
                remaining_mb: 100,
                floor_mb: 512
            }]
        );
        // An upper bound only is not evidence.
        if let Reading::Value(memory) = &mut s.memory {
            memory.commit = Reading::Value(CommitReading {
                limit_bytes: 20 * GIB,
                used: CommitUsed::AtMost(20 * GIB),
            });
        }
        assert!(hard_pressure(&s, None).is_empty());
    }

    #[test]
    fn a_full_data_or_workspace_volume_is_hard_pressure_other_volumes_are_not() {
        let mut s = snapshot(16 * GIB, 8 * GIB, 8 * GIB);
        s.volumes = Reading::Value(vec![
            VolumeReading {
                mount: "D:\\".into(),
                workspace_ids: vec![Some("other".into())],
                total_bytes: 500 * GIB,
                free_bytes: 10 * MIB,
            },
            VolumeReading {
                mount: "C:\\".into(),
                workspace_ids: vec![None, Some("ws".into())],
                total_bytes: 500 * GIB,
                free_bytes: 50 * GIB,
            },
        ]);
        assert!(hard_pressure(&s, Some("ws")).is_empty(), "D: is not ours");
        let full = hard_pressure(&s, Some("other"));
        assert_eq!(
            full,
            [HardPressure::DiskFull {
                mount: "D:\\".into(),
                free_mb: 10,
                floor_mb: HARD_DISK_FLOOR_MIB
            }]
        );
    }

    #[test]
    fn unknown_readings_are_never_hard_pressure() {
        let s = ResourceSnapshot::unknown("no sample", ModeKind::Balanced);
        assert!(hard_pressure(&s, Some("ws")).is_empty());
    }

    #[test]
    fn only_exhaustion_os_errors_mean_process_creation_was_refused() {
        #[cfg(windows)]
        {
            assert!(process_creation_exhausted(
                "spawn failed: Insufficient system resources exist to complete the requested service. (os error 1450)"
            ));
            assert!(process_creation_exhausted(
                "The paging file is too small (os error 1455)"
            ));
            assert!(!process_creation_exhausted(
                "Access is denied. (os error 5)"
            ));
            assert!(!process_creation_exhausted("not found (os error 2)"));
        }
        #[cfg(not(windows))]
        {
            assert!(process_creation_exhausted(
                "fork: Resource temporarily unavailable (os error 11)"
            ));
            assert!(!process_creation_exhausted(
                "Permission denied (os error 13)"
            ));
        }
        assert!(!process_creation_exhausted("codex exited with status 1"));
        assert!(!process_creation_exhausted("os error "));
    }
}
