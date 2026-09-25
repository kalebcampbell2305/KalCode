//! Snapshot and reading types.
//!
//! The wire types were adopted into `crates/contracts::resources` in CA-1 (`ResourceSnapshot` with
//! tagged readings, `ResourcePressure`, …); they are re-exported here under the crate's names.
//! `PressureEntry` is the contract's `ResourcePressure`.

use kalcode_contracts::events::EventPayload;
use serde::{Deserialize, Serialize};

pub use kalcode_contracts::resources::{
    CadenceReason, CommitReading, CommitUsed, CpuReading, GpuReading, IoRate, MemoryReading,
    NetRate, PressureLevel, PressureSummary, ProcessRole, ProcessTreeReading, Reading,
    ResourceKind, ResourcePressure as PressureEntry, ResourceSnapshot, SamplingInfo, SessionUsage,
    Signal, Tiers, TrackedProcess, VolumeReading,
};

/// One mebibyte, the unit used by every `*_mb` field and threshold.
pub const MIB: u64 = 1024 * 1024;

/// Converts bytes to whole mebibytes (rounded down).
pub const fn bytes_to_mib(bytes: u64) -> u64 {
    bytes / MIB
}

/// At most this many processes are listed in a tree reading.
pub const MAX_TREE_PROCESSES: usize = 512;

/// A pressure level change. The host maps it to the proposed `resource.pressure_changed` event
/// (transitions only; samples are never events).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PressureTransition {
    pub resource: ResourceKind,
    pub from: PressureLevel,
    pub to: PressureLevel,
    pub mode: crate::mode::ModeKind,
    pub signal: Signal,
    pub value: f64,
    pub threshold: Option<f64>,
    pub seq: u64,
    pub at_unix_ms: i64,
}

impl From<PressureTransition> for EventPayload {
    /// `resource.pressure_changed` (transitions only; samples are never events).
    fn from(t: PressureTransition) -> Self {
        EventPayload::ResourcePressureChanged {
            resource: t.resource,
            from: t.from,
            to: t.to,
            mode: t.mode,
            signal: Some(t.signal),
            value: Some(t.value),
            threshold: t.threshold,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mode::ModeKind;

    #[test]
    fn transitions_map_to_the_contract_event() {
        let payload = EventPayload::from(PressureTransition {
            resource: ResourceKind::Cpu,
            from: PressureLevel::Normal,
            to: PressureLevel::High,
            mode: ModeKind::Balanced,
            signal: Signal::CpuPercent,
            value: 91.0,
            threshold: Some(90.0),
            seq: 3,
            at_unix_ms: 1,
        });
        let json = serde_json::to_value(&payload).expect("json");
        assert_eq!(json["type"], "resource.pressure_changed");
        assert_eq!(json["payload"]["to"], "high");
        assert_eq!(json["payload"]["signal"]["signal"], "cpu_percent");
        assert_eq!(json["payload"]["threshold"], 90.0);
    }
}
