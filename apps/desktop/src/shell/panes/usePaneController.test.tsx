import type { PaneContent, PaneLayout } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import { findLeaf, makeLeaf } from "./model.ts";
import { usePaneController } from "./usePaneController.ts";

it("Tidy is exactly reversible and never closes running work", async () => {
  const { result } = await setup();
  act(() => result.current.split("pane", "horizontal", terminal("other")));
  const before = result.current.layout;
  const focus = result.current.focusedPaneId;
  act(() => result.current.tidy());
  expect(result.current.undoLayoutLabel).toBe("Tidy");
  act(() => result.current.undoLayout());
  expect(result.current.layout).toEqual(before);
  expect(result.current.focusedPaneId).toBe(focus);
  expect(result.current.undoLayoutLabel).toBeNull();
});

it("a manual edit after Tidy invalidates undo instead of discarding newly opened work", async () => {
  const { result } = await setup();
  act(() => result.current.tidy());
  act(() => result.current.show(terminal("new-work")));
  expect(result.current.undoLayoutLabel).toBeNull();
  const before = result.current.layout;
  act(() => result.current.undoLayout());
  expect(result.current.layout).toBe(before);
});

it("remembers focused pane per workspace across remounts", async () => {
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [500, 500],
      children: [makeLeaf([terminal("a")], "a"), makeLeaf([terminal("b")], "b")],
    },
    dock: [],
    maximizedPaneId: null,
  };
  const store = { load: async () => initial, save: vi.fn() };
  const options = { scope: "focus-restore", store, initial: () => initial, titleOf: () => "Terminal" };
  const first = renderHook(() => usePaneController(options));
  await waitFor(() => expect(first.result.current.ready).toBe(true));
  act(() => first.result.current.focusPane("b", false));
  first.unmount();
  const second = renderHook(() => usePaneController(options));
  await waitFor(() => expect(second.result.current.ready).toBe(true));
  expect(second.result.current.focusedPaneId).toBe("b");
  const unrelated = renderHook(() => usePaneController({ ...options, scope: "other-workspace" }));
  await waitFor(() => expect(unrelated.result.current.ready).toBe(true));
  expect(unrelated.result.current.focusedPaneId).toBe("a");
});

it("flushes a pending arrangement to its own workspace when scope changes before debounce", async () => {
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("a")], "a"),
    dock: [],
    maximizedPaneId: null,
  };
  const first = { load: async () => initial, save: vi.fn().mockResolvedValue(undefined) };
  const second = {
    load: async () => ({ ...initial, root: makeLeaf([terminal("b")], "b") }),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const view = renderHook(
    ({ scope, store }) => usePaneController({ scope, store, initial: () => initial, titleOf: () => "Terminal" }),
    { initialProps: { scope: "first", store: first } },
  );
  await waitFor(() => expect(view.result.current.ready).toBe(true));
  act(() => view.result.current.split("a", "horizontal", terminal("pending")));
  const edited = view.result.current.layout;
  view.rerender({ scope: "second", store: second });
  await waitFor(() => expect(view.result.current.ready).toBe(true));
  await waitFor(() => expect(first.save).toHaveBeenCalledWith(edited));
  expect(second.save).not.toHaveBeenCalledWith(edited);
});

const terminal = (terminalId: string): PaneContent => ({ kind: "terminal", terminalId });

it("keyboard focus and movement use the rendered readable pane geometry", async () => {
  const initial: PaneLayout = {
    schemaVersion: 1,
    dock: [],
    maximizedPaneId: null,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [500, 500],
      children: [
        { kind: "split", axis: "vertical", ratios: [100, 900], children: [makeLeaf([], "a"), makeLeaf([], "b")] },
        { kind: "split", axis: "vertical", ratios: [700, 300], children: [makeLeaf([], "c"), makeLeaf([], "d")] },
      ],
    },
  };
  const store = { load: async () => initial, save: vi.fn().mockResolvedValue(undefined) };
  const { result } = renderHook(() =>
    usePaneController({ scope: "geometry", store, initial: () => initial, titleOf: () => "Pane" }),
  );
  await waitFor(() => expect(result.current.ready).toBe(true));
  result.current.size.current = { width: 1000, height: 600 };
  act(() => result.current.focusPane("b"));
  act(() => result.current.focusDirection("right"));
  expect(result.current.focusedPaneId).toBe("d");
});

it("Undo cancels a pending Tidy save instead of persisting the discarded arrangement", async () => {
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("a")], "a"),
    dock: [],
    maximizedPaneId: "a",
  };
  const store = { load: async () => initial, save: vi.fn().mockResolvedValue(undefined) };
  const { result, unmount } = renderHook(() =>
    usePaneController({ scope: "undo-save", store, initial: () => initial, titleOf: () => "Terminal" }),
  );
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.tidy());
  act(() => result.current.undoLayout());
  unmount();
  expect(store.save).not.toHaveBeenCalled();
});

it("Undo is saved after an already-running Tidy save completes", async () => {
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("a")], "a"),
    dock: [],
    maximizedPaneId: "a",
  };
  let finish: () => void = () => undefined;
  const store = {
    load: async () => initial,
    save: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined),
  };
  const { result, unmount } = renderHook(() =>
    usePaneController({ scope: "undo-flight", store, initial: () => initial, titleOf: () => "Terminal" }),
  );
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.tidy());
  await waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
  act(() => result.current.undoLayout());
  unmount();
  await act(async () => finish());
  await waitFor(() => expect(store.save).toHaveBeenLastCalledWith(initial));
});

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

it("a closed pane that held only terminals and agents isn't offered for reopening (they ended)", async () => {
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [500, 500],
      children: [
        makeLeaf([terminal("one"), { kind: "agent", agentId: "a1" }], "ended"),
        makeLeaf([{ kind: "dashboard" }], "kept"),
      ],
    } as PaneLayout["root"],
    maximizedPaneId: null,
    dock: [],
  };
  const store = { load: async () => initial, save: vi.fn().mockResolvedValue(undefined) };
  const { result } = renderHook(() =>
    usePaneController({ scope: "workspace", store, initial: () => initial, titleOf: () => "Pane" }),
  );
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.close("ended"));
  expect(result.current.closed).toHaveLength(0);
  act(() => result.current.close("kept"));
  expect(result.current.closed).toHaveLength(1);
});
