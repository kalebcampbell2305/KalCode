//! Cursor uses its one native sign-in. KalCode stores labels and safe metadata only; it never
//! copies credentials or redirects the user's home/configuration to simulate extra accounts.

use kalcode_contracts::agent::{AuthState, ModelInfo, ProviderError, ProviderId};
use kalcode_contracts::provider_accounts::ProviderAccount;
use kalcode_core::{ErrorCategory, IpcError, KalError};
use kalcode_providers::cursor;
use serde::Serialize;

use super::{ProviderAuthState, ProviderRuntimeAuthority};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorAccountState {
    account: ProviderAccount,
    models: Vec<ModelInfo>,
    models_error: Option<String>,
}

fn metadata_error(error: KalError) -> ProviderError {
    ProviderError::Refused {
        code: error.code.to_owned(),
        message: error.message,
    }
}

fn cursor_error(error: ProviderError) -> IpcError {
    let (code, message) = match error {
        ProviderError::NotInstalled => (
            "cursor_not_installed".to_owned(),
            "Cursor integration is not installed. Install Cursor Agent, then reconnect.".to_owned(),
        ),
        ProviderError::NotAuthenticated => (
            "cursor_session_expired".to_owned(),
            "Cursor is signed out or its session expired. Reconnect your Cursor account.".to_owned(),
        ),
        ProviderError::Refused { code, message } => (code, message),
        ProviderError::Protocol(message) => ("cursor_response_invalid".to_owned(), message),
        _ => (
            "cursor_account_check_failed".to_owned(),
            "Cursor's account check did not complete. Check the Cursor installation and connection, then retry.".to_owned(),
        ),
    };
    IpcError {
        category: ErrorCategory::Provider,
        code,
        message,
        retryable: true,
    }
}

fn cursor_auth_failed(error: &ProviderError) -> bool {
    matches!(error, ProviderError::NotAuthenticated)
        || matches!(error, ProviderError::Refused { code, .. }
            if code == "cursor_not_authenticated" || code == "cursor_session_expired")
}

impl ProviderRuntimeAuthority {
    fn cursor_signed_out(&self, account_id: &str) -> Result<ProviderAccount, ProviderError> {
        let account = self
            .inner
            .accounts
            .get_active_for_provider(account_id, &ProviderId::new(ProviderId::CURSOR))
            .map_err(metadata_error)?;
        self.inner
            .accounts
            .mark_authentication(
                account_id,
                AuthState::NotAuthenticated,
                account.provider_reported_identity.as_deref(),
                Some("cursor_session_expired"),
            )
            .map_err(metadata_error)
    }

    // These are explicit native CLI operations, not passive startup checks. Cursor may
    // refresh its own credentials while authenticating a status/model request. A shared
    // session lease excludes KalCode login/archive without preventing concurrent terminals.
    fn with_cursor_native<T>(
        &self,
        account_id: &str,
        operation: impl FnOnce() -> Result<T, ProviderError>,
    ) -> Result<T, ProviderError> {
        let provider = ProviderId::new(ProviderId::CURSOR);
        self.inner
            .accounts
            .get_active_for_provider(account_id, &provider)
            .map_err(metadata_error)?;
        let _lease = self
            .inner
            .profiles
            .acquire_session_lease(ProviderId::CURSOR, account_id)?;
        self.inner
            .accounts
            .get_active_for_provider(account_id, &provider)
            .map_err(metadata_error)?;
        operation()
    }

    pub fn cursor_models(&self, account_id: &str) -> Result<Vec<ModelInfo>, ProviderError> {
        self.with_cursor_native(account_id, || {
            let guardian = self.probe_guardian().map_err(|_| ProviderError::Refused {
                code: "cursor_runtime_unavailable".to_owned(),
                message: "Cursor's runtime is unavailable. Restart KalCode.".to_owned(),
            })?;
            let result = cursor::discover_models_guarded(&self.inner.source_env, Some(&guardian));
            if result.as_ref().is_err_and(cursor_auth_failed) {
                self.cursor_signed_out(account_id)?;
            }
            result
        })
    }

    fn cursor_account(
        &self,
        account_id: &str,
        login: bool,
    ) -> Result<CursorAccountState, ProviderError> {
        let guardian = self.probe_guardian().map_err(|_| ProviderError::Refused {
            code: "cursor_runtime_unavailable".to_owned(),
            message: "Cursor's runtime is unavailable. Restart KalCode.".to_owned(),
        })?;
        let observe = |login| {
            let result = if login {
                cursor::login_guarded(&self.inner.source_env, Some(&guardian))
            } else {
                cursor::auth_status_guarded(&self.inner.source_env, Some(&guardian))
            };
            match result {
                Ok(status) => self
                    .inner
                    .accounts
                    .mark_authentication(account_id, status.auth, status.identity.as_deref(), None)
                    .map_err(metadata_error),
                Err(error) if cursor_auth_failed(&error) => self.cursor_signed_out(account_id),
                Err(error) => {
                    // Keep the last safe identity on transient failures. This callback runs
                    // under this exact active account's lease, including the metadata write.
                    self.inner
                        .accounts
                        .mark_validation_error(account_id, "cursor_account_check_failed")
                        .map_err(metadata_error)?;
                    Err(error)
                }
            }
        };
        let mut account = if login {
            self.inner.accounts.authenticate_with_active_account(
                &self.inner.profiles,
                ProviderId::CURSOR,
                account_id,
                |_, _lease| observe(true),
            )?
        } else {
            self.with_cursor_native(account_id, || observe(false))?
        };
        let (models, models_error) = if account.authentication_state == AuthState::Authenticated {
            match self.cursor_models(account_id) {
                Ok(models) => (models, None),
                Err(error) => {
                    // Model discovery can prove a cached native credential expired.
                    // Return the canonical account update made under its session lease.
                    account = self
                        .inner
                        .accounts
                        .get_active_for_provider(account_id, &ProviderId::new(ProviderId::CURSOR))
                        .map_err(metadata_error)?;
                    (Vec::new(), Some(cursor_error(error).message))
                }
            }
        } else {
            (
                Vec::new(),
                Some("Connect Cursor to discover this account's available models.".to_owned()),
            )
        };
        Ok(CursorAccountState {
            account,
            models,
            models_error,
        })
    }
}

#[tauri::command(async)]
pub async fn provider_cursor_account_refresh(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    account_id: String,
) -> Result<CursorAccountState, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime_authority().ok_or_else(|| {
        cursor_error(ProviderError::Refused {
            code: "cursor_runtime_unavailable".into(),
            message: "Cursor account services are unavailable. Restart KalCode.".into(),
        })
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        _runtime_access.revalidate_core().map_err(metadata_error)?;
        runtime.cursor_account(&account_id, false)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "cursor_account_task_failed",
            "Cursor's account check stopped. Retry.",
        )
        .to_ipc()
    })?
    .map_err(cursor_error)
}

#[tauri::command(async)]
pub async fn provider_cursor_login(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: crate::runtime_coordinator::RuntimeState<ProviderAuthState>,
    account_id: String,
) -> Result<CursorAccountState, IpcError> {
    _runtime_access.revalidate()?;
    let runtime = state.runtime_authority().ok_or_else(|| {
        cursor_error(ProviderError::Refused {
            code: "cursor_runtime_unavailable".into(),
            message: "Cursor account services are unavailable. Restart KalCode.".into(),
        })
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        _runtime_access.revalidate_core().map_err(metadata_error)?;
        runtime.cursor_account(&account_id, true)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "cursor_login_task_failed",
            "Cursor sign-in stopped. Reconnect to try again.",
        )
        .to_ipc()
    })?
    .map_err(cursor_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_account_failures_keep_specific_safe_recovery_reasons() {
        for code in ["cursor_not_authenticated", "cursor_session_expired"] {
            assert!(cursor_auth_failed(&ProviderError::Refused {
                code: code.into(),
                message: "native auth refusal".into(),
            }));
        }
        assert!(!cursor_auth_failed(&ProviderError::Refused {
            code: "cursor_runtime_unavailable".into(),
            message: "network failure".into(),
        }));
        let missing = cursor_error(ProviderError::NotInstalled);
        assert_eq!(missing.code, "cursor_not_installed");
        assert!(missing.message.contains("Install Cursor Agent"));
        let expired = cursor_error(ProviderError::NotAuthenticated);
        assert_eq!(expired.code, "cursor_session_expired");
        assert!(expired.message.contains("Reconnect"));
        let model = cursor_error(ProviderError::Refused {
            code: "cursor_model_unavailable".into(),
            message: "Model unavailable for this Cursor account.".into(),
        });
        assert_eq!(model.code, "cursor_model_unavailable");
        assert_eq!(model.message, "Model unavailable for this Cursor account.");
        let internal = cursor_error(ProviderError::Io("private provider output".into()));
        assert!(!internal.message.contains("private provider output"));
    }
}
