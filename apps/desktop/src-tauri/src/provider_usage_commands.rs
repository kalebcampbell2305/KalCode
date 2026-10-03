//! Credential-free provider quota usage per account (`kalcode_providers::usage`).
//!
//! Reads only files the provider CLIs wrote into each account's managed profile; it runs no
//! provider command, touches no credential or keychain, makes no network call and writes
//! nothing. Paths and file contents never cross this boundary, only the usage numbers.

use kalcode_contracts::provider_accounts::ProviderAccountUsage;
use kalcode_core::{ErrorCategory, IpcError, KalError};
use kalcode_providers::accounts::AccountStore;
use kalcode_providers::managed::ManagedProfiles;
use kalcode_providers::usage::read_account_usage;
use tauri::State;

use crate::AppState;

/// Usage for active accounts (all of them, or only `account_ids`). Async: off the main thread.
#[tauri::command(async)]
pub fn provider_account_usage(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    account_ids: Option<Vec<String>>,
) -> Result<Vec<ProviderAccountUsage>, IpcError> {
    _runtime_access.revalidate()?;
    let accounts = AccountStore::new(state.core()?.clone())
        .list(None)
        .map_err(|error| error.log_and_convert("provider_account_usage"))?;
    let profiles = ManagedProfiles::for_data_dir(&state.paths.data_dir).map_err(|error| {
        KalError::new(
            ErrorCategory::Provider,
            "provider_account_profile_unavailable",
            "KalCode couldn't safely open managed provider profiles.",
        )
        .with_source(error)
        .to_ipc()
    })?;
    let now = time::OffsetDateTime::now_utc();
    Ok(accounts
        .iter()
        .filter(|account| account.archived_at.is_none())
        .filter(|account| {
            account_ids
                .as_ref()
                .is_none_or(|ids| ids.iter().any(|id| id == &account.id))
        })
        .map(|account| read_account_usage(&profiles, account, now))
        .collect())
}
