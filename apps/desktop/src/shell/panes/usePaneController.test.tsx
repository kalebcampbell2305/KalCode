import type { PaneContent, PaneLayout } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { findContent, findLeaf, makeLeaf } from "./model.ts";
import { LOAD_RETRY_MS, SAVE_DEBOUNCE_MS, usePaneController } from "./usePaneController.ts";

afterEach(() => {
  vi.useRealTimers();
});

it("keeps a transient load failure usable without overwriting the stored desk", async () => {
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("fallback")], "fallback"),
    dock: [],
    maximizedPaneId: null,
  };
  const store = {
    load: vi.fn().mockRejectedValue(new Error("layout database is busy")),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const view = renderHook(() =>
    usePaneController({ scope: "load-error-no-write", store, initial: () => initial, titleOf: () => "Terminal" }),
  );

  await waitFor(() => expect(view.result.current.ready).toBe(true));
  expect(view.result.current.loadError).toContain("layout database is busy");
  act(() => view.result.current.show(terminal("temporary")));
  view.unmount();
  await act(async () => undefined);

  expect(store.save).not.toHaveBeenCalled();
});

it("retries a failed load and enables persistence only after the canonical desk is read", async () => {
  const fallback: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("fallback")], "fallback"),
    dock: [],
    maximizedPaneId: null,
  };
  const stored: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("stored")], "stored"),
    dock: [],
    maximizedPaneId: null,
  };
  const store = {
    load: vi.fn().mockRejectedValueOnce(new Error("temporarily unavailable")).mockResolvedValueOnce(stored),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const view = renderHook(() =>
    usePaneController({ scope: "load-error-retry", store, initial: () => fallback, titleOf: () => "Terminal" }),
  );

  await waitFor(() => expect(view.result.current.loadError).not.toBeNull());
  await act(async () => view.result.current.retryLoad());
  await waitFor(() => expect(view.result.current.ready).toBe(true));

  expect(store.load).toHaveBeenCalledTimes(2);
  expect(view.result.current.loadError).toBeNull();
  expect(view.result.current.layout).toEqual(stored);
  expect(store.save).not.toHaveBeenCalled();
  act(() => view.result.current.show(terminal("after-retry")));
  const edited = view.result.current.layout;
  view.unmount();
  await waitFor(() => expect(store.save).toHaveBeenCalledWith(edited));
});

it("automatically retries a failed load without saving the fallback over the canonical desk", async () => {
  vi.useFakeTimers();
  const fallback: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("fallback")], "fallback"),
    dock: [],
    maximizedPaneId: null,
  };
  const stored: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("stored")], "stored"),
    dock: [],
    maximizedPaneId: null,
  };
  const store = {
    load: vi.fn<() => Promise<PaneLayout | null>>().mockRejectedValue(new Error("runtime not ready")),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const view = renderHook(() =>
    usePaneController({ scope: "automatic-load-retry", store, initial: () => fallback, titleOf: () => "Terminal" }),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));

  expect(view.result.current.ready).toBe(true);
  expect(view.result.current.loadError).toContain("runtime not ready");
  expect(view.result.current.layout).toEqual(fallback);
  await act(() => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2));
  expect(store.save).not.toHaveBeenCalled();

  store.load.mockResolvedValue(stored);
  await act(() => vi.advanceTimersByTimeAsync(LOAD_RETRY_MS));
  expect(store.load).toHaveBeenCalledTimes(2);
  expect(view.result.current.loadError).toBeNull();
  expect(view.result.current.layout).toEqual(stored);
  expect(store.save).not.toHaveBeenCalled();

  act(() => view.result.current.show(terminal("after-retry")));
  const edited = view.result.current.layout;
  await act(() => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS));
  expect(store.save).toHaveBeenCalledExactlyOnceWith(edited);
  view.unmount();
});

it("keeps visible edits when a retry returns the production-shaped default layout", async () => {
  vi.useFakeTimers();
  const fallback: PaneLayout = {
    schemaVersion: 1,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [500, 500],
      children: [makeLeaf([terminal("left")], "left"), makeLeaf([terminal("right")], "right")],
    },
    dock: [],
    maximizedPaneId: null,
  };
  const generatedDefault: PaneLayout = {
    ...fallback,
    root: {
      kind: "split",
      axis: "vertical",
      ratios: [400, 600],
      children: [makeLeaf([terminal("left")], "generated-left"), makeLeaf([terminal("right")], "generated-right")],
    },
  };
  const store = {
    load: vi.fn<() => Promise<PaneLayout | null>>().mockRejectedValue(new Error("runtime not ready")),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const view = renderHook(() =>
    usePaneController({ scope: "empty-load-retry", store, initial: () => fallback, titleOf: () => "Terminal" }),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  act(() => view.result.current.close("left"));
  expect(store.save).not.toHaveBeenCalled();

  // CodeCanvas generates a fresh default (including fresh pane IDs) when layout_get has no row.
  store.load.mockResolvedValue(generatedDefault);
  await act(() => vi.advanceTimersByTimeAsync(LOAD_RETRY_MS));
  expect(view.result.current.loadError).toBeNull();
  expect(view.result.current.layout.root.kind).toBe("leaf");
  expect(findLeaf(view.result.current.layout, "generated-left")).toBeNull();
  expect(findLeaf(view.result.current.layout, "generated-right")?.tabs).toEqual([terminal("right")]);
  expect(store.save).not.toHaveBeenCalled();

  const reconciled = view.result.current.layout;
  await act(() => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS));
  expect(store.save).toHaveBeenCalledExactlyOnceWith(reconciled);
  view.unmount();
});

it("applies fallback removals without replacing unseen canonical content or topology", async () => {
  vi.useFakeTimers();
  const fallback: PaneLayout = {
    schemaVersion: 1,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [500, 500],
      children: [makeLeaf([terminal("a")], "fallback-a"), makeLeaf([terminal("b")], "fallback-b")],
    },
    dock: [],
    maximizedPaneId: null,
  };
  const browser: PaneContent = { kind: "browser", browserId: "canonical-browser", url: "https://example.test" };
  const widget: PaneContent = { kind: "widget", widgetId: "canonical-widget" };
  const stored: PaneLayout = {
    schemaVersion: 1,
    root: {
      kind: "split",
      axis: "vertical",
      ratios: [350, 650],
      children: [makeLeaf([terminal("a"), browser], "stored-top"), makeLeaf([terminal("b"), widget], "stored-bottom")],
    },
    dock: [],
    maximizedPaneId: null,
  };
  const store = {
    load: vi
      .fn<() => Promise<PaneLayout | null>>()
      .mockRejectedValueOnce(new Error("runtime not ready"))
      .mockResolvedValue(stored),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const view = renderHook(() =>
    usePaneController({ scope: "merge-fallback-delta", store, initial: () => fallback, titleOf: () => "Pane" }),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  act(() => view.result.current.close("fallback-a"));
  act(() => view.result.current.show(terminal("new")));

  await act(() => vi.advanceTimersByTimeAsync(LOAD_RETRY_MS));
  expect(view.result.current.layout.root.kind).toBe("split");
  expect(view.result.current.layout.root.kind === "split" && view.result.current.layout.root.axis).toBe("vertical");
  expect(findLeaf(view.result.current.layout, "stored-top")?.tabs).toContainEqual(browser);
  expect(findLeaf(view.result.current.layout, "stored-bottom")?.tabs).toEqual([terminal("b"), widget]);
  expect(findContent(view.result.current.layout, "terminal:new")).not.toBeNull();

  const reconciled = view.result.current.layout;
  await act(() => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS));
  expect(store.save).toHaveBeenCalledExactlyOnceWith(reconciled);
  view.unmount();
});

it("structurally closes every canonical pane containing only a closed fallback pane's tabs", async () => {
  vi.useFakeTimers();
  const fallback: PaneLayout = {
    schemaVersion: 1,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [500, 500],
      children: [makeLeaf([terminal("a"), terminal("b")], "fallback-work"), makeLeaf([terminal("d")], "fallback-safe")],
    },
    dock: [],
    maximizedPaneId: null,
  };
  const widget: PaneContent = { kind: "widget", widgetId: "canonical-widget" };
  const stored: PaneLayout = {
    schemaVersion: 1,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [300, 700],
      children: [
        makeLeaf([terminal("a")], "stored-a"),
        {
          kind: "split",
          axis: "vertical",
          ratios: [400, 600],
          children: [makeLeaf([terminal("b")], "stored-b"), makeLeaf([terminal("d"), widget], "stored-safe")],
        },
      ],
    },
    dock: [],
    maximizedPaneId: null,
  };
  const store = {
    load: vi
      .fn<() => Promise<PaneLayout | null>>()
      .mockRejectedValueOnce(new Error("runtime not ready"))
      .mockResolvedValue(stored),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const view = renderHook(() =>
    usePaneController({ scope: "multi-pane-close-retry", store, initial: () => fallback, titleOf: () => "Pane" }),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  act(() => view.result.current.close("fallback-work"));

  await act(() => vi.advanceTimersByTimeAsync(LOAD_RETRY_MS));
  expect(findLeaf(view.result.current.layout, "stored-a")).toBeNull();
  expect(findLeaf(view.result.current.layout, "stored-b")).toBeNull();
  expect(findLeaf(view.result.current.layout, "stored-safe")?.tabs).toEqual([terminal("d"), widget]);
  const reconciled = view.result.current.layout;
  await act(() => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS));
  expect(store.save).toHaveBeenCalledExactlyOnceWith(reconciled);
  view.unmount();
});

it("closes only removed tabs after another tab moved out of the fallback pane", async () => {
  vi.useFakeTimers();
  const fallback: PaneLayout = {
    schemaVersion: 1,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [500, 500],
      children: [makeLeaf([terminal("a"), terminal("b")], "fallback-work"), makeLeaf([terminal("d")], "fallback-safe")],
    },
    dock: [],
    maximizedPaneId: null,
  };
  const widget: PaneContent = { kind: "widget", widgetId: "canonical-widget" };
  const stored: PaneLayout = {
    schemaVersion: 1,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [250, 250, 500],
      children: [
        makeLeaf([terminal("a")], "stored-a"),
        makeLeaf([terminal("b")], "stored-b"),
        makeLeaf([terminal("d"), widget], "stored-safe"),
      ],
    },
    dock: [],
    maximizedPaneId: null,
  };
  const store = {
    load: vi
      .fn<() => Promise<PaneLayout | null>>()
      .mockRejectedValueOnce(new Error("runtime not ready"))
      .mockResolvedValue(stored),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const view = renderHook(() =>
    usePaneController({ scope: "move-then-close-retry", store, initial: () => fallback, titleOf: () => "Pane" }),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  act(() => view.result.current.moveTab("fallback-work", 0, "fallback-safe", "center"));
  act(() => view.result.current.close("fallback-work"));

  await act(() => vi.advanceTimersByTimeAsync(LOAD_RETRY_MS));
  expect(findLeaf(view.result.current.layout, "stored-a")?.tabs).toEqual([terminal("a")]);
  expect(findLeaf(view.result.current.layout, "stored-b")).toBeNull();
  expect(findLeaf(view.result.current.layout, "stored-safe")?.tabs).toEqual([terminal("d"), widget]);
  view.unmount();
});

it("accepts a differing canonical desk after focus-only activity and preserves a surviving focus", async () => {
  vi.useFakeTimers();
  localStorage.clear();
  const fallback: PaneLayout = {
    schemaVersion: 1,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [500, 500],
      children: [makeLeaf([terminal("fallback")], "fallback"), makeLeaf([terminal("shared")], "shared")],
    },
    dock: [],
    maximizedPaneId: null,
  };
  const stored: PaneLayout = {
    ...fallback,
    root: {
      kind: "split",
      axis: "vertical",
      ratios: [300, 700],
      children: [makeLeaf([terminal("stored")], "stored"), makeLeaf([terminal("shared")], "stored-shared")],
    },
  };
  const store = {
    load: vi
      .fn<() => Promise<PaneLayout | null>>()
      .mockRejectedValueOnce(new Error("runtime not ready"))
      .mockResolvedValue(stored),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const view = renderHook(() =>
    usePaneController({ scope: "focus-only-load-retry", store, initial: () => fallback, titleOf: () => "Terminal" }),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  act(() => view.result.current.focusPane("shared", false));

  await act(() => vi.advanceTimersByTimeAsync(LOAD_RETRY_MS));
  expect(view.result.current.layout).toEqual(stored);
  expect(view.result.current.focusedPaneId).toBe("stored-shared");
  await act(() => vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS));
  expect(store.save).not.toHaveBeenCalled();
  view.unmount();
});

it("checkpoints a Browser navigation as soon as a retry confirms the canonical desk", async () => {
  localStorage.clear();
  vi.useFakeTimers();
  const initialBrowser: PaneContent = { kind: "browser", browserId: "browser", url: "https://example.test/a" };
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([initialBrowser], "browser"),
    dock: [],
    maximizedPaneId: null,
  };
  const navigated: PaneLayout = {
    ...initial,
    root: makeLeaf([{ kind: "browser", browserId: "browser", url: "https://example.test/b" }], "browser"),
  };
  const widget: PaneContent = { kind: "widget", widgetId: "canonical-widget" };
  const canonical: PaneLayout = {
    ...initial,
    root: {
      kind: "split",
      axis: "vertical",
      ratios: [600, 400],
      children: [makeLeaf([initialBrowser], "stored-browser"), makeLeaf([widget], "stored-widget")],
    },
  };
  let finishSave!: () => void;
  const store = {
    load: vi
      .fn<() => Promise<PaneLayout | null>>()
      .mockRejectedValueOnce(new Error("runtime not ready"))
      .mockResolvedValue(canonical),
    save: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    ),
  };
  const view = renderHook(() =>
    usePaneController({ scope: "browser-retry-checkpoint", store, initial: () => initial, titleOf: () => "Browser" }),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  act(() => view.result.current.replace(navigated));
  expect(store.save).not.toHaveBeenCalled();

  await act(() => vi.advanceTimersByTimeAsync(LOAD_RETRY_MS));
  expect(view.result.current.layout.root.kind).toBe("split");
  expect(findLeaf(view.result.current.layout, "stored-browser")?.tabs[0]).toEqual({
    kind: "browser",
    browserId: "browser",
    url: "https://example.test/b",
  });
  expect(findLeaf(view.result.current.layout, "stored-widget")?.tabs).toEqual([widget]);
  expect(store.save).toHaveBeenCalledExactlyOnceWith(view.result.current.layout);
  const recoveryData = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.getItem(localStorage.key(index) ?? ""),
  ).join("\n");
  expect(recoveryData).not.toContain("https://example.test/b");

  await act(async () => finishSave());
  view.unmount();
  expect(store.save).toHaveBeenCalledTimes(1);
});

it("cancels a failed workspace load retry when the controller changes scope", async () => {
  vi.useFakeTimers();
  const fallback: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("fallback")], "fallback"),
    dock: [],
    maximizedPaneId: null,
  };
  const next: PaneLayout = { ...fallback, root: makeLeaf([terminal("next")], "next") };
  const firstStore = {
    load: vi.fn<() => Promise<PaneLayout | null>>().mockRejectedValue(new Error("runtime not ready")),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const secondStore = {
    load: vi.fn<() => Promise<PaneLayout | null>>().mockResolvedValue(next),
    save: vi.fn().mockResolvedValue(undefined),
  };
  const view = renderHook(
    ({ scope, store }) => usePaneController({ scope, store, initial: () => fallback, titleOf: () => "Terminal" }),
    { initialProps: { scope: "retry-first", store: firstStore } },
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(firstStore.load).toHaveBeenCalledTimes(1);

  view.rerender({ scope: "retry-second", store: secondStore });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(view.result.current.layout).toEqual(next);
  await act(() => vi.advanceTimersByTimeAsync(LOAD_RETRY_MS * 4));

  expect(firstStore.load).toHaveBeenCalledTimes(1);
  expect(secondStore.load).toHaveBeenCalledTimes(1);
  view.unmount();
});

it("replays the latest pane close after an immediate remount before the canonical save finishes", async () => {
  localStorage.clear();
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [500, 500],
      children: [makeLeaf([terminal("one")], "one"), makeLeaf([terminal("two")], "two")],
    },
    dock: [],
    maximizedPaneId: null,
  };
  const store = {
    load: vi.fn().mockResolvedValue(initial),
    save: vi.fn(() => new Promise<void>(() => undefined)),
  };
  const options = {
    scope: "close-immediate-remount",
    store,
    initial: () => initial,
    titleOf: () => "Terminal",
  };
  const first = renderHook(() => usePaneController(options));
  await waitFor(() => expect(first.result.current.ready).toBe(true));

  act(() => first.result.current.close("two"));
  const closedLayout = first.result.current.layout;
  first.unmount();

  const second = renderHook(() => usePaneController(options));
  await waitFor(() => expect(second.result.current.ready).toBe(true));
  expect(second.result.current.layout).toEqual(closedLayout);
  expect(findLeaf(second.result.current.layout, "two")).toBeNull();
  second.unmount();
});

it("keeps signed Browser locations out of the write-ahead record and restores them from the canonical desk", async () => {
  localStorage.clear();
  const secretUrl = "https://example.test/work?token=do-not-copy";
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [500, 500],
      children: [
        makeLeaf([{ kind: "browser", browserId: "browser", url: secretUrl }], "browser"),
        makeLeaf([terminal("terminal")], "terminal"),
      ],
    },
    dock: [],
    maximizedPaneId: null,
  };
  const store = {
    load: vi.fn().mockResolvedValue(initial),
    save: vi.fn(() => new Promise<void>(() => undefined)),
  };
  const options = {
    scope: "browser-url-write-ahead",
    store,
    initial: () => initial,
    titleOf: () => "Pane",
  };
  const first = renderHook(() => usePaneController(options));
  await waitFor(() => expect(first.result.current.ready).toBe(true));
  act(() => first.result.current.close("terminal"));
  first.unmount();

  const savedBrowserData = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.getItem(localStorage.key(index) ?? ""),
  ).join("\n");
  expect(savedBrowserData).not.toContain("do-not-copy");

  const second = renderHook(() => usePaneController(options));
  await waitFor(() => expect(second.result.current.ready).toBe(true));
  expect(findLeaf(second.result.current.layout, "browser")?.tabs[0]).toEqual({
    kind: "browser",
    browserId: "browser",
    url: secretUrl,
  });
  expect(findLeaf(second.result.current.layout, "terminal")).toBeNull();
  second.unmount();
});

it("checkpoints Browser navigation immediately without copying its URL into the write-ahead record", async () => {
  localStorage.clear();
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([{ kind: "browser", browserId: "browser", url: "https://example.test/a" }], "browser"),
    dock: [],
    maximizedPaneId: null,
  };
  const navigated: PaneLayout = {
    ...initial,
    root: makeLeaf([{ kind: "browser", browserId: "browser", url: "https://example.test/b" }], "browser"),
  };
  let stored = initial;
  let finishSave!: () => void;
  const store = {
    load: vi.fn(async () => stored),
    save: vi.fn(
      (next: PaneLayout) =>
        new Promise<void>((resolve) => {
          finishSave = () => {
            stored = next;
            resolve();
          };
        }),
    ),
  };
  const options = {
    scope: "browser-navigation-checkpoint",
    store,
    initial: () => initial,
    titleOf: () => "Browser",
  };
  const first = renderHook(() => usePaneController(options));
  await waitFor(() => expect(first.result.current.ready).toBe(true));

  act(() => first.result.current.replace(navigated));
  await act(async () => Promise.resolve());

  expect(store.save).toHaveBeenCalledExactlyOnceWith(navigated);
  const recoveryData = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.getItem(localStorage.key(index) ?? ""),
  ).join("\n");
  expect(recoveryData).not.toContain("https://example.test/b");

  await act(async () => finishSave());
  first.unmount();
  const second = renderHook(() => usePaneController(options));
  await waitFor(() => expect(second.result.current.ready).toBe(true));
  expect(second.result.current.layout).toEqual(navigated);
  expect(store.save).toHaveBeenCalledTimes(1);
  second.unmount();
});

it("an older save completion cannot clear a newer crash-recovery layout", async () => {
  localStorage.clear();
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("base")], "pane"),
    dock: [],
    maximizedPaneId: null,
  };
  let stored = initial;
  let finishFirst!: () => void;
  const store = {
    load: vi.fn(async () => stored),
    save: vi
      .fn()
      .mockImplementationOnce(
        (layout: PaneLayout) =>
          new Promise<void>((resolve) => {
            finishFirst = () => {
              stored = layout;
              resolve();
            };
          }),
      )
      .mockImplementation(() => new Promise<void>(() => undefined)),
  };
  const options = {
    scope: "stale-save-write-ahead",
    store,
    initial: () => initial,
    titleOf: () => "Terminal",
  };
  const first = renderHook(() => usePaneController(options));
  await waitFor(() => expect(first.result.current.ready).toBe(true));
  act(() => first.result.current.show(terminal("first")));
  await waitFor(() => expect(store.save).toHaveBeenCalledTimes(1), { timeout: 2_000 });
  act(() => first.result.current.show(terminal("latest")));
  const latest = first.result.current.layout;
  first.unmount();
  await act(async () => finishFirst());
  await waitFor(() => expect(store.save).toHaveBeenCalledTimes(2));

  const second = renderHook(() => usePaneController(options));
  await waitFor(() => expect(second.result.current.ready).toBe(true));
  expect(second.result.current.layout).toEqual(latest);
  second.unmount();
});

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

it("requests one close for all tabs and preserves work opened while the decision is pending", async () => {
  const initial: PaneLayout = {
    schemaVersion: 1,
    root: makeLeaf([terminal("one"), terminal("two")], "pane", 0),
    maximizedPaneId: null,
    dock: [],
  };
  const requestClose = vi.fn();
  const onCloseContent = vi.fn();
  const store = { load: async () => initial, save: vi.fn().mockResolvedValue(undefined) };
  const { result } = renderHook(() =>
    usePaneController({
      scope: "smart-close",
      store,
      initial: () => initial,
      titleOf: () => "Terminal",
      requestClose,
      onCloseContent,
    }),
  );
  await waitFor(() => expect(result.current.ready).toBe(true));
  act(() => result.current.close("pane"));
  expect(requestClose).toHaveBeenCalledExactlyOnceWith([terminal("one"), terminal("two")], expect.any(Function));
  expect(result.current.layout).toEqual(initial);
  expect(onCloseContent).not.toHaveBeenCalled();
  act(() => result.current.show(terminal("new")));
  act(() => requestClose.mock.calls[0]?.[1]());
  expect(findLeaf(result.current.layout, "pane")?.tabs).toEqual([terminal("new")]);
});
