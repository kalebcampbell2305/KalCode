import type { PaneContent, PaneLayout } from "@kalcode/protocol";
import { expect, it, vi } from "vitest";
import type { TabInfo } from "./contentRegistry.ts";
import { makeLeaf } from "./model.ts";
import { runCommand } from "./PaneCanvas.tsx";
import type { PaneController } from "./usePaneController.ts";

const terminal = (terminalId: string): PaneContent => ({ kind: "terminal", terminalId });

function setup(titles: Record<string, string>) {
  const layout: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("frontend"), terminal("release")], "pane", 0),
    maximizedPaneId: null,
    dock: [],
  };
  const close = vi.fn();
  const hideTab = vi.fn();
  const closed = new Map<string, () => void>([
    ["frontend", vi.fn()],
    ["release", vi.fn()],
  ]);
  const controller = {
    layout,
    focusedPaneId: "pane",
    close,
    hideTab,
  } as unknown as PaneController;
  const describe = (content: PaneContent): TabInfo => {
    if (content.kind !== "terminal") throw new Error("expected terminal content");
    const callback = closed.get(content.terminalId);
    return {
      title: titles[content.terminalId] ?? content.terminalId,
      glyph: null,
      onClose: callback ? () => callback() : undefined,
    };
  };
  return { controller, close, hideTab, closed, describe };
}

it("closes only the exact named tab instead of every tab in its pane", () => {
  const { controller, close, hideTab, closed, describe } = setup({
    frontend: "Frontend terminal",
    release: "Release terminal",
  });

  expect(runCommand(controller, { kind: "close", query: "Release terminal" }, describe)).toEqual({ handled: true });
  expect(closed.get("release")).toHaveBeenCalledOnce();
  expect(closed.get("frontend")).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(hideTab).not.toHaveBeenCalled();
});

it("refuses an ambiguous partial close without closing any tab or pane", () => {
  const { controller, close, hideTab, closed, describe } = setup({
    frontend: "Agent frontend",
    release: "Agent release",
  });

  expect(runCommand(controller, { kind: "close", query: "agent" }, describe)).toEqual({
    handled: false,
    message: "More than one tab matches “agent”. Which one?",
  });
  expect(closed.get("frontend")).not.toHaveBeenCalled();
  expect(closed.get("release")).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(hideTab).not.toHaveBeenCalled();
});

it("does not treat an empty named target as an unqualified focused-pane close", () => {
  const { controller, close, hideTab, closed, describe } = setup({ frontend: "Frontend", release: "Release" });

  expect(runCommand(controller, { kind: "close", query: "   " }, describe)).toEqual({
    handled: false,
    message: "No tab matches “   ”.",
  });
  expect(closed.get("frontend")).not.toHaveBeenCalled();
  expect(closed.get("release")).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(hideTab).not.toHaveBeenCalled();
});

it("keeps the unqualified close command scoped to the focused pane", () => {
  const { controller, close, describe } = setup({ frontend: "Frontend", release: "Release" });

  expect(runCommand(controller, { kind: "close" }, describe)).toEqual({ handled: true });
  expect(close).toHaveBeenCalledExactlyOnceWith("pane");
});
