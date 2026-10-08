//! Launch Recipes: saved working desks. Persistence lives in `kalcode_core::recipes`; the
//! frontend recreates a desk from a Recipe through the same commands a person uses.
//! Saving is gated only by the plan's Launch Recipe allowance (shared with Squad Recipes).
use kalcode_contracts::recipes::{LaunchRecipe, LaunchRecipesSnapshot};
use kalcode_core::plans::{Limited, PlanLimit};
use kalcode_core::recipes::LaunchRecipesStore;
use kalcode_core::{IpcError, KalError, Result};

use crate::operations_commands::OperationsState;
use crate::runtime_coordinator::{RuntimeAccess, RuntimeState};

async fn blocking<T: Send + 'static>(
    state: RuntimeState<OperationsState>,
    work: impl FnOnce(&RuntimeState<OperationsState>, LaunchRecipesStore) -> Result<T> + Send + 'static,
) -> std::result::Result<T, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        state.revalidate_core()?;
        let store = LaunchRecipesStore::new(state.core().clone());
        work(&state, store)
    })
    .await
    .map_err(|_| {
        KalError::internal(
            "launch_recipes_unavailable",
            "Launch Recipes could not complete that action.",
        )
        .to_ipc()
    })?
    .map_err(|error| error.log_and_convert("launch_recipes"))
}

fn plan_limit(state: &RuntimeState<OperationsState>) -> Option<PlanLimit> {
    let tier = state.plan_tier();
    tier.limits().launch_recipes.map(|max| PlanLimit {
        tier,
        kind: Limited::LaunchRecipes,
        max,
    })
}

#[tauri::command]
pub async fn launch_recipes_snapshot(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
) -> std::result::Result<LaunchRecipesSnapshot, IpcError> {
    blocking(state, move |state, store| {
        store.snapshot(plan_limit(state).map(|limit| limit.max))
    })
    .await
}

#[tauri::command]
pub async fn launch_recipe_save(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    recipe: LaunchRecipe,
) -> std::result::Result<LaunchRecipe, IpcError> {
    blocking(state, move |state, store| {
        store.save(recipe, plan_limit(state))
    })
    .await
}

#[tauri::command]
pub async fn launch_recipe_delete(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    id: String,
) -> std::result::Result<(), IpcError> {
    blocking(state, move |_, store| store.delete(&id)).await
}

#[tauri::command]
pub async fn launch_recipe_reorder(
    _runtime_access: RuntimeAccess,
    state: RuntimeState<OperationsState>,
    ids: Vec<String>,
) -> std::result::Result<LaunchRecipesSnapshot, IpcError> {
    blocking(state, move |state, store| {
        let mut snapshot = store.reorder(ids)?;
        snapshot.limit = plan_limit(state).map(|limit| limit.max);
        Ok(snapshot)
    })
    .await
}
