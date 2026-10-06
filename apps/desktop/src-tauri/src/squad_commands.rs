//! Squads are templates and relationships over the existing Operations authority.
//! Buttons, Recipes and KalVoice enter through these same account-bound commands.
use kalcode_contracts::squads::{SquadDefinition, SquadLaunch, SquadRecipe, SquadsSnapshot};
use kalcode_core::plans::{Limited, PlanLimit, PlanTier};
use kalcode_core::squads::SquadsStore;
use kalcode_core::{IpcError, KalError, Result};
use tauri::AppHandle;

use crate::operations_commands::OperationsState;
use crate::runtime_coordinator::{RuntimeAccess, RuntimeState};

fn require_squads(tier: PlanTier) -> Result<()> {
    if matches!(tier, PlanTier::Max | PlanTier::Max2x | PlanTier::Owner) {
        Ok(())
    } else {
        Err(KalError::validation(
            "squads_requires_max",
            "Squads are available on KalCode MAX and higher plans.",
        ))
    }
}

fn launch_target(query: &str, resolve_name: impl FnOnce(&str) -> Result<String>) -> Result<String> {
    // The store validates the original request fingerprint before loading a template.
    // Preserve exact-ID retries even when that template has since been deleted.
    if kalcode_contracts::ids::is_valid_id(query) {
        Ok(query.to_owned())
    } else {
        resolve_name(query)
    }
}

async fn blocking<T: Send + 'static>(
    state: RuntimeState<OperationsState>,
    work: impl FnOnce(&RuntimeState<OperationsState>, SquadsStore) -> Result<T> + Send + 'static,
) -> std::result::Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        state.revalidate_core()?;
        let store = SquadsStore::new(state.core().clone());
        work(&state, store)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "squads_unavailable",
            "Squads could not complete that action.",
        )
        .to_ipc()
    })?
    .map_err(|error| error.log_and_convert("squads"))
}

#[tauri::command]
pub async fn squads_snapshot(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
) -> std::result::Result<SquadsSnapshot, IpcError> {
    blocking(state, move |_, store| store.snapshot()).await
}

#[tauri::command]
pub async fn squads_save(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    definition: SquadDefinition,
) -> std::result::Result<SquadDefinition, IpcError> {
    blocking(state, move |state, store| {
        require_squads(state.plan_tier())?;
        store.save_squad(definition)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn squads_delete(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
    expected_recipes: Option<Vec<SquadRecipe>>,
) -> std::result::Result<(), IpcError> {
    blocking(state, move |_, store| {
        store.delete_squad_with_recipes(&id, expected_recipes)
    })
    .await
}

#[tauri::command]
pub async fn recipe_save(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    recipe: SquadRecipe,
) -> std::result::Result<SquadRecipe, IpcError> {
    blocking(state, move |state, store| {
        let tier = state.plan_tier();
        require_squads(tier)?;
        let limit = tier.limits().launch_recipes.map(|max| PlanLimit {
            tier,
            kind: Limited::LaunchRecipes,
            max,
        });
        store.save_recipe_limited(recipe, limit)
    })
    .await
}

#[tauri::command]
pub async fn recipe_delete(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
) -> std::result::Result<(), IpcError> {
    blocking(state, move |_, store| store.delete_recipe(&id)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn squads_launch(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    app: AppHandle,
    request_id: String,
    squad_id: String,
    workspace_id: String,
    goal_override: Option<String>,
) -> std::result::Result<SquadLaunch, IpcError> {
    blocking(state, move |state, store| {
        require_squads(state.plan_tier())?;
        let squad_id = launch_target(&squad_id, |query| Ok(store.resolve_squad(query)?.id))?;
        let launch = store.launch(
            &request_id,
            &squad_id,
            &workspace_id,
            goal_override.as_deref(),
            state.queue_limit(),
        )?;
        state.revalidate_core()?;
        state.authorize_squad_members(
            &app,
            &launch
                .members
                .iter()
                .map(|member| member.operation_id.clone())
                .collect::<Vec<_>>(),
        )?;
        Ok(launch)
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn recipe_launch(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    app: AppHandle,
    request_id: String,
    recipe_id: String,
    workspace_id: String,
    goal_override: Option<String>,
) -> std::result::Result<SquadLaunch, IpcError> {
    blocking(state, move |state, store| {
        require_squads(state.plan_tier())?;
        let recipe_id = launch_target(&recipe_id, |query| Ok(store.resolve_recipe(query)?.id))?;
        let launch = store.launch_recipe(
            &request_id,
            &recipe_id,
            &workspace_id,
            goal_override.as_deref(),
            state.queue_limit(),
        )?;
        state.revalidate_core()?;
        state.authorize_squad_members(
            &app,
            &launch
                .members
                .iter()
                .map(|member| member.operation_id.clone())
                .collect::<Vec<_>>(),
        )?;
        Ok(launch)
    })
    .await
}

#[tauri::command]
pub async fn squads_reassign_manager(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    launch_id: String,
    member_key: String,
    manager_key: Option<String>,
) -> std::result::Result<SquadLaunch, IpcError> {
    blocking(state, move |_, store| {
        store.reassign_manager(&launch_id, &member_key, manager_key.as_deref())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_launch_target_survives_deleted_template_for_idempotent_replay() {
        let id = "00000000-0000-4000-8000-000000000001";
        let target = launch_target(id, |_| {
            Err(KalError::validation(
                "squad_not_found",
                "The template was deleted.",
            ))
        });
        assert_eq!(target.expect("the store owns exact replay validation"), id);
    }

    #[test]
    fn named_launch_target_keeps_canonical_ambiguity_errors() {
        let error = launch_target("Engineering", |_| {
            Err(KalError::validation(
                "squad_ambiguous",
                "Choose the exact Squad.",
            ))
        })
        .expect_err("names still resolve through the canonical store");
        assert_eq!(error.code, "squad_ambiguous");
    }

    #[test]
    fn preserves_existing_squad_plan_placement_without_capping_agents() {
        for tier in [PlanTier::Free, PlanTier::Pro] {
            assert!(require_squads(tier).is_err());
            assert_eq!(tier.limits().parallel_agents, None);
        }
        for tier in [PlanTier::Max, PlanTier::Max2x, PlanTier::Owner] {
            assert!(require_squads(tier).is_ok());
        }
    }
}
