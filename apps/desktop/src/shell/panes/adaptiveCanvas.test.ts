import type { PaneLayout } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { arrangeTask, suggestTask, tidyLayout, withCompanions } from "./adaptiveCanvas.ts";
import { allContents, applyPreset, contentKey, leaves, makeLeaf, validateLayout } from "./model.ts";

const layout = (): PaneLayout => ({
  schemaVersion: 1,
  root: {
    kind: "split",
    axis: "horizontal",
    ratios: [270, 730],
    children: [
      makeLeaf(
        [
          { kind: "terminal", terminalId: "shell" },
          { kind: "browser", browserId: "web", url: "http://localhost:3000" },
        ],
        "work",
        1,
      ),
      makeLeaf([{ kind: "agent", agentId: "coding" }], "agent"),
    ],
  },
  dock: [{ kind: "widget", widgetId: "activity" }],
  maximizedPaneId: null,
});

describe("Adaptive Canvas", () => {
  it("an explicitly requested companion is restored from the dock without duplication", () => {
    const original = layout();
    const next = withCompanions(original, [{ kind: "widget", widgetId: "activity" }]);
    expect(leaves(next.root).flatMap((pane) => pane.tabs)).toContainEqual({ kind: "widget", widgetId: "activity" });
    expect(next.dock).toEqual([]);
    expect(allContents(next).map(contentKey).sort()).toEqual(allContents(original).map(contentKey).sort());
  });
  it.each(["build", "debug", "review", "ship", "focus"] as const)(
    "%s preserves every content identity including the dock",
    (task) => {
      const original = layout();
      const next = arrangeTask(original, task, "work");
      expect(validateLayout(next)).toBeNull();
      expect(allContents(next).map(contentKey).sort()).toEqual(allContents(original).map(contentKey).sort());
      expect(original.root.kind === "split" && original.root.ratios).toEqual([270, 730]);
    },
  );
  it("Build separates Browser and Terminal tabs and gives coding work the primary pane", () => {
    const next = arrangeTask(layout(), "build", "work");
    expect(leaves(next.root).map((p) => p.tabs[0]?.kind)).toEqual(["agent", "browser", "terminal"]);
    expect(leaves(next.root).find((p) => p.paneId === "work")?.tabs[0]?.kind).toBe("browser");
  });
  it("Focus preserves the full arrangement and selected tab", () => {
    const original = layout();
    const next = arrangeTask(original, "focus", "work");
    expect(next.root).toBe(original.root);
    expect(next.maximizedPaneId).toBe("work");
  });
  it("Tidy keeps pane IDs, selected tabs, dock and all 1024 tabs at capacity", () => {
    const panes = Array.from({ length: 32 }, (_, i) =>
      makeLeaf(
        Array.from({ length: 32 }, (_, j) => ({ kind: "terminal" as const, terminalId: `${i}-${j}` })),
        `p${i}`,
        17,
      ),
    );
    const original: PaneLayout = {
      ...layout(),
      root: { kind: "split", axis: "horizontal", ratios: [...Array(31).fill(31), 39], children: panes },
    };
    const next = tidyLayout(original, 1000);
    expect(validateLayout(next)).toBeNull();
    expect(leaves(next.root)).toEqual(panes);
    expect(allContents(next).map(contentKey)).toEqual(allContents(original).map(contentKey));
    expect(allContents(applyPreset(original, "two")).map(contentKey)).toEqual(allContents(original).map(contentKey));
  });
  it("suggestions are contextual and never mutate the arrangement", () => {
    const original = layout();
    const before = JSON.stringify(original);
    expect(suggestTask(original, false)?.task).toBe("build");
    expect(suggestTask(original, true)?.task).toBe("debug");
    expect(JSON.stringify(original)).toBe(before);
  });
});
