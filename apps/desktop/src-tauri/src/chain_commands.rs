//! Agent Handoff Chains: buttons, menus, the command palette and KalVoice enter through these
//! account-bound commands. Every step is an ordinary Operation; consent is renewed through the
//! same Squad authorization path after any change to which steps may run.
use kalcode_contracts::chains::{
    Chain, ChainStartRequest, ChainStepResult, ChainStepRoute, ChainsSnapshot,
};
use kalcode_core::chains::{ChainsStore, RouteAccount};
use kalcode_core::plans::PlanTier;
use kalcode_core::{IpcError, KalError, Result};
use tauri::AppHandle;

use crate::operations_commands::OperationsState;
use crate::runtime_coordinator::{RuntimeAccess, RuntimeState};

fn require_chains(tier: PlanTier) -> Result<()> {
    if matches!(tier, PlanTier::Max | PlanTier::Max2x | PlanTier::Owner) {
        Ok(())
    } else {
        Err(KalError::validation(
            "chains_requires_max",
            "Agent Handoff Chains are available on KalCode MAX and higher plans.",
        ))
    }
}

/// Refuses a route whose account is missing, belongs to another provider or is signed out, or
/// whose provider cannot report when a step's turn ends. Names compatible alternatives; KalCode
/// never switches a step's provider or account by itself.
fn validate_route(
    state: &OperationsState,
    accounts: &[RouteAccount],
    step_name: &str,
    provider_id: &str,
    account_id: &str,
) -> Result<()> {
    if let Some(problem) = state.chain_capability_problem(provider_id) {
        return Err(KalError::validation(
            "chain_step_provider_unsupported",
            format!("{step_name}: {problem}"),
        ));
    }
    let chosen = accounts
        .iter()
        .find(|account| account.id == account_id && account.provider_id == provider_id);
    let problem = match chosen {
        Some(account) if account.authenticated => return Ok(()),
        Some(account) => format!("{} is signed out", account.label),
        None => "its provider account is no longer available".to_owned(),
    };
    let mut alternatives = accounts
        .iter()
        .filter(|account| account.authenticated && account.id != account_id)
        .filter(|account| {
            state
                .chain_capability_problem(&account.provider_id)
                .is_none()
        })
        .collect::<Vec<_>>();
    alternatives.sort_by_key(|account| account.provider_id != provider_id);
    let names = alternatives
        .iter()
        .take(3)
        .map(|account| account.label.as_str())
        .collect::<Vec<_>>();
    let suggestion = match names.as_slice() {
        [] => "Reconnect it in Providers.".to_owned(),
        [one] => format!("Reconnect it, or choose {one}."),
        [rest @ .., last] => format!("Reconnect it, or choose {} or {last}.", rest.join(", ")),
    };
    Err(KalError::validation(
        "chain_step_account_unavailable",
        format!("{step_name}: {problem}. {suggestion}"),
    ))
}

async fn blocking<T: Send + 'static>(
    state: RuntimeState<OperationsState>,
    work: impl FnOnce(&RuntimeState<OperationsState>, ChainsStore) -> Result<T> + Send + 'static,
) -> std::result::Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        state.revalidate_core()?;
        let store = ChainsStore::new(state.core().clone());
        work(&state, store)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "chains_unavailable",
            "Handoff chains could not complete that action.",
        )
        .to_ipc()
    })?
    .map_err(|error| error.log_and_convert("chains"))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn chains_snapshot(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    workspace_id: Option<String>,
) -> std::result::Result<ChainsSnapshot, IpcError> {
    blocking(state, move |_, store| {
        store.snapshot(workspace_id.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn chains_start(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    app: AppHandle,
    request: ChainStartRequest,
) -> std::result::Result<Chain, IpcError> {
    blocking(state, move |state, store| {
        require_chains(state.plan_tier())?;
        let accounts = store.route_accounts()?;
        for step in &request.steps {
            validate_route(
                state,
                &accounts,
                if step.name.trim().is_empty() {
                    step.intent.label()
                } else {
                    step.name.trim()
                },
                &step.provider_id,
                &step.provider_account_id,
            )?;
        }
        let chain = store.start(request, state.queue_limit())?;
        state.revalidate_core()?;
        let ids = chain
            .steps
            .iter()
            .map(|step| step.operation_id.clone())
            .collect::<Vec<_>>();
        state.authorize_squad_members(&app, &ids)?;
        store.get(&chain.id)
    })
    .await
}

#[tauri::command]
pub async fn chains_pause(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
) -> std::result::Result<Chain, IpcError> {
    blocking(state, move |_, store| {
        store.pause(&id)?;
        store.get(&id)
    })
    .await
}

#[tauri::command]
pub async fn chains_resume(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
) -> std::result::Result<Chain, IpcError> {
    blocking(state, move |state, store| {
        require_chains(state.plan_tier())?;
        let ids = store.resume(&id)?;
        state.renew_chain_consent(&ids)?;
        store.get(&id)
    })
    .await
}

#[tauri::command]
pub async fn chains_cancel(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
) -> std::result::Result<Chain, IpcError> {
    blocking(state, move |_, store| {
        store.cancel(&id)?;
        store.get(&id)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn chains_retry_step(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
    step_key: String,
    route: Option<ChainStepRoute>,
) -> std::result::Result<Chain, IpcError> {
    blocking(state, move |state, store| {
        require_chains(state.plan_tier())?;
        if let Some(route) = &route {
            let accounts = store.route_accounts()?;
            validate_route(
                state,
                &accounts,
                &step_key,
                &route.provider_id,
                &route.provider_account_id,
            )?;
        }
        let ids = store.retry_step(&id, &step_key, route)?;
        state.renew_chain_consent(&ids)?;
        store.get(&id)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn chains_skip_step(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
    step_key: String,
) -> std::result::Result<Chain, IpcError> {
    blocking(state, move |state, store| {
        let ids = store.skip_step(&id, &step_key, "Skipped by you.")?;
        state.renew_chain_consent(&ids)?;
        store.get(&id)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn chains_reroute_step(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
    step_key: String,
    route: ChainStepRoute,
) -> std::result::Result<Chain, IpcError> {
    blocking(state, move |state, store| {
        require_chains(state.plan_tier())?;
        let accounts = store.route_accounts()?;
        validate_route(
            state,
            &accounts,
            &step_key,
            &route.provider_id,
            &route.provider_account_id,
        )?;
        let operation = store.reroute_step(&id, &step_key, route)?;
        state.renew_chain_consent(&[operation])?;
        store.get(&id)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn chains_record_step(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
    step_key: String,
    result: ChainStepResult,
    summary: String,
) -> std::result::Result<Chain, IpcError> {
    blocking(state, move |_, store| {
        store.record_step(&id, &step_key, result, &summary)?;
        store.get(&id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chains_are_a_max_feature() {
        assert!(require_chains(PlanTier::Max).is_ok());
        assert!(require_chains(PlanTier::Owner).is_ok());
        assert_eq!(
            require_chains(PlanTier::Free).err().map(|error| error.code),
            Some("chains_requires_max")
        );
    }
}
