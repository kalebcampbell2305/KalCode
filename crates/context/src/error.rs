//! Errors for the context library. Messages are user-safe: they never contain file contents,
//! secrets, or absolute paths outside the workspace.

use kalcode_core::{ErrorCategory, KalError};

#[derive(Debug, thiserror::Error)]
pub enum ContextError {
    #[error("KalCode can't share this path: {reason}")]
    PathRejected { reason: String },
    #[error("That file or folder no longer exists.")]
    NotFound,
    #[error("KalCode couldn't read the item.")]
    Io(#[source] std::io::Error),
    #[error("The pattern {pattern:?} isn't valid: {reason}")]
    InvalidPattern { pattern: String, reason: String },
    #[error("There is no item at position {position} in this package.")]
    PositionOutOfRange { position: u32 },
    #[error("This item can't be overridden: {reason}")]
    NotOverridable { reason: String },
    #[error("The content changed since the preview; review the updated preview before sending.")]
    PreviewStale { previewed: String, current: String },
    #[error("Nothing in this package can be sent.")]
    NothingToSend,
    #[error("The file changed while KalCode was reading it.")]
    ChangedDuringRead,
    #[error("KalCode couldn't read or write its local database.")]
    Database(#[from] rusqlite::Error),
    #[error("KalCode couldn't encode the package record.")]
    Encoding(#[from] serde_json::Error),
    #[error("That context delivery is not in the required one-shot state.")]
    DeliveryState,
}

impl ContextError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::PathRejected { .. } => "context_path_rejected",
            Self::NotFound => "context_item_not_found",
            Self::Io(_) => "context_io_failed",
            Self::InvalidPattern { .. } => "context_invalid_pattern",
            Self::PositionOutOfRange { .. } => "context_position_out_of_range",
            Self::NotOverridable { .. } => "context_not_overridable",
            Self::PreviewStale { .. } => "context_preview_stale",
            Self::NothingToSend => "context_nothing_to_send",
            Self::ChangedDuringRead => "context_changed_during_read",
            Self::Database(_) => "context_database_error",
            Self::Encoding(_) => "context_encoding_error",
            Self::DeliveryState => "context_delivery_state_invalid",
        }
    }
}

impl From<ContextError> for KalError {
    fn from(error: ContextError) -> Self {
        let category = match &error {
            ContextError::PathRejected { .. } | ContextError::NotOverridable { .. } => {
                ErrorCategory::Permission
            }
            ContextError::NotFound | ContextError::Io(_) | ContextError::ChangedDuringRead => {
                ErrorCategory::Filesystem
            }
            ContextError::InvalidPattern { .. }
            | ContextError::PositionOutOfRange { .. }
            | ContextError::PreviewStale { .. }
            | ContextError::NothingToSend => ErrorCategory::Validation,
            ContextError::Database(_) => ErrorCategory::Database,
            ContextError::Encoding(_) => ErrorCategory::Internal,
            ContextError::DeliveryState => ErrorCategory::Validation,
        };
        let code = error.code();
        let message = error.to_string();
        KalError::new(category, code, message).with_source(error)
    }
}

pub type Result<T, E = ContextError> = std::result::Result<T, E>;
