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
//!   start now and what would hold the next one. It gates optional background work only.
//! - **Admission by priority** ([`admission`]): user-requested coding agents start immediately
//!   and are held only for genuine hard pressure ([`hard`]: critically low memory, a full disk,
//!   the OS refusing another process) with Start Anyway; CPU load throttles background work.
//! - **Interactive priority** ([`InteractivePriority`]): push-to-talk asks background *starts* to
//!   wait, bounded per span and per wait, so nothing is starved.
//! - **Never acts**: nothing here kills, suspends or re-prioritises a process. Under pressure the
//!   crate can only *propose* an action with an explanation ([`intervene::propose`]).
//!
//! Failure isolation: if a measurement fails, the reading is `Unknown`; if the probe panics it
//! is caught and the cadence backs off; if the thread cannot run, readers get `Unknown` and
//! capacity applies count limits only. Callers never wait for a sample.

pub mod admission;
pub mod cadence;
pub mod capacity;
pub mod clock;
pub mod engine;
pub mod governor;
pub mod hard;
pub mod history;
pub mod interactive;
pub mod intervene;
pub mod mode;
pub mod model;
pub mod pressure;
pub mod probe;
pub mod tree;

pub use admission::{
    ADMISSION_RETRY_MAX, ADMISSION_RETRY_MIN, ADMISSION_WAIT_LIMIT, AdmissionDecision,
    AdmissionReason, AdmissionRequirements, AdmissionState, MAX_ADMISSION_SAMPLE_AGE,
    MIN_ADMISSION_SAMPLE_AGE, admission_max_age, admission_retry_interval, decision_codes,
    evaluate_admission, evaluate_user_agent_admission, hold_reason_code, launch_hold,
};
pub use cadence::{Activity, CadenceConfig};
pub use capacity::{
    CapacityAdvice, CapacityNote, CapacityRequest, Constraint, DataQuality, HoldReason,
    RunningWork, capacity, count_constraints,
};
pub use clock::{Clock, SystemClock};
pub use engine::{Engine, GovernorConfig, Ingested, ModeChange, SmoothingConfig};
pub use governor::{Governor, GovernorHandle, GovernorStatus, GovernorUpdate, SamplerStats};
pub use hard::{
    HARD_DISK_FLOOR_MIB, HARD_MEMORY_FLOOR_MAX_MIB, HARD_MEMORY_FLOOR_MIN_MIB,
    HARD_MEMORY_FLOOR_PERCENT, HardPressure, hard_pressure, memory_floor_mib,
    process_creation_exhausted,
};
pub use history::HistoryPoint;
pub use interactive::{InteractivePriority, InteractiveSpan, MAX_INTERACTIVE_DEFERRAL};
pub use mode::{CustomLimits, GpuLimits, ModeError, ModeKind, ModeLimits, ResourceMode};
pub use model::{
    MIB, PressureEntry, PressureLevel, PressureSummary, PressureTransition, ProcessRole, Reading,
    ResourceKind, ResourceSnapshot, Signal,
};
pub use probe::{SysinfoProbe, SystemProbe, WorkspaceRoot};
pub use tree::TrackedRoot;
