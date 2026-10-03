//! KalCode native runtime core.
//!
//! Owns local persistence (SQLite + migrations), the event protocol (store + bus), typed
//! settings, feature flags, diagnostics, structured logging, the error taxonomy, and
//! workspaces with their terminal sessions. The Tauri shell (`apps/desktop/src-tauri`) is a
//! thin layer that exposes [`runtime::Core`] over IPC.

pub mod confirm;
pub mod db;
pub mod error;
pub mod events;
pub mod flags;
pub mod handoffs;
pub mod logging;
pub mod operations;
pub mod plans;
pub mod protected_file;
pub mod redact;
pub mod runtime;
pub mod settings;
pub mod time;
pub mod workspaces;

pub use error::{ErrorCategory, IpcError, KalError, Result};
pub use runtime::{AppInfo, BootState, Core, CoreConfig, Diagnostics, Paths, SecureStoreCheck};
