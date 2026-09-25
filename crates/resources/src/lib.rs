//! KalCode Workspace Resource Governor (RG), phase P0: the sampler and the advisory API.
//!
//! - **Sampling** ([`Governor`]): one background thread measures CPU, memory (and commit on
//!   Windows), free space on workspace volumes, disk IO and network rates, the process count and
//!   KalCode's own process tree (provider CLIs, terminals) — on an adaptive cadence: 15 s when
//!   idle, 5 s while pressure develops, 1 s while agent work runs or a resource view is open.
//!   The costly process snapshot runs at most every 10 s. GPU metrics are reported as
//!   unavailable rather than guessed.
//! - **Pressure** ([`PressureLevel`]): smoothed signals with hysteresis under the selected
//!   [`ResourceMode`]; transitions are reported for the proposed `resource.pressure_changed`
//!   event. Samples themselves stream to subscribers and are never events.
//! - **Capacity** ([`capacity()`]): a pure function answering how many more agent tasks could
//!   start now and what would hold the next one, for the Scheduler (P4). Until then it is
//!   advisory and never blocks.
//! - **Never acts**: nothing here kills, suspends or re-prioritises a process. Under pressure the
//!   crate can only *propose* an action with an explanation ([`intervene::propose`]).
//!
//! Failure isolation: if a measurement fails, the reading is `Unknown`; if the probe panics it
//! is caught and the cadence backs off; if the thread cannot run, readers get `Unknown` and
//! capacity applies count limits only. Callers never wait for a sample.

pub mod cadence;
pub mod capacity;
pub mod clock;
pub mod engine;
pub mod governor;
pub mod history;
pub mod intervene;
pub mod mode;
pub mod model;
pub mod pressure;
pub mod probe;
pub mod tree;

pub use cadence::{Activity, CadenceConfig};
pub use capacity::{
    CapacityAdvice, CapacityNote, CapacityRequest, Constraint, DataQuality, HoldReason,
    RunningWork, capacity,
};
pub use clock::{Clock, SystemClock};
pub use engine::{Engine, GovernorConfig, Ingested, ModeChange, SmoothingConfig};
pub use governor::{Governor, GovernorHandle, GovernorStatus, GovernorUpdate, SamplerStats};
pub use history::HistoryPoint;
pub use mode::{CustomLimits, GpuLimits, ModeError, ModeKind, ModeLimits, ResourceMode};
pub use model::{
    MIB, PressureEntry, PressureLevel, PressureSummary, PressureTransition, ProcessRole, Reading,
    ResourceKind, ResourceSnapshot, Signal,
};
pub use probe::{SysinfoProbe, SystemProbe, WorkspaceRoot};
pub use tree::TrackedRoot;
