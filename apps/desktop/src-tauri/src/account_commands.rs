use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::account::api::PaidTier;
use crate::account::model::{AccountSnapshot, AccountUsageSnapshot};
use crate::account::runtime::{AccountRuntime, AccountRuntimeError};
use crate::account::social::SocialProvider;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AccountOpenResult {
    pub opened: bool,
}

#[tauri::command]
pub async fn account_bootstrap(
    runtime: State<'_, Arc<AccountRuntime>>,
) -> Result<AccountSnapshot, AccountRuntimeError> {
    bootstrap_runtime(runtime.inner().clone()).await
}

/// Off-thread account bootstrap entry point for the primary-owned startup coordinator.
pub async fn bootstrap_runtime(
    runtime: Arc<AccountRuntime>,
) -> Result<AccountSnapshot, AccountRuntimeError> {
    blocking(runtime, AccountRuntime::bootstrap).await
}

#[tauri::command]
pub async fn account_status(
    runtime: State<'_, Arc<AccountRuntime>>,
) -> Result<AccountSnapshot, AccountRuntimeError> {
    Ok(runtime.snapshot())
}

#[tauri::command]
pub async fn account_email_start(
    _admission: crate::runtime_coordinator::AccountMutation,
    runtime: State<'_, Arc<AccountRuntime>>,
    email: String,
) -> Result<AccountSnapshot, AccountRuntimeError> {
    blocking_mutation(runtime.inner().clone(), _admission, move |runtime| {
        runtime.start_email(&email)
    })
    .await
}

#[tauri::command]
pub async fn account_email_poll(
    _admission: crate::runtime_coordinator::AccountMutation,
    runtime: State<'_, Arc<AccountRuntime>>,
) -> Result<AccountSnapshot, AccountRuntimeError> {
    blocking_mutation(
        runtime.inner().clone(),
        _admission,
        AccountRuntime::poll_email,
    )
    .await
}

#[tauri::command]
pub async fn account_social_start(
    _admission: crate::runtime_coordinator::AccountMutation,
    runtime: State<'_, Arc<AccountRuntime>>,
    provider: String,
) -> Result<AccountSnapshot, AccountRuntimeError> {
    let provider = social_provider(&provider)?;
    blocking_mutation(runtime.inner().clone(), _admission, move |runtime| {
        let launch = runtime.start_social(provider)?;
        if let Err(error) = runtime.commit_social_browser_launch(&launch, |url| {
            tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| browser_error())
        }) {
            let _ = runtime.cancel_auth();
            return Err(error);
        }
        Ok(launch.snapshot.clone())
    })
    .await
}

pub async fn complete_social_callback(
    runtime: Arc<AccountRuntime>,
    admission: crate::runtime_coordinator::AccountMutation,
    raw: String,
) -> Result<AccountSnapshot, AccountRuntimeError> {
    blocking_mutation(runtime, admission, move |runtime| {
        runtime.handle_social_callback_url(&raw)
    })
    .await
}

#[tauri::command]
pub async fn account_auth_cancel(
    runtime: State<'_, Arc<AccountRuntime>>,
) -> Result<AccountSnapshot, AccountRuntimeError> {
    blocking(runtime.inner().clone(), AccountRuntime::cancel_auth).await
}

#[tauri::command]
pub async fn account_activate_free(
    _admission: crate::runtime_coordinator::AccountMutation,
    runtime: State<'_, Arc<AccountRuntime>>,
) -> Result<AccountSnapshot, AccountRuntimeError> {
    blocking_mutation(
        runtime.inner().clone(),
        _admission,
        AccountRuntime::activate_free,
    )
    .await
}

#[tauri::command]
pub async fn account_checkout(
    _admission: crate::runtime_coordinator::AccountMutation,
    runtime: State<'_, Arc<AccountRuntime>>,
    tier: String,
) -> Result<AccountSnapshot, AccountRuntimeError> {
    let tier = paid_tier(&tier)?;
    blocking_mutation(runtime.inner().clone(), _admission, move |runtime| {
        let launch = runtime.start_checkout(tier)?;
        runtime.commit_browser_launch(&launch, |url| {
            tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| browser_error())
        })?;
        Ok(launch.snapshot.clone())
    })
    .await
}

#[tauri::command]
pub async fn account_portal(
    _admission: crate::runtime_coordinator::AccountMutation,
    runtime: State<'_, Arc<AccountRuntime>>,
) -> Result<AccountOpenResult, AccountRuntimeError> {
    blocking_mutation(runtime.inner().clone(), _admission, move |runtime| {
        let launch = runtime.portal()?;
        runtime.commit_browser_launch(&launch, |url| {
            tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| browser_error())
        })?;
        Ok(AccountOpenResult { opened: true })
    })
    .await
}

#[tauri::command]
pub async fn account_refresh(
    _admission: crate::runtime_coordinator::AccountMutation,
    runtime: State<'_, Arc<AccountRuntime>>,
) -> Result<AccountSnapshot, AccountRuntimeError> {
    blocking_mutation(runtime.inner().clone(), _admission, AccountRuntime::refresh).await
}

#[tauri::command]
pub async fn account_logout(
    runtime: State<'_, Arc<AccountRuntime>>,
    coordinator: State<'_, Arc<crate::runtime_coordinator::RuntimeCoordinator>>,
) -> Result<AccountSnapshot, AccountRuntimeError> {
    let runtime = runtime.inner().clone();
    let coordinator = coordinator.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Seal admission before waiting for account/network operations. Account logout revokes
        // authority before it drains its request lane. Cleanup truth is separately queryable.
        coordinator.request_drain(false);
        let result = runtime.logout();
        coordinator.request_drain(false);
        if !coordinator.wait_drained(std::time::Duration::from_secs(30)) {
            tracing::warn!(event = "account.runtime_cleanup_incomplete");
        }
        result
    })
    .await
    .map_err(|_| AccountRuntimeError {
        code: "account_runtime_unavailable",
        message: "Account cleanup was interrupted. Try again.",
        retryable: true,
    })?
}

#[tauri::command]
pub async fn account_usage(
    runtime: State<'_, Arc<AccountRuntime>>,
) -> Result<AccountUsageSnapshot, AccountRuntimeError> {
    blocking(runtime.inner().clone(), AccountRuntime::usage).await
}

fn paid_tier(value: &str) -> Result<PaidTier, AccountRuntimeError> {
    match value {
        "pro" => Ok(PaidTier::Pro),
        "max" => Ok(PaidTier::Max),
        "max2x" => Ok(PaidTier::Max2x),
        _ => Err(AccountRuntimeError {
            code: "invalid_plan",
            message: "Choose a paid KalCode plan.",
            retryable: false,
        }),
    }
}

fn social_provider(value: &str) -> Result<SocialProvider, AccountRuntimeError> {
    SocialProvider::parse(value).map_err(|_| AccountRuntimeError {
        code: "invalid_sign_in_provider",
        message: "Choose Google or Microsoft to sign in.",
        retryable: false,
    })
}

async fn blocking<T, F>(
    runtime: Arc<AccountRuntime>,
    operation: F,
) -> Result<T, AccountRuntimeError>
where
    T: Send + 'static,
    F: FnOnce(&AccountRuntime) -> Result<T, AccountRuntimeError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || operation(&runtime))
        .await
        .map_err(|_| AccountRuntimeError {
            code: "account_runtime_unavailable",
            message: "The account service stopped unexpectedly. Try again.",
            retryable: true,
        })?
}

fn browser_error() -> AccountRuntimeError {
    AccountRuntimeError {
        code: "browser_open_failed",
        message: "KalCode could not open the secure browser page.",
        retryable: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paid_tiers_are_explicit_and_free_or_owner_cannot_reach_checkout() {
        assert_eq!(paid_tier("pro"), Ok(PaidTier::Pro));
        assert_eq!(paid_tier("max"), Ok(PaidTier::Max));
        assert_eq!(paid_tier("max2x"), Ok(PaidTier::Max2x));
        for invalid in ["", "free", "owner", "MAX", "max2x "] {
            assert_eq!(
                paid_tier(invalid).expect_err("must reject").code,
                "invalid_plan"
            );
        }
    }
}

async fn blocking_mutation<T, F>(
    runtime: Arc<AccountRuntime>,
    admission: crate::runtime_coordinator::AccountMutation,
    operation: F,
) -> Result<T, AccountRuntimeError>
where
    T: Send + 'static,
    F: FnOnce(&AccountRuntime) -> Result<T, AccountRuntimeError> + Send + 'static,
{
    blocking(runtime, move |runtime| {
        admission.revalidate()?;
        operation(runtime)
    })
    .await
}
