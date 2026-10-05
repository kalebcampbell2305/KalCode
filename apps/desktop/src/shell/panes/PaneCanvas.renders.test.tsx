import type { PaneContent, PaneLayout } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { memo, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { contentKey, makeLeaf } from "./model.ts";
import { PaneCanvas, type PaneHost } from "./PaneCanvas.tsx";
import { usePaneController } from "./usePaneController.ts";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

const ids = ["a", "b", "c"] as const;
const agent = (id: string): PaneContent => ({ kind: "agent", agentId: id });
const initial: PaneLayout = {
  schemaVersion: 1,
  root: {
    kind: "split",
    axis: "horizontal",
    ratios: [333, 333, 334],
    children: ids.map((id) => makeLeaf([agent(id)], `pane-${id}`)),
  },
  maximizedPaneId: null,
  dock: [],
};

const frameRenders = new Map<string, number>();
const bodyRenders = new Map<string, number>();
const bump = (map: Map<string, number>, id: string) => map.set(id, (map.get(id) ?? 0) + 1);

/** A tab glyph: it re-renders exactly when its pane frame does. */
function Glyph({ id }: { id: string }) {
  bump(frameRenders, id);
  return <span />;
}

const Body = memo(function Body({ id, status }: { id: string; status: string }) {
  bump(bodyRenders, id);
  return <p>{`${id} is ${status}`}</p>;
});

const closers = new Map<string, () => void>();
const closeFor = (id: string) => {
  let close = closers.get(id);
  if (!close) {
    close = () => undefined;
    closers.set(id, close);
  }
  return close;
};

let setStatus: (id: string, status: string) => void = () => undefined;

function Harness() {
  const [statuses, setStatuses] = useState<Record<string, string>>({ a: "idle", b: "idle", c: "idle" });
  setStatus = (id, status) => setStatuses((current) => ({ ...current, [id]: status }));
  const controller = usePaneController({
    scope: "renders",
    store: { load: async () => initial, save: async () => undefined },
    initial: () => initial,
    titleOf: (content) => contentKey(content),
  });
  const id = (content: PaneContent) => (content.kind === "agent" ? content.agentId : "");
  // A new host on every status change, like Code's canvas when one agent's status changes.
  const host: PaneHost = {
    describe: (content) => ({
      title: `Agent ${id(content)}`,
      glyph: <Glyph id={id(content)} />,
      tone: statuses[id(content)] === "active" ? "working" : "muted",
      onClose: closeFor(id(content)),
    }),
    render: (content) => <Body id={id(content)} status={statuses[id(content)] ?? ""} />,
    renderEmpty: () => null,
    addMenu: () => null,
    contextMenu: (content) => [{ id: "state", label: `State: ${statuses[id(content)]}`, onSelect: () => undefined }],
  };
  return controller.ready ? <PaneCanvas controller={controller} host={host} label="Panes" scope="renders" /> : null;
}

it("one agent's status change re-renders only that agent's pane frame and body", async () => {
  render(
    <TooltipProvider>
      <Harness />
    </TooltipProvider>,
  );
  await waitFor(() => expect(screen.getByText("c is idle")).toBeTruthy());
  frameRenders.clear();
  bodyRenders.clear();

  act(() => setStatus("b", "active"));

  expect(screen.getByText("b is active")).toBeTruthy();
  expect(frameRenders.get("b")).toBeGreaterThan(0);
  expect(bodyRenders.get("b")).toBeGreaterThan(0);
  for (const sibling of ["a", "c"]) {
    expect(frameRenders.get(sibling) ?? 0).toBe(0);
    expect(bodyRenders.get(sibling) ?? 0).toBe(0);
  }
});

it("a memoized frame's context menu still offers the host's current actions", async () => {
  render(
    <TooltipProvider>
      <Harness />
    </TooltipProvider>,
  );
  await waitFor(() => expect(screen.getByText("a is idle")).toBeTruthy());
  frameRenders.clear();
  // Only the menu's words change for "a" (its tab stays the same), so its frame is not re-rendered.
  act(() => setStatus("a", "paused"));
  expect(frameRenders.get("a") ?? 0).toBe(0);
  fireEvent.contextMenu(screen.getByRole("tab", { name: "Agent a" }));
  expect(await screen.findByRole("menuitem", { name: "State: paused" })).toBeTruthy();
});
