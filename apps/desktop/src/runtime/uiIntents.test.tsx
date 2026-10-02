// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { Activity, type ReactNode, useEffect, useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { focusHistory, recordFocus, resetFocusHistoryForTests } from "./focusHistory.ts";
import { UiIntentsProvider, useUiIntents } from "./uiIntents.tsx";

const mocks = vi.hoisted(() => ({
  clientIndex: 0,
  navigate: vi.fn(),
  activate: vi.fn(),
  getThread: vi.fn(),
  invoke: vi.fn(),
  request: vi.fn(),
  setPanelOpen: vi.fn(),
  selectTerminal: vi.fn(),
  running: [] as { id: string }[],
}));
vi.mock("../shell/navigation.tsx", () => ({ useNavigation: () => ({ navigate: mocks.navigate }) }));
vi.mock("./RuntimeProvider.tsx", () => {
  const clients = [0, 1].map(() => ({ getThread: mocks.getThread, transport: { invoke: mocks.invoke } }));
  return {
    useRuntime: () => ({
      client: clients[mocks.clientIndex],
      info: { flags: { features: [{ id: "provider_panes", visible: true }] } },
    }),
  };
});
vi.mock("./WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({
    active: { id: "workspace-a" },
    activate: mocks.activate,
    running: mocks.running,
    selectTerminal: mocks.selectTerminal,
  }),
}));
vi.mock("../surfaces/permissions/PermissionsProvider.tsx", () => ({
  usePermissions: () => ({ setPanelOpen: mocks.setPanelOpen }),
}));
vi.mock("../surfaces/threads/intent.tsx", () => ({ useThreadsIntent: () => ({ request: mocks.request }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const pane = { workspaceId: "workspace-a", runtimeKind: "interactive_pty", terminalId: null };
const mount = () => renderHook(useUiIntents, { wrapper: UiIntentsProvider });

describe("UI focus intent lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.clientIndex = 0;
    mocks.getThread.mockResolvedValue(pane);
    mocks.activate.mockResolvedValue(true);
    mocks.invoke.mockResolvedValue(null);
  });

  it("does not revive pending focus after a runtime A-to-B-to-A round trip", async () => {
    const read = deferred<typeof pane>();
    mocks.getThread.mockReturnValueOnce(read.promise);
    const view = mount();
    let pending!: Promise<void>;
    act(() => {
      pending = view.result.current.focus({ kind: "thread", threadId: "old" });
    });
    mocks.clientIndex = 1;
    view.rerender();
    mocks.clientIndex = 0;
    view.rerender();
    await act(async () => {
      read.resolve(pane);
      await pending;
    });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(view.result.current.paneFocus).toBeNull();
  });

  it("rejects retained focus and filter actions after unmount", async () => {
    const view = mount();
    const retained = view.result.current;
    view.unmount();
    await act(async () => {
      retained.filterDashboard("waiting_for_you");
      await retained.focus({ kind: "thread", threadId: "old" });
    });
    expect(mocks.getThread).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("rejects retained actions and handlers when the runtime is replaced", async () => {
    const view = mount();
    const retained = view.result.current;
    const oldHandler = vi.fn(() => false);
    mocks.clientIndex = 1;
    view.rerender();
    await act(async () => {
      retained.registerFocusHandler(oldHandler);
      retained.filterDashboard("waiting_for_you");
      await retained.focus({ kind: "provider", providerId: "old" });
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(async () => view.result.current.focus({ kind: "dashboard" }));
    expect(oldHandler).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("dashboard");
  });

  it("clears old pane and filter requests when the runtime changes", async () => {
    const view = mount();
    act(() => view.result.current.filterDashboard("waiting_for_you"));
    await act(async () => view.result.current.focus({ kind: "thread", threadId: "old" }));
    expect(view.result.current.paneFocus?.threadId).toBe("old");
    mocks.clientIndex = 1;
    view.rerender();
    expect(view.result.current.paneFocus).toBeNull();
    expect(view.result.current.dashboardFilter).toBeNull();
  });

  it("retires hidden effect sessions and reconnects current focus handlers under StrictMode", async () => {
    let visible = true;
    const handler = vi.fn(() => false);
    const frames: { pane: string | null; filter: string | null }[] = [];
    const view = renderHook(
      () => {
        const intents = useUiIntents();
        useEffect(() => intents.registerFocusHandler(handler), [intents.registerFocusHandler]);
        useLayoutEffect(() => {
          frames.push({ pane: intents.paneFocus?.threadId ?? null, filter: intents.dashboardFilter?.chip ?? null });
        });
        return intents;
      },
      {
        reactStrictMode: true,
        wrapper: ({ children }: { children: ReactNode }) => (
          <Activity mode={visible ? "visible" : "hidden"}>
            <UiIntentsProvider>{children}</UiIntentsProvider>
          </Activity>
        ),
      },
    );
    act(() => view.result.current.filterDashboard("waiting_for_you"));
    await act(async () => view.result.current.focus({ kind: "thread", threadId: "old" }));
    expect(view.result.current.paneFocus?.threadId).toBe("old");
    const oldNonce = view.result.current.paneFocus?.nonce ?? 0;
    const retired = view.result.current;
    visible = false;
    view.rerender();
    frames.length = 0;
    visible = true;
    view.rerender();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => frame.pane === null && frame.filter === null)).toBe(true);
    mocks.navigate.mockClear();
    mocks.getThread.mockClear();
    handler.mockClear();
    await act(async () => {
      retired.filterDashboard("waiting_for_you");
      await retired.focus({ kind: "thread", threadId: "retired" });
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.getThread).not.toHaveBeenCalled();
    await act(async () => view.result.current.focus({ kind: "thread", threadId: "fresh" }));
    expect(handler).toHaveBeenCalledExactlyOnceWith({ kind: "thread", threadId: "fresh" });
    expect(view.result.current.paneFocus?.threadId).toBe("fresh");
    expect(view.result.current.paneFocus?.nonce).toBeGreaterThan(oldNonce);
    act(() => retired.consumePaneFocus(view.result.current.paneFocus?.nonce ?? 0));
    expect(view.result.current.paneFocus?.threadId).toBe("fresh");
  });

  it("confirms the displayed workspace before focusing its pane while a switch may be pending", async () => {
    const activation = deferred<boolean>();
    mocks.activate.mockReturnValueOnce(activation.promise);
    const { result } = mount();
    let focus!: Promise<void>;
    await act(async () => {
      focus = result.current.focus({ kind: "thread", threadId: "current-pane" });
    });
    expect(mocks.activate).toHaveBeenCalledWith("workspace-a");
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(result.current.paneFocus).toBeNull();
    await act(async () => {
      activation.resolve(true);
      await focus;
    });
    expect(mocks.navigate).toHaveBeenCalledWith("code");
    expect(result.current.paneFocus?.threadId).toBe("current-pane");
  });

  it("does not navigate to an old thread after a newer focus request", async () => {
    const read = deferred<typeof pane>();
    mocks.getThread.mockReturnValueOnce(read.promise);
    const { result } = mount();
    let older!: Promise<void>;
    act(() => {
      older = result.current.focus({ kind: "thread", threadId: "old" });
    });
    await act(async () => result.current.focus({ kind: "provider", providerId: "codex" }));
    await act(async () => {
      read.resolve(pane);
      await older;
    });
    expect(mocks.navigate.mock.calls).toEqual([["providers"]]);
    expect(result.current.paneFocus).toBeNull();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("does not run stale default handling after an asynchronous handler declines", async () => {
    const claim = deferred<boolean>();
    const { result } = mount();
    result.current.registerFocusHandler((target) => (target.kind === "thread" ? claim.promise : false));
    let older!: Promise<void>;
    act(() => {
      older = result.current.focus({ kind: "thread", threadId: "old" });
    });
    await act(async () => result.current.focus({ kind: "dashboard" }));
    await act(async () => {
      claim.resolve(false);
      await older;
    });
    expect(mocks.getThread).not.toHaveBeenCalled();
    expect(mocks.navigate.mock.calls).toEqual([["dashboard"]]);
  });

  it("does not navigate after an obsolete workspace activation finishes", async () => {
    const activation = deferred<boolean>();
    mocks.activate.mockReturnValueOnce(activation.promise);
    const { result } = mount();
    let older!: Promise<void>;
    act(() => {
      older = result.current.focus({ kind: "workspace", workspaceId: "workspace-b" });
    });
    await act(async () => result.current.focus({ kind: "approvals" }));
    await act(async () => {
      activation.resolve(true);
      await older;
    });
    expect(mocks.setPanelOpen).toHaveBeenCalledWith(true);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("discards pending pane focus when a newer surface is requested", async () => {
    const { result } = mount();
    await act(async () => result.current.focus({ kind: "thread", threadId: "old" }));
    expect(result.current.paneFocus?.threadId).toBe("old");
    await act(async () => result.current.focus({ kind: "dashboard" }));
    expect(result.current.paneFocus).toBeNull();
  });

  it("does not reuse a consumed pane-focus identity", async () => {
    const { result } = mount();
    await act(async () => result.current.focus({ kind: "thread", threadId: "first" }));
    const first = result.current.paneFocus?.nonce;
    expect(first).toBeDefined();
    act(() => result.current.consumePaneFocus(first as number));
    await act(async () => result.current.focus({ kind: "thread", threadId: "second" }));
    act(() => result.current.consumePaneFocus(first as number));
    expect(result.current.paneFocus?.threadId).toBe("second");
  });

  it("stops a pending focus continuation when its provider unmounts", async () => {
    const read = deferred<typeof pane>();
    mocks.getThread.mockReturnValueOnce(read.promise);
    const { result, unmount } = mount();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.focus({ kind: "thread", threadId: "old" });
    });
    unmount();
    await act(async () => {
      read.resolve(pane);
      await pending;
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("still falls back when a current handler fails", async () => {
    const { result } = mount();
    result.current.registerFocusHandler(async () => {
      throw new Error("handler failed");
    });
    await act(async () => result.current.focus({ kind: "thread", threadId: "current" }));
    await waitFor(() => expect(result.current.paneFocus?.threadId).toBe("current"));
    expect(mocks.navigate).toHaveBeenCalledWith("code");
  });

  it("lets a direct Dashboard filter supersede a pending thread lookup", async () => {
    const read = deferred<typeof pane>();
    mocks.getThread.mockReturnValueOnce(read.promise);
    const { result } = mount();
    let older!: Promise<void>;
    act(() => {
      older = result.current.focus({ kind: "thread", threadId: "old" });
    });
    act(() => result.current.filterDashboard("waiting_for_you"));
    await act(async () => {
      read.resolve(pane);
      await older;
    });
    expect(mocks.navigate.mock.calls).toEqual([["dashboard"]]);
    expect(result.current.dashboardFilter?.chip).toBe("waiting_for_you");
    expect(result.current.paneFocus).toBeNull();
  });

  it("ignores an obsolete pane probe before activating its workspace", async () => {
    const probe = deferred<object | null>();
    mocks.getThread.mockResolvedValue({ ...pane, runtimeKind: "headless", workspaceId: "workspace-b" });
    mocks.invoke.mockReturnValueOnce(probe.promise);
    const { result } = mount();
    let older!: Promise<void>;
    act(() => {
      older = result.current.focus({ kind: "thread", threadId: "old" });
    });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    await act(async () => result.current.focus({ kind: "dashboard" }));
    await act(async () => {
      probe.resolve({});
      await older;
    });
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.navigate.mock.calls).toEqual([["dashboard"]]);
  });

  it("ignores an obsolete thread workspace activation", async () => {
    const activation = deferred<boolean>();
    mocks.getThread.mockResolvedValue({ ...pane, workspaceId: "workspace-b" });
    mocks.activate.mockReturnValueOnce(activation.promise);
    const { result } = mount();
    let older!: Promise<void>;
    act(() => {
      older = result.current.focus({ kind: "thread", threadId: "old" });
    });
    await waitFor(() => expect(mocks.activate).toHaveBeenCalled());
    await act(async () => result.current.focus({ kind: "provider", providerId: "codex" }));
    await act(async () => {
      activation.resolve(true);
      await older;
    });
    expect(mocks.navigate.mock.calls).toEqual([["providers"]]);
    expect(result.current.paneFocus).toBeNull();
  });

  it("ignores pending focus resolved against a replaced runtime client", async () => {
    const read = deferred<typeof pane>();
    mocks.getThread.mockReturnValueOnce(read.promise);
    const { result, rerender } = mount();
    let older!: Promise<void>;
    act(() => {
      older = result.current.focus({ kind: "thread", threadId: "old" });
    });
    mocks.clientIndex = 1;
    rerender();
    await act(async () => {
      read.resolve(pane);
      await older;
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(result.current.paneFocus).toBeNull();
  });

  it("still opens a current headless thread", async () => {
    mocks.getThread.mockResolvedValue({ ...pane, runtimeKind: "headless" });
    const { result } = mount();
    await act(async () => result.current.focus({ kind: "thread", threadId: "headless" }));
    expect(mocks.navigate.mock.calls).toEqual([["threads"]]);
    expect(mocks.request).toHaveBeenCalledWith("open", "headless");
    expect(result.current.paneFocus).toBeNull();
  });

  it("probes the pane while the thread is still being read", async () => {
    const read = deferred<typeof pane>();
    mocks.getThread.mockReturnValueOnce(read.promise);
    mocks.invoke.mockResolvedValue({});
    const { result } = mount();
    let opening!: Promise<void>;
    act(() => {
      opening = result.current.focus({ kind: "thread", threadId: "probe" });
    });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("provider_pane_info", { threadId: "probe" }));
    await act(async () => {
      read.resolve({ ...pane, runtimeKind: "headless", workspaceId: "workspace-b" });
      await opening;
    });
    expect(mocks.activate).toHaveBeenCalledWith("workspace-b");
    expect(result.current.paneFocus?.threadId).toBe("probe");
  });
});

describe("go back to what I was just using", () => {
  const headless = (threadId: string, archivedAt: string | null = null) => ({
    id: threadId,
    workspaceId: "workspace-a",
    runtimeKind: null,
    terminalId: null,
    archivedAt,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    resetFocusHistoryForTests();
    mocks.clientIndex = 0;
    mocks.running = [];
    mocks.getThread.mockImplementation(async (id: string) => headless(id));
    mocks.activate.mockResolvedValue(true);
    mocks.invoke.mockResolvedValue(null);
  });

  it("records focused threads and returns to the previous one", async () => {
    const view = mount();
    await act(async () => view.result.current.focus({ kind: "thread", threadId: "a" }));
    await act(async () => view.result.current.focus({ kind: "thread", threadId: "b" }));
    expect(focusHistory().map((e) => (e.kind === "thread" ? e.threadId : e.terminalId))).toEqual(["b", "a"]);
    let went = false;
    await act(async () => {
      went = await view.result.current.focusPrevious();
    });
    expect(went).toBe(true);
    expect(mocks.request).toHaveBeenLastCalledWith("open", "a");
    // Going back twice toggles, like switching windows.
    await act(async () => {
      await view.result.current.focusPrevious();
    });
    expect(mocks.request).toHaveBeenLastCalledWith("open", "b");
  });

  it("returns to a terminal in its workspace and skips ones that closed", async () => {
    recordFocus({ kind: "terminal", terminalId: "closed", workspaceId: "workspace-b" });
    recordFocus({ kind: "terminal", terminalId: "shell", workspaceId: "workspace-b" });
    recordFocus({ kind: "thread", threadId: "gone", workspaceId: null });
    recordFocus({ kind: "thread", threadId: "now", workspaceId: null });
    mocks.running = [{ id: "shell" }];
    mocks.getThread.mockImplementation(async (id: string) =>
      headless(id, id === "gone" ? "2026-09-28T12:00:00Z" : null),
    );
    const view = mount();
    let went = false;
    await act(async () => {
      went = await view.result.current.focusPrevious();
    });
    expect(went).toBe(true);
    expect(mocks.activate).toHaveBeenCalledWith("workspace-b");
    expect(mocks.navigate).toHaveBeenLastCalledWith("code");
    expect(mocks.selectTerminal).toHaveBeenCalledWith("shell", true, "workspace-b");
    expect(focusHistory().some((e) => e.kind === "thread" && e.threadId === "gone")).toBe(false);
  });

  it("does nothing when there is nothing to go back to", async () => {
    const view = mount();
    await act(async () => view.result.current.focus({ kind: "thread", threadId: "only" }));
    mocks.request.mockClear();
    let went = true;
    await act(async () => {
      went = await view.result.current.focusPrevious();
    });
    expect(went).toBe(false);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
