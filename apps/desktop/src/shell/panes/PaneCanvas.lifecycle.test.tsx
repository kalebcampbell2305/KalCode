import type { PaneContent, PaneLayout } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { computeGeometry, contentKey, makeLeaf } from "./model.ts";
import { CANVAS_GEOMETRY, canvasExtent, hitTest, PaneCanvas, type PaneHost } from "./PaneCanvas.tsx";
import { dispatchPaneCommand, paneCanvasListening } from "./paneCommands.ts";
import { type PaneController, usePaneController } from "./usePaneController.ts";

afterEach(() => vi.unstubAllGlobals());

it("only the visible retained workspace receives commands and drains its queued commands on return", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const commands = { one: vi.fn(() => ({ handled: true as const })), two: vi.fn(() => ({ handled: true as const })) };
  const initial: PaneLayout = { schemaVersion: 1, root: makeLeaf([], "pane"), maximizedPaneId: null, dock: [] };
  const store = { load: async () => initial, save: vi.fn().mockResolvedValue(undefined) };
  function Canvas({ id, active }: { id: "one" | "two"; active: boolean }) {
    const controller = usePaneController({ scope: id, store, initial: () => initial, titleOf: () => id });
    const host: PaneHost = {
      describe: () => null,
      render: () => null,
      renderEmpty: () => null,
      addMenu: () => null,
      onCommand: commands[id],
    };
    return controller.ready ? (
      <PaneCanvas controller={controller} host={host} scope={id} active={active} label={id} />
    ) : null;
  }
  function Harness({ active }: { active: string }) {
    return (
      <TooltipProvider>
        <Canvas id="one" active={active === "one"} />
        <Canvas id="two" active={active === "two"} />
      </TooltipProvider>
    );
  }
  const view = render(<Harness active="one" />);
  await waitFor(() => expect(paneCanvasListening("one")).toBe(true));
  act(() => {
    dispatchPaneCommand({ kind: "even" });
    dispatchPaneCommand({ kind: "even" }, { scope: "two", queue: true });
  });
  expect(commands.one).toHaveBeenCalledTimes(1);
  expect(commands.two).not.toHaveBeenCalled();
  view.rerender(<Harness active="two" />);
  expect(commands.two).toHaveBeenCalledTimes(1);
  expect(paneCanvasListening("two")).toBe(true);
  view.rerender(<Harness active="one" />);
  act(() => {
    dispatchPaneCommand({ kind: "even" });
  });
  expect(commands.one).toHaveBeenCalledTimes(2);
  expect(commands.two).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(paneCanvasListening()).toBe(false);
});

it.each(["terminal", "browser", "widget", "agent"] as const)(
  "retains %s mounts and DOM identity across tabs, moves, minimize, maximize, dock and presets",
  async (kind) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const attached = vi.fn();
    const detached = vi.fn();
    function Session({ id }: { id: string }) {
      useEffect(() => {
        attached(id);
        return () => detached(id);
      }, [id]);
      return <input aria-label={id} defaultValue="in-progress command" />;
    }
    const terminal = (id: string): PaneContent => {
      switch (kind) {
        case "terminal":
          return { kind, terminalId: id };
        case "browser":
          return { kind, browserId: id, url: null };
        case "widget":
          return { kind, widgetId: id };
        case "agent":
          return { kind, agentId: id };
      }
    };
    const initial: PaneLayout = {
      schemaVersion: 1,
      root: {
        kind: "split",
        axis: "horizontal",
        ratios: [500, 500],
        children: [makeLeaf([terminal("one"), terminal("two")], "left"), makeLeaf([terminal("three")], "right")],
      },
      maximizedPaneId: null,
      dock: [],
    };
    let controller: PaneController;
    let menuAvailable = true;
    const menuAction = vi.fn();
    const host: PaneHost = {
      describe: (content) => ({ title: contentKey(content), glyph: null }),
      render: (content) => <Session id={contentKey(content).split(":")[1] ?? ""} />,
      renderEmpty: () => null,
      addMenu: () => null,
      contextMenu: (content, paneId) =>
        menuAvailable
          ? [
              {
                id: "inspect",
                label: "Inspect clicked object",
                onSelect: () => menuAction(contentKey(content), paneId),
              },
            ]
          : [],
    };
    const store = { load: async () => initial, save: vi.fn().mockResolvedValue(undefined) };
    function Harness() {
      controller = usePaneController({ scope: "test", store, initial: () => initial, titleOf: () => "Terminal" });
      return controller.ready ? <PaneCanvas controller={controller} host={host} label="Test canvas" /> : null;
    }
    const view = render(
      <TooltipProvider>
        <Harness />
      </TooltipProvider>,
    );
    await waitFor(() => expect(view.getByLabelText("one", { selector: "input" })).toBeTruthy());
    const original = view.getByLabelText("one", { selector: "input" });
    expect(attached).toHaveBeenCalledTimes(2);
    menuAvailable = false;
    act(() => controller.activate("left", 1));
    menuAvailable = true;
    act(() => controller.activate("left", 0));
    const count = attached.mock.calls.length;
    expect(count).toBe(3);
    expect(view.getByLabelText("one", { selector: "input" })).toBe(original);
    act(() => controller.toggleCollapse("left"));
    act(() => controller.toggleCollapse("left"));
    act(() => controller.toggleMaximize("right"));
    act(() => controller.restore());
    act(() => controller.moveTab("left", 0, "right", "center"));
    expect(view.getByLabelText("one", { selector: "input" })).toBe(original);
    expect(original.closest("[data-pane-id]")?.getAttribute("data-pane-id")).toBe("right");
    fireEvent.contextMenu(original);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Inspect clicked object" }));
    expect(menuAction).toHaveBeenLastCalledWith(`${kind}:one`, "right");
    act(() => controller.dock("right"));
    act(() => controller.undock(1));
    expect(view.getByLabelText("one", { selector: "input" })).toBe(original);
    act(() => controller.preset("six"));
    act(() => controller.preset("two"));
    expect(view.getByLabelText("one", { selector: "input" })).toBe(original);
    expect(attached).toHaveBeenCalledTimes(count);
    expect(detached).not.toHaveBeenCalled();
    view.unmount();
    expect(detached).toHaveBeenCalledTimes(count);
  },
);

it("keeps every pane readable in dense layouts and maximizes within the viewport", () => {
  const layout: PaneLayout = {
    schemaVersion: 1,
    dock: [],
    maximizedPaneId: null,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [100, 200, 700],
      children: [makeLeaf([], "a"), makeLeaf([], "b"), makeLeaf([], "c")],
    },
  };
  const extent = canvasExtent(layout, 640, 180);
  const geometry = computeGeometry(layout, extent.width, extent.height, CANVAS_GEOMETRY);
  for (const rect of geometry.panes.values()) {
    expect(rect.width).toBeGreaterThanOrEqual(320);
    expect(rect.height).toBeGreaterThanOrEqual(220);
  }
  expect(canvasExtent({ ...layout, maximizedPaneId: "a" }, 640, 480)).toEqual({ width: 640, height: 480 });
});

it("holds magnetic snap zones through small pointer jitter but releases intentionally", () => {
  const panes = new Map([["a", { x: 0, y: 0, width: 1000, height: 634 }]]);
  const visible = new Set(["a"]);
  const snapped = hitTest(panes, 270, 334, visible);
  expect(snapped).toEqual({ paneId: "a", zone: "left" });
  expect(hitTest(panes, 300, 334, visible, snapped)).toEqual(snapped);
  expect(hitTest(panes, 400, 334, visible, snapped)).toEqual({ paneId: "a", zone: "center" });
  expect(hitTest(panes, 400, 334, new Set(), snapped)).toBeNull();
});
