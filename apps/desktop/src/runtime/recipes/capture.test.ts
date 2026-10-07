import type { PaneNode } from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import type { KalCodeClient } from "../../ipc/client.ts";
import { captureDesk } from "./capture.ts";
import { uniqueDeskName } from "./useRecipeCapture.ts";

vi.mock("./RecipeLaunchProvider.tsx", () => ({ useRecipeLibrary: () => ({}) }));

const leaf = (
  paneId: string,
  tabs: PaneNode extends infer N ? (N extends { tabs: infer T } ? T : never) : never,
): PaneNode => ({
  kind: "leaf",
  paneId,
  tabs,
  activeTab: 0,
  collapsed: false,
});

function fakeClient(root: PaneNode) {
  return {
    layoutGet: async () => ({
      workspaceId: "w",
      schemaVersion: 1,
      updatedAt: "",
      layout: { schemaVersion: 1, root, maximizedPaneId: null, dock: [] },
    }),
    getThread: async (id: string) => ({
      id,
      name: "Fix tests",
      // A plain Thread (not a coding terminal) is never captured as an agent.
      runtimeKind: id === "plain" ? null : "interactive_pty",
      providerId: "codex",
      providerAccountId: "acct-1",
      model: "gpt-x",
      effort: "high",
    }),
    listTerminals: async () => [{ id: "t1", title: "Dev shell" }],
  } as unknown as KalCodeClient;
}

describe("captureDesk", () => {
  it("captures agents, terminals, safe browsers and widgets in order", async () => {
    const root: PaneNode = {
      kind: "split",
      axis: "horizontal",
      ratios: [500, 500],
      children: [
        leaf("a", [
          { kind: "agent", agentId: "th1" },
          { kind: "thread", threadId: "plain" },
          { kind: "terminal", terminalId: "t1" },
        ]),
        leaf("b", [
          { kind: "browser", browserId: "b1", url: "https://example.com/docs" },
          { kind: "browser", browserId: "b2", url: "https://x.com/?token=abc" },
          { kind: "widget", widgetId: "notes" },
          { kind: "widget", widgetId: "Bad Widget" },
          { kind: "dashboard" },
        ]),
      ],
    };
    const recipe = await captureDesk(fakeClient(root), "w", "Desk");
    expect(recipe.workspaceId).toBe("w");
    expect(recipe.layout).toBe("two");
    expect(recipe.components.map((c) => c.kind)).toEqual(["agent", "terminal", "browser", "widget"]);
    expect(recipe.components[0]).toMatchObject({
      providerId: "codex",
      providerAccountId: "acct-1",
      model: "gpt-x",
      effort: "high",
      task: null,
      // An automatic task title would otherwise become a manual name on every relaunch.
      name: null,
    });
    expect(recipe.components[1]).toMatchObject({ name: "Dev shell", command: null });
    expect(JSON.stringify(recipe)).not.toMatch(/th1|plain|token|Fix tests|Bad Widget/);
  });
  it("yields an empty Recipe without a saved layout and no preset for odd leaf counts", async () => {
    const client = { layoutGet: async () => null } as unknown as KalCodeClient;
    const recipe = await captureDesk(client, "w", "Empty");
    expect(recipe.components).toEqual([]);
    expect(recipe.layout).toBeNull();
  });
  it("makes desk names unique", () => {
    expect(uniqueDeskName("Site", ["site desk", "Site desk 2"])).toBe("Site desk 3");
    expect(uniqueDeskName("Site", [])).toBe("Site desk");
  });
});
