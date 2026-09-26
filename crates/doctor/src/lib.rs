//! KalCode's Environment Doctor (DOC, `docs/ENVIRONMENT_DOCTOR.md`).
//!
//! * [`checks`] — the check catalog in five groups (DOC-01): KalCode (database `quick_check` on
//!   the core's read connection, migrations, data-folder writability, disk, logs, WebView2),
//!   providers (Z2 detection snapshots through [`ProviderSource`] — never re-probed), developer
//!   tools (`--version` argv probes through the Z2 launch rules), system (OS, long paths, PATH
//!   sanity, shells, memory, disk) and the current project (repository state, `.env` files Git
//!   would commit, files over 50 MiB, lockfiles).
//! * [`runner`] — runs checks in parallel, each with a 15 s budget; a check that fails, panics
//!   or overruns reports "Couldn't check" and never fails the run; runs are cancelable (DOC-05).
//! * [`fixes`] — the **fixed** fix catalog (§9 "Doctor fixes"): no free-form commands. `file.*`
//!   fixes change a file only after the permission engine (origin `doctor`, [`gate::FixGate`],
//!   the seam the Trust Kernel wraps) allowed them, record their inverse, and write the durable
//!   fix journal; `show.*` fixes (installs, PATH, long paths) only show a command (DOC-03/04).
//! * [`store`] — remembered ignores (per finding and scope, reversible) and the fix log.
//! * [`service::Doctor`] — what the desktop shell holds.
//!
//! Schema: the registered canonical v16 migration is re-exported as [`DOCTOR_MIGRATION`].
//!
//! Nothing here contacts a network service: every check reads local state.

pub mod checks;
pub mod context;
pub mod fixes;
pub mod gate;
pub mod platform;
pub mod runner;
pub mod service;
pub mod store;
pub mod types;

pub use context::{HealthSource, HostFacts, ProjectFacts, ProviderFacts, ProviderSource};
pub use gate::{FixGate, GateDecision};
pub use kalcode_core::db::DOCTOR_MIGRATION;
pub use service::{Doctor, DoctorConfig};
pub use types::*;

/// Per-check time budget (DOC-05).
pub const CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
