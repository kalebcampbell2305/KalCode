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

  it("propagates native failures instead of claiming local success", async () => {
    const error = new Error("Reconnect the selected account");
    const invoke = vi.fn().mockRejectedValue(error);
    await expect(new SquadsClient(invoke).launch("squad", "workspace", "request")).rejects.toBe(error);
  });
});
