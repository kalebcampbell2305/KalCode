//! Credential-free provider-account metadata IPC.
//!
//! Authentication state and provider-reported identity are adapter-owned and intentionally have
//! no command in this module. Managed-profile paths and credentials never cross this boundary.

use kalcode_contracts::provider_accounts::{
    ProviderAccount, ProviderAccountBinding, ProviderAccountBindingKind,
};
use kalcode_contracts::threads::{ThreadStatus, ThreadSummary};
use kalcode_core::{ErrorCategory, IpcError, KalError};
use kalcode_providers::accounts::AccountStore;
use kalcode_providers::managed::ManagedProfiles;
use tauri::State;

use crate::AppState;
use crate::thread_commands::ThreadsState;

fn account_thread_is_open(
    account_id: &str,
    thread_account_id: Option<&str>,
    status: ThreadStatus,
) -> bool {
    thread_account_id == Some(account_id)
        && !matches!(
            status,
            ThreadStatus::Completed
                | ThreadStatus::Failed
                | ThreadStatus::Interrupted
                | ThreadStatus::Offline
        )
}

fn account_is_used_by_open_thread(account_id: &str, threads: &[ThreadSummary]) -> bool {
    threads.iter().any(|thread| {
        account_thread_is_open(
            account_id,
            thread.provider_account_id.as_deref(),
            thread.status,
        )
    })
}

fn managed_profiles(state: &AppState) -> Result<ManagedProfiles, IpcError> {
    ManagedProfiles::for_data_dir(&state.paths.data_dir).map_err(|error| {
        KalError::new(
            ErrorCategory::Provider,
            "provider_account_profile_unavailable",
            "KalCode couldn't safely open managed provider profiles.",
        )
        .with_source(error)
        .to_ipc()
    })
}

/// Lists active provider-account metadata. An optional provider id narrows the result.
#[tauri::command(async)]
pub fn provider_accounts_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    provider_id: Option<String>,
) -> Result<Vec<ProviderAccount>, IpcError> {
    _runtime_access.revalidate()?;
    AccountStore::new(state.core()?.clone())
        .list(provider_id.as_deref())
        .map_err(|error| error.log_and_convert("provider_accounts_list"))
}

/// Creates credential-free metadata for a provider-managed account profile.
#[tauri::command(async)]
pub fn provider_account_create(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    account: State<'_, std::sync::Arc<crate::account::runtime::AccountRuntime>>,
    provider_id: String,
    display_name: String,
) -> Result<ProviderAccount, IpcError> {
    _runtime_access.revalidate()?;
    let limit = account
        .snapshot()
        .plan_limit(kalcode_core::plans::Limited::ProviderAccounts);
    AccountStore::new(state.core()?.clone())
        .create_limited(&provider_id, &display_name, limit)
        .map_err(|error| error.log_and_convert("provider_account_create"))
}

/// Changes only the owner-visible account label.
#[tauri::command(async)]
pub fn provider_account_rename(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    account_id: String,
    display_name: String,
) -> Result<ProviderAccount, IpcError> {
    _runtime_access.revalidate()?;
    AccountStore::new(state.core()?.clone())
        .rename(&account_id, &display_name)
        .map_err(|error| error.log_and_convert("provider_account_rename"))
}

/// Selects the provider's default active account.
#[tauri::command(async)]
pub fn provider_account_set_default(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    account_id: String,
) -> Result<ProviderAccount, IpcError> {
    _runtime_access.revalidate()?;
    AccountStore::new(state.core()?.clone())
        .set_default(&account_id)
        .map_err(|error| error.log_and_convert("provider_account_set_default"))
}

/// Archives local metadata only. Provider profiles, credentials, and running sessions are never
/// removed or stopped. A thread that may retain a session blocks the archive operation.
#[tauri::command(async)]
pub fn provider_account_archive(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    threads: crate::runtime_coordinator::RuntimeState<ThreadsState>,
    account_id: String,
) -> Result<ProviderAccount, IpcError> {
    _runtime_access.revalidate()?;
    let store = AccountStore::new(state.core()?.clone());
    let account = store
        .get(&account_id)
        .map_err(|error| error.log_and_convert("provider_account_archive"))?;
    if account.archived_at.is_some() {
        return Ok(account);
    }

    let open_threads = threads
        .runtime()?
        .list(None, false)
        .map_err(|error| error.log_and_convert("provider_account_archive"))?;
    if account_is_used_by_open_thread(&account_id, &open_threads) {
        return Err(KalError::validation(
            "provider_account_in_use",
            "Stop every thread using this provider account before removing it from KalCode.",
        )
        .to_ipc());
    }

    let profiles = managed_profiles(&state)?;
    store
        .archive(&profiles, &account_id)
        .map_err(|error| error.log_and_convert("provider_account_archive"))
}

/// Binds an account to one validated selection scope.
#[tauri::command(async)]
pub fn provider_account_bind(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    provider_id: String,
    kind: ProviderAccountBindingKind,
    scope_id: String,
    account_id: String,
) -> Result<ProviderAccountBinding, IpcError> {
    _runtime_access.revalidate()?;
    AccountStore::new(state.core()?.clone())
        .bind(&provider_id, kind, &scope_id, &account_id)
        .map_err(|error| error.log_and_convert("provider_account_bind"))
}

/// Lists scoped account bindings (for example each workspace's default account), optionally
/// narrowed by provider, kind and scope. Bindings of archived accounts are never listed.
#[tauri::command(async)]
pub fn provider_account_bindings_list(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    provider_id: Option<String>,
    kind: Option<ProviderAccountBindingKind>,
    scope_id: Option<String>,
) -> Result<Vec<ProviderAccountBinding>, IpcError> {
    _runtime_access.revalidate()?;
    AccountStore::new(state.core()?.clone())
        .list_bindings(provider_id.as_deref(), kind, scope_id.as_deref())
        .map_err(|error| error.log_and_convert("provider_account_bindings_list"))
}

/// Removes one validated selection-scope binding.
#[tauri::command(async)]
pub fn provider_account_unbind(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    provider_id: String,
    kind: ProviderAccountBindingKind,
    scope_id: String,
) -> Result<bool, IpcError> {
    _runtime_access.revalidate()?;
    AccountStore::new(state.core()?.clone())
        .unbind(&provider_id, kind, &scope_id)
        .map_err(|error| error.log_and_convert("provider_account_unbind"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_guard_blocks_every_status_that_can_retain_a_session() {
        for status in ThreadStatus::ALL {
            let expected = !matches!(
                status,
                ThreadStatus::Completed
                    | ThreadStatus::Failed
                    | ThreadStatus::Interrupted
                    | ThreadStatus::Offline
            );
            assert_eq!(
                account_thread_is_open("account", Some("account"), status),
                expected,
                "unexpected archive classification for {status:?}"
            );
        }
    }

    #[test]
    fn archive_guard_ignores_threads_without_the_target_account() {
        assert!(!account_thread_is_open(
            "account",
            None,
            ThreadStatus::Active
        ));
        assert!(!account_thread_is_open(
            "account",
            Some("other"),
            ThreadStatus::Active
        ));
    }
}
