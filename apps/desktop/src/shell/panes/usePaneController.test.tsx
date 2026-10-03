import type { PaneContent, PaneLayout } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import { findLeaf, makeLeaf } from "./model.ts";
import { usePaneController } from "./usePaneController.ts";

const terminal = (terminalId: string): PaneContent => ({ kind: "terminal", terminalId });

async function setup() {
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("earlier"), terminal("selected")], "pane", 1),
    maximizedPaneId: "pane",
    dock: [],
  };
  const store = { load: async () => initial, save: vi.fn().mockResolvedValue(undefined) };
  const view = renderHook(
    () => usePaneController({ scope: "workspace", store, initial: () => initial, titleOf: () => "Terminal" }),
    { wrapper: StrictMode },
  );
  await waitFor(() => expect(view.result.current.ready).toBe(true));
  return view;
}

it.each(["late-created", "earlier"])(
  "background reconciliation of %s preserves the selected tab and keyboard focus",
  async (id) => {
    const { result } = await setup();
    const focus = result.current.focusRequest;
    const background = { focus: false, activate: false };
    act(() => result.current.show(terminal(id), background));
    const pane = findLeaf(result.current.layout, "pane");
    expect(pane?.tabs[pane.activeTab]).toEqual(terminal("selected"));
    expect(pane?.tabs).toContainEqual(terminal(id));
    expect(result.current.focusRequest).toEqual(focus);
    expect(result.current.layout.maximizedPaneId).toBe("pane");
  },
);

it("an explicit show still selects the requested terminal and requests keyboard focus", async () => {
  const { result } = await setup();
  const before = result.current.focusRequest.n;
  act(() => result.current.show(terminal("late-created")));
  const pane = findLeaf(result.current.layout, "pane");
  expect(pane?.tabs[pane.activeTab]).toEqual(terminal("late-created"));
  expect(result.current.focusRequest.n).toBeGreaterThan(before);
});

it("closing a pane hands every content it held to the host to close (a shell terminal ends)", async () => {
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("one"), terminal("two")], "pane", 0),
    maximizedPaneId: null,
    dock: [],
  };
  const onCloseContent = vi.fn();
  const store = { load: async () => initial, save: vi.fn().mockResolvedValue(undefined) };
  const { result } = renderHook(() =>
    usePaneController({ scope: "workspace", store, initial: () => initial, titleOf: () => "Terminal", onCloseContent }),
  );
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.close("pane"));
  expect(onCloseContent.mock.calls.map(([content]) => content)).toEqual([terminal("one"), terminal("two")]);
});
