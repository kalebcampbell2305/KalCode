// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UiIntentsProvider, useUiIntents } from "./uiIntents.tsx";

const mocks = vi.hoisted(() => ({
  clientIndex: 0,
  navigate: vi.fn(),
  activate: vi.fn(),
  getThread: vi.fn(),
  invoke: vi.fn(),
  request: vi.fn(),
  setPanelOpen: vi.fn(),
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
  useWorkspaces: () => ({ active: { id: "workspace-a" }, activate: mocks.activate }),
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
    expect(mocks.invoke).not.toHaveBeenCalled();
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
});
