import type { PaneContent, PaneLayout, PaneNode } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { contentKey, makeLeaf, toRatios } from "./model.ts";
import { PaneCanvas, type PaneHost } from "./PaneCanvas.tsx";
import { type PaneController, usePaneController } from "./usePaneController.ts";

const ids = ["a", "b", "c", "d", "e"] as const;
const agent = (id: string): PaneContent => ({ kind: "agent", agentId: id });

function layoutFor(items: readonly string[]): PaneLayout {
  const children = items.map((id) => makeLeaf([agent(id)], `pane-${id}`));
  const first = children[0];
  if (!first) throw new Error("A hydration layout needs at least one pane.");
  const root: PaneNode =
    children.length === 1
      ? first
      : {
          kind: "split",
          axis: "horizontal",
          ratios: toRatios(children.map(() => 1)),
          children,
        };
  return { schemaVersion: 1, root, maximizedPaneId: null, dock: [] };
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => vi.unstubAllGlobals());

function runFrame() {
  const pending = [...frames.values()];
  frames.clear();
  act(() => {
    for (const callback of pending) callback(performance.now());
  });
}

function setup(items: readonly string[] = ids) {
  const initial = layoutFor(items);
  let controller: PaneController;
  const mounted: string[] = [];
  function HeavyPane({ id }: { id: string }) {
    useEffect(() => {
      mounted.push(id);
    }, [id]);
    return <p data-testid="heavy-pane">{id}</p>;
  }
  const host: PaneHost = {
    describe: (content) => ({ title: contentKey(content), glyph: null }),
    render: (content) => {
      const id = content.kind === "agent" ? content.agentId : "unknown";
      return <HeavyPane id={id} />;
    },
    renderEmpty: () => null,
    addMenu: () => null,
  };
  function Harness() {
    controller = usePaneController({
      scope: "hydration",
      store: { load: async () => initial, save: async () => undefined },
      initial: () => initial,
      titleOf: contentKey,
    });
    return controller.ready ? <PaneCanvas controller={controller} host={host} label="Hydration canvas" /> : null;
  }
  const view = render(
    <TooltipProvider>
      <Harness />
    </TooltipProvider>,
  );
  return {
    ...view,
    get controller() {
      return controller;
    },
    mounted,
  };
}

it("paints every pane shell, hydrates the focused heavy pane first, then hydrates two per frame", async () => {
  const view = setup();
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(5));

  expect(screen.getAllByTestId("heavy-pane")).toHaveLength(1);
  expect(view.mounted).toEqual(["a"]);

  runFrame();
  expect(screen.getAllByTestId("heavy-pane")).toHaveLength(3);
  expect(view.mounted).toEqual(["a", "b", "c"]);

  runFrame();
  expect(screen.getAllByTestId("heavy-pane")).toHaveLength(5);
  expect(view.mounted).toEqual(["a", "b", "c", "d", "e"]);
});

it("cancels a queued heavy pane when it closes and never hydrates it later", async () => {
  const view = setup(["a", "b", "c"]);
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
  expect(view.mounted).toEqual(["a"]);

  act(() => view.controller.forget(new Set(["agent:c"])));
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(view.mounted).toEqual(["a"]);
  expect(screen.queryByText("c")).toBeNull();
  expect(frames.size).toBe(1);
  runFrame();
  runFrame();

  expect(view.mounted).toEqual(["a", "b"]);
  expect(screen.queryByText("c")).toBeNull();
});
