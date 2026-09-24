//! KalCode native runtime core.
//!
//! Owns local persistence (SQLite + migrations), the event protocol (store + bus), typed
//! settings, feature flags, diagnostics, structured logging and the error taxonomy. The Tauri
//! shell (`apps/desktop/src-tauri`) is a thin layer that exposes [`runtime::Core`] over IPC.

pub mod db;
pub mod error;
pub mod events;
pub mod flags;
pub mod logging;
pub mod runtime;
pub mod settings;
pub mod time;

pub use error::{ErrorCategory, IpcError, KalError, Result};
pub use runtime::{AppInfo, BootState, Core, CoreConfig, Diagnostics, Paths, SecureStoreCheck};
