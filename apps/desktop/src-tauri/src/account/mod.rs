//! Native account authority for the desktop application.
//!
//! Secrets remain in [`session_store`]. Public snapshots from [`model`] are the only account
//! values intended to cross IPC. [`guard`] is installed by the desktop integration layer before
//! dispatching a Tauri command.

pub mod api;
pub mod guard;
pub mod model;
pub mod runtime;
pub mod session_store;
pub mod social;

#[cfg(test)]
#[path = "tests/api.rs"]
mod api_tests;
#[cfg(feature = "e2e")]
pub mod e2e;
#[cfg(test)]
#[path = "tests/model.rs"]
mod model_tests;
#[cfg(test)]
#[path = "tests/runtime.rs"]
mod runtime_tests;
#[cfg(test)]
#[path = "tests/session_cache.rs"]
mod session_cache_tests;
#[cfg(test)]
#[path = "tests/social.rs"]
mod social_tests;
