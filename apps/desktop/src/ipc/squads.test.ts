import { describe, expect, it, vi } from "vitest";
import { SquadsClient } from "./squads.ts";

describe("canonical squad commands", () => {
  it("passes the same durable request identity and exact target from every entry point", async () => {
    const invoke = vi.fn().mockResolvedValue({ id: "launch" });
    const client = new SquadsClient(invoke);
    await client.launch("Engineering", "workspace", "request", "Ship the change");
    await client.launch("Engineering", "workspace", "request", "Ship the change");
    expect(invoke.mock.calls).toEqual([
      [
        "squads_launch",
        { squadId: "Engineering", workspaceId: "workspace", requestId: "request", goalOverride: "Ship the change" },
      ],
      [
        "squads_launch",
        { squadId: "Engineering", workspaceId: "workspace", requestId: "request", goalOverride: "Ship the change" },
      ],
    ]);
  });

  it("launches Recipes through the native recipe authority", async () => {
    const invoke = vi.fn().mockResolvedValue({ id: "launch" });
    await new SquadsClient(invoke).launchRecipe("Review", "workspace", "request");
    expect(invoke).toHaveBeenCalledWith("recipe_launch", {
      recipeId: "Review",
      workspaceId: "workspace",
      requestId: "request",
      goalOverride: null,
    });
  });

  it("reassigns only the relationship, preserving workers and their run identities", async () => {
    const invoke = vi.fn().mockResolvedValue({ id: "launch" });
    await new SquadsClient(invoke).reassignManager("launch", "worker", "new-lead");
    expect(invoke).toHaveBeenCalledWith("squads_reassign_manager", {
      launchId: "launch",
      memberKey: "worker",
      managerKey: "new-lead",
    });
  });

  it("distinguishes an unconfirmed delete from the exact Recipe set the person reviewed", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const client = new SquadsClient(invoke);
    const recipes = [
      {
        id: "00000000-0000-4000-8000-00000000c002",
        name: "Release readiness",
        squadId: "00000000-0000-4000-8000-00000000c001",
        goal: null,
      },
    ];

    await client.delete("squad");
    await client.delete("squad", []);
    await client.delete("squad", recipes);

    expect(invoke.mock.calls).toEqual([
      ["squads_delete", { id: "squad" }],
      ["squads_delete", { id: "squad", expectedRecipes: [] }],
      ["squads_delete", { id: "squad", expectedRecipes: recipes }],
    ]);
  });

  it("propagates native failures instead of claiming local success", async () => {
    const error = new Error("Reconnect the selected account");
    const invoke = vi.fn().mockRejectedValue(error);
    await expect(new SquadsClient(invoke).launch("squad", "workspace", "request")).rejects.toBe(error);
  });
});
