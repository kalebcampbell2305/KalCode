/**
 * Launch Recipes adapter for unit tests and the ui-test build. Production uses the native store.
 * It mirrors the native validation so the UI sees the same refusals in both builds.
 */
import type { LaunchRecipe, LaunchRecipesSnapshot, RecipeComponent, RecipeVariable } from "@kalcode/protocol";
import {
  MAX_RECIPE_COMPONENTS,
  MAX_RECIPE_VARIABLES,
  RECIPE_SCHEMA_VERSION,
  safeRecipeUrl,
  VARIABLE_KEY,
} from "../../runtime/recipes/model.ts";
import type { DashboardHandlers } from "./dashboard.ts";

interface RecipesMemoryOptions {
  requireCore: () => void;
}

export interface RecipesMemory {
  handlers: DashboardHandlers;
}

const SECRET =
  /sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|xox[abprs]-[A-Za-z0-9-]{6,}|-----BEGIN|\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i;

function fail(code: string, message: string): never {
  throw { category: "validation", code, message, retryable: false };
}

function snapshot(recipes: readonly LaunchRecipe[]): LaunchRecipesSnapshot {
  return { recipes: structuredClone([...recipes].sort((a, b) => a.position - b.position)), limit: null };
}

function validate(input: LaunchRecipe): LaunchRecipe {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 120) fail("recipe_name_invalid", "Name the Recipe in 1 to 120 characters.");
  if (input.schemaVersion !== RECIPE_SCHEMA_VERSION)
    fail("recipe_schema_unsupported", "This Recipe was made by a different KalCode version.");
  const components: RecipeComponent[] = input.components ?? [];
  const variables: RecipeVariable[] = input.variables ?? [];
  if (components.length > MAX_RECIPE_COMPONENTS)
    fail("recipe_too_large", `A Recipe holds at most ${MAX_RECIPE_COMPONENTS} parts.`);
  if (variables.length > MAX_RECIPE_VARIABLES)
    fail("recipe_too_large", `A Recipe holds at most ${MAX_RECIPE_VARIABLES} variables.`);
  const keys = new Set<string>();
  for (const component of components) {
    if (!component.key || keys.has(component.key)) fail("recipe_component_key", "Each part needs a unique key.");
    keys.add(component.key);
    // Addresses holding {{variables}} are checked again after substitution at launch.
    if (component.kind === "browser" && !component.url.includes("{{") && !safeRecipeUrl(component.url))
      fail("recipe_url_invalid", "Browser parts need an HTTP or HTTPS address without credentials or tokens.");
  }
  const varKeys = new Set<string>();
  for (const variable of variables) {
    if (!VARIABLE_KEY.test(variable.key) || varKeys.has(variable.key))
      fail("recipe_variable_invalid", "Variable keys must be unique lowercase names.");
    varKeys.add(variable.key);
  }
  if (SECRET.test(JSON.stringify({ name, components, variables })))
    fail("recipe_secret_detected", "Remove credentials or secret-shaped values before saving this Recipe.");
  return {
    ...structuredClone(input),
    name,
    components: structuredClone(components),
    variables: structuredClone(variables),
  };
}

export function createRecipesMemory({ requireCore }: RecipesMemoryOptions): RecipesMemory {
  let recipes: LaunchRecipe[] = [];

  const handlers: DashboardHandlers = {
    launch_recipes_snapshot: () => {
      requireCore();
      return snapshot(recipes);
    },
    launch_recipe_save: (args) => {
      requireCore();
      const next = validate(args.recipe as LaunchRecipe);
      const lower = next.name.toLocaleLowerCase();
      if (recipes.some((r) => r.id !== next.id && r.name.toLocaleLowerCase() === lower))
        fail("recipe_name_exists", "A Recipe already uses that name. Choose a distinct name.");
      const existing = recipes.find((r) => r.id === next.id);
      const saved: LaunchRecipe = {
        ...next,
        position: existing ? existing.position : recipes.length,
        updatedAt: new Date().toISOString(),
      };
      recipes = existing ? recipes.map((r) => (r.id === saved.id ? saved : r)) : [...recipes, saved];
      return structuredClone(saved);
    },
    launch_recipe_delete: (args) => {
      requireCore();
      recipes = recipes.filter((r) => r.id !== args.id);
      recipes = [...recipes].sort((a, b) => a.position - b.position).map((r, position) => ({ ...r, position }));
      return null;
    },
    launch_recipe_reorder: (args) => {
      requireCore();
      const ids = (args.ids as string[]) ?? [];
      const have = new Set(recipes.map((r) => r.id));
      if (ids.length !== have.size || new Set(ids).size !== ids.length || ids.some((id) => !have.has(id)))
        fail("recipe_order_invalid", "The order must list every Recipe exactly once.");
      recipes = ids.map((id, position) => ({ ...(recipes.find((r) => r.id === id) as LaunchRecipe), position }));
      return snapshot(recipes);
    },
  };
  return { handlers };
}
