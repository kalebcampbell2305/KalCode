//! KalCode error taxonomy.
//!
//! Every fallible native operation returns [`KalError`]. It carries a category, a stable
//! machine-readable code, a user-safe message and a retryable flag. The internal source chain
//! is logged but never serialized to the UI — only [`IpcError`] crosses the IPC boundary.

use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ErrorCategory {
    Database,
    Filesystem,
    Validation,
    Permission,
    Provider,
    Authentication,
    Terminal,
    Git,
    Network,
    Plugin,
    Mission,
    Verification,
    Billing,
    Update,
    SecureStore,
    Internal,
}

type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

#[derive(Debug)]
pub struct KalError {
    pub category: ErrorCategory,
    /// Stable, snake_case machine code, unique within its category (e.g. `schema_too_new`).
    pub code: &'static str,
    /// Safe to show to the user. Must not contain secrets, paths outside KalCode's data
    /// directory, or raw provider output.
    pub message: String,
    pub retryable: bool,
    source: Option<BoxError>,
}

impl KalError {
    pub fn new(category: ErrorCategory, code: &'static str, message: impl Into<String>) -> Self {
        Self { category, code, message: message.into(), retryable: false, source: None }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn with_source(mut self, source: impl Into<BoxError>) -> Self {
        self.source = Some(source.into());
        self
    }

    pub fn validation(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Validation, code, message)
    }

    pub fn internal(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(ErrorCategory::Internal, code, message)
    }

    /// Full internal description including the source chain, for logs only.
    pub fn diagnostic(&self) -> String {
        let mut out = format!("{:?}/{}: {}", self.category, self.code, self.message);
        let mut next: Option<&(dyn std::error::Error + 'static)> =
            self.source.as_deref().map(|e| e as &(dyn std::error::Error + 'static));
        while let Some(err) = next {
            out.push_str(" <- ");
            out.push_str(&err.to_string());
            next = err.source();
        }
        out
    }

    pub fn to_ipc(&self) -> IpcError {
        IpcError {
            category: self.category,
            code: self.code.to_owned(),
            message: self.message.clone(),
            retryable: self.retryable,
        }
    }
}

impl fmt::Display for KalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for KalError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.as_deref().map(|e| e as &(dyn std::error::Error + 'static))
    }
}

impl From<rusqlite::Error> for KalError {
    fn from(error: rusqlite::Error) -> Self {
        let busy = matches!(
            error,
            rusqlite::Error::SqliteFailure(ref e, _)
                if e.code == rusqlite::ErrorCode::DatabaseBusy || e.code == rusqlite::ErrorCode::DatabaseLocked
        );
        let err = KalError::new(
            ErrorCategory::Database,
            if busy { "database_busy" } else { "database_error" },
            if busy {
                "KalCode's local database is busy. Try again in a moment."
            } else {
                "KalCode couldn't read or write its local database."
            },
        )
        .with_source(error);
        if busy { err.retryable() } else { err }
    }
}

impl From<serde_json::Error> for KalError {
    fn from(error: serde_json::Error) -> Self {
        KalError::internal("serialization_failed", "KalCode couldn't process stored data.").with_source(error)
    }
}

/// The only error shape that crosses the IPC boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IpcError {
    pub category: ErrorCategory,
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl From<KalError> for IpcError {
    fn from(error: KalError) -> Self {
        error.to_ipc()
    }
}

pub type Result<T, E = KalError> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_error_omits_internal_source() {
        let err = KalError::new(ErrorCategory::Database, "database_error", "Couldn't read.")
            .with_source(std::io::Error::other("C:\\secret\\path failed"));
        let json = serde_json::to_string(&err.to_ipc()).expect("serialize");
        assert_eq!(
            json,
            r#"{"category":"database","code":"database_error","message":"Couldn't read.","retryable":false}"#
        );
        assert!(err.diagnostic().contains("C:\\secret\\path failed"));
    }

    #[test]
    fn busy_sqlite_errors_are_retryable() {
        let busy = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            None,
        );
        let err = KalError::from(busy);
        assert_eq!(err.code, "database_busy");
        assert!(err.retryable);
    }
}
