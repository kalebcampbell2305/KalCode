import type { PaneLayout } from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import { emptyLayout, leaves, makeLeaf, splitPane, validateLayout } from "../../shell/panes/model.ts";
import { listenForPaneCommands, type PaneCommand } from "../../shell/panes/paneCommands.ts";
import type { PaneController } from "../../shell/panes/usePaneController.ts";
import { browserContent } from "./browserModel.ts";
import { handleOpenLiveBrowser, leafWidth, openLiveBrowser, placeLiveBrowser } from "./liveBrowserOpen.ts";

const ws = "550e8400-e29b-41d4-a716-446655440001";

function twoColumns(): PaneLayout {
  const base = emptyLayout();
  const first = leaves(base.root)[0];
  if (!first) throw new Error("no pane");
  const withTerminal = {
    ...base,
    root: makeLeaf([{ kind: "terminal", terminalId: "term-1" }], first.paneId),
  };
  return splitPane(
    withTerminal,
    first.paneId,
    "horizontal",
    makeLeaf([{ kind: "agent", agentId: "agent-1" }], "agent-pane"),
  );
}

describe("placeLiveBrowser", () => {
  it("adds a far-right column when nothing is named", () => {
    const layout = twoColumns();
    const content = browserContent();
    const placed = placeLiveBrowser(layout, content, { canvasWidth: 1600 });
    expect(validateLayout(placed.layout)).toBeNull();
    const panes = leaves(placed.layout.root);
    expect(panes.at(-1)?.paneId).toBe(placed.paneId);
    expect(panes.at(-1)?.tabs).toEqual([content]);
    expect(placed.layout.root.kind === "split" && placed.layout.root.ratios.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(Math.round(leafWidth(placed.layout, placed.paneId, 1600))).toBe(672);
  });

  it("opens beside the named pane", () => {
    const layout = twoColumns();
    const first = leaves(layout.root)[0]?.paneId as string;
    const placed = placeLiveBrowser(layout, browserContent(), { anchorPaneId: first, canvasWidth: 2400 });
    expect(leaves(placed.layout.root).map((leaf) => leaf.paneId)).toEqual([first, placed.paneId, "agent-pane"]);
  });

  it("opens as a tab when a new column would be cramped", () => {
    const layout = twoColumns();
    const content = browserContent();
    const narrow = placeLiveBrowser(layout, content, { canvasWidth: 900 });
    expect(narrow.paneId).toBe("agent-pane");
    expect(leaves(narrow.layout.root).find((leaf) => leaf.paneId === "agent-pane")?.tabs).toContainEqual(content);
    const besideNarrow = placeLiveBrowser(layout, content, { anchorPaneId: "agent-pane", canvasWidth: 1200 });
    expect(besideNarrow.paneId).toBe("agent-pane");
  });

  it("fills an empty canvas", () => {
    const layout = emptyLayout();
    const content = browserContent();
    const placed = placeLiveBrowser(layout, content, { canvasWidth: 1200 });
    expect(leaves(placed.layout.root)).toHaveLength(1);
    expect(leaves(placed.layout.root)[0]?.tabs).toEqual([content]);
  });
});

function fakeController(layout: PaneLayout): PaneController {
  const controller = {
    layout,
    size: { current: { width: 1800, height: 900 } },
    show: vi.fn(),
    replace: vi.fn((next: PaneLayout) => {
      controller.layout = next;
    }),
    focusPane: vi.fn(),
  };
  return controller as unknown as PaneController;
}

describe("handleOpenLiveBrowser", () => {
  it("opens beside an agent and keeps the full runtime URL out of the saved layout", () => {
    const controller = fakeController(twoColumns());
    const initialUrls = new Map<string, string>();
    const besideAgents = new Map<string, string>();
    const result = handleOpenLiveBrowser(
      { kind: "open-live-browser", url: "http://localhost:5173/app?draft=1", beside: { agentId: "agent-1" } },
      controller,
      initialUrls,
      besideAgents,
    );
    expect([...besideAgents.values()]).toEqual(["agent-1"]);
    expect(result.handled).toBe(true);
    const panes = leaves(controller.layout.root);
    const browserPane = panes.at(-1);
    expect(browserPane?.tabs[0]).toMatchObject({ kind: "browser", url: "http://localhost:5173/app" });
    expect([...initialUrls.values()]).toEqual(["http://localhost:5173/app?draft=1"]);
    expect(controller.focusPane).toHaveBeenCalledWith(browserPane?.paneId);
  });

  it("brings an existing Live Browser forward for the same address", () => {
    const content = browserContent(undefined, "http://localhost:5173/");
    const layout = { ...twoColumns() };
    const withBrowser = splitPane(layout, "agent-pane", "horizontal", makeLeaf([content], "browser-pane"));
    const controller = fakeController(withBrowser);
    handleOpenLiveBrowser(
      { kind: "open-live-browser", url: "http://localhost:5173/", beside: null },
      controller,
      new Map(),
    );
    expect(controller.show).toHaveBeenCalledWith(content, { paneId: "browser-pane", focus: true });
    expect(controller.replace).not.toHaveBeenCalled();
  });
});

describe("openLiveBrowser", () => {
  it("falls back to the classic browser command on a canvas without Live Browser placement", () => {
    const seen: PaneCommand[] = [];
    const stop = listenForPaneCommands((command) => {
      seen.push(command);
      return command.kind === "open-live-browser"
        ? { handled: false, message: "Live Browser isn't available here." }
        : { handled: true };
    }, ws);
    openLiveBrowser({ workspaceId: ws, url: "localhost:5173" });
    stop();
    expect(seen).toEqual([
      { kind: "open-live-browser", url: "http://localhost:5173/", beside: null },
      { kind: "browser-control", command: { kind: "open", url: "http://localhost:5173/", newPane: true } },
    ]);
  });

  it("refuses an address the Browser can't open", () => {
    expect(openLiveBrowser({ workspaceId: ws, url: "file:///etc/passwd" })).toEqual({
      handled: false,
      message: "That address can't open in Live Browser.",
    });
    // Nothing was queued for a later canvas.
    const seen: PaneCommand[] = [];
    const stop = listenForPaneCommands((command) => {
      seen.push(command);
      return { handled: true };
    }, ws);
    stop();
    expect(seen).toEqual([]);
  });
});
