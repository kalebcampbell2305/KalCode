import type { LaunchRecipe, LaunchRecipesSnapshot } from "@kalcode/protocol";

export type LaunchRecipesCommandName =
  | "launch_recipes_snapshot"
  | "launch_recipe_save"
  | "launch_recipe_delete"
  | "launch_recipe_reorder";

export interface LaunchRecipesApi {
  snapshot(): Promise<LaunchRecipesSnapshot>;
  /** Creates or replaces one definition. Native normalizes it and stamps `updatedAt`. */
  save(recipe: LaunchRecipe): Promise<LaunchRecipe>;
  delete(id: string): Promise<void>;
  /** Persists the manual order: `ids` lists every Recipe, first to last. */
  reorder(ids: string[]): Promise<LaunchRecipesSnapshot>;
}

/** Definitions only. Launching is the runtime's job and never mutates a saved Recipe. */
export class LaunchRecipesClient implements LaunchRecipesApi {
  constructor(
    private readonly invoke: <T>(command: LaunchRecipesCommandName, args: Record<string, unknown>) => Promise<T>,
  ) {}

  snapshot(): Promise<LaunchRecipesSnapshot> {
    return this.invoke("launch_recipes_snapshot", {});
  }
  save(recipe: LaunchRecipe): Promise<LaunchRecipe> {
    return this.invoke("launch_recipe_save", { recipe });
  }
  delete(id: string): Promise<void> {
    return this.invoke("launch_recipe_delete", { id });
  }
  reorder(ids: string[]): Promise<LaunchRecipesSnapshot> {
    return this.invoke("launch_recipe_reorder", { ids });
  }
}
