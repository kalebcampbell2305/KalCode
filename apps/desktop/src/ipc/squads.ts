import type { SquadDefinition, SquadLaunch, SquadRecipe, SquadsSnapshot } from "@kalcode/protocol";

export type SquadsCommandName =
  | "squads_snapshot"
  | "squads_save"
  | "squads_delete"
  | "recipe_save"
  | "recipe_delete"
  | "squads_launch"
  | "recipe_launch"
  | "squads_reassign_manager";

export interface SquadsApi {
  snapshot(): Promise<SquadsSnapshot>;
  save(definition: SquadDefinition): Promise<SquadDefinition>;
  delete(id: string, expectedRecipes?: SquadRecipe[]): Promise<void>;
  saveRecipe(recipe: SquadRecipe): Promise<SquadRecipe>;
  deleteRecipe(id: string): Promise<void>;
  launch(squadId: string, workspaceId: string, requestId: string, goalOverride?: string | null): Promise<SquadLaunch>;
  launchRecipe(
    recipeId: string,
    workspaceId: string,
    requestId: string,
    goalOverride?: string | null,
  ): Promise<SquadLaunch>;
  reassignManager(launchId: string, memberKey: string, managerKey: string | null): Promise<SquadLaunch>;
}

/** All entry points use the same native authority; no local execution or member state. */
export class SquadsClient implements SquadsApi {
  private used = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly invoke: <T>(command: SquadsCommandName, args: Record<string, unknown>) => Promise<T>) {}

  /**
   * Squads have been read or launched in this session. Agent File Ownership follows Squad members'
   * owned paths only from then on, so a session that never uses Squads never polls them.
   */
  get inUse(): boolean {
    return this.used;
  }

  /** Called once when Squads first come into use. */
  onUse(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private markUsed() {
    if (this.used) return;
    this.used = true;
    for (const listener of this.listeners) listener();
  }

  snapshot(): Promise<SquadsSnapshot> {
    this.markUsed();
    return this.invoke("squads_snapshot", {});
  }
  save(definition: SquadDefinition): Promise<SquadDefinition> {
    return this.invoke("squads_save", { definition });
  }
  delete(id: string, expectedRecipes?: SquadRecipe[]): Promise<void> {
    return this.invoke("squads_delete", expectedRecipes === undefined ? { id } : { id, expectedRecipes });
  }
  saveRecipe(recipe: SquadRecipe): Promise<SquadRecipe> {
    return this.invoke("recipe_save", { recipe });
  }
  deleteRecipe(id: string): Promise<void> {
    return this.invoke("recipe_delete", { id });
  }
  launch(
    squadId: string,
    workspaceId: string,
    requestId: string,
    goalOverride: string | null = null,
  ): Promise<SquadLaunch> {
    this.markUsed();
    return this.invoke("squads_launch", { squadId, workspaceId, requestId, goalOverride });
  }
  launchRecipe(
    recipeId: string,
    workspaceId: string,
    requestId: string,
    goalOverride: string | null = null,
  ): Promise<SquadLaunch> {
    this.markUsed();
    return this.invoke("recipe_launch", { recipeId, workspaceId, requestId, goalOverride });
  }
  reassignManager(launchId: string, memberKey: string, managerKey: string | null): Promise<SquadLaunch> {
    return this.invoke("squads_reassign_manager", { launchId, memberKey, managerKey });
  }
}
