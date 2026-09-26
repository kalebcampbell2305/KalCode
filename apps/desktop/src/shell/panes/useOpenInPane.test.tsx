// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOpenInPane } from "./useOpenInPane.ts";

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  navigate: vi.fn(),
  dispatch: vi.fn(),
  client: {},
  activeId: "workspace-current",
}));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => ({ client: mocks.client }) }));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({ active: { id: mocks.activeId }, activate: mocks.activate }),
}));
vi.mock("../navigation.tsx", () => ({ useNavigation: () => ({ navigate: mocks.navigate }) }));
vi.mock("./paneCommands.ts", () => ({ dispatchPaneCommand: mocks.dispatch }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("pane workspace activation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.client = {};
    mocks.activeId = "workspace-current";
    mocks.dispatch.mockResolvedValue({ handled: true });
  });

  it.each([undefined, "workspace-current"])(
    "confirms the displayed workspace before opening (target %s)",
    async (workspaceId) => {
      let resolve!: (value: boolean) => void;
      mocks.activate.mockReturnValue(
        new Promise<boolean>((done) => {
          resolve = done;
        }),
      );
      const { result } = renderHook(useOpenInPane);
      let opened!: ReturnType<typeof result.current>;
      act(() => {
        opened = result.current({ kind: "dashboard" }, { workspaceId });
      });
      expect(mocks.activate).toHaveBeenCalledWith("workspace-current");
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(mocks.dispatch).not.toHaveBeenCalled();
      await act(async () => {
        resolve(true);
        await opened;
      });
      expect(mocks.navigate).toHaveBeenCalledWith("code");
      expect(mocks.dispatch).toHaveBeenCalledWith(
        { kind: "open", content: { kind: "dashboard" } },
        { queue: true, scope: "workspace-current" },
      );
    },
  );

  it("does not dispatch when the displayed workspace activation is superseded", async () => {
    mocks.activate.mockResolvedValue(false);
    const { result } = renderHook(useOpenInPane);
    let opened!: Awaited<ReturnType<typeof result.current>>;
    await act(async () => {
      opened = await result.current({ kind: "dashboard" });
    });
    expect(opened.handled).toBe(false);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("does not open a pane when the requesting view unmounts during activation", async () => {
    const activation = deferred<boolean>();
    mocks.activate.mockReturnValue(activation.promise);
    const { result, unmount } = renderHook(useOpenInPane);
    const opening = result.current({ kind: "dashboard" });
    unmount();
    activation.resolve(true);
    expect((await opening).handled).toBe(false);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch retained callbacks after unmount", async () => {
    mocks.activate.mockResolvedValue(true);
    const { result, unmount } = renderHook(useOpenInPane);
    const open = result.current;
    unmount();
    expect((await open({ kind: "dashboard" })).handled).toBe(false);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("does not revive pending opens or retained callbacks when a previous client returns", async () => {
    const activation = deferred<boolean>();
    mocks.activate.mockReturnValueOnce(activation.promise).mockResolvedValue(true);
    const original = mocks.client;
    const { result, rerender } = renderHook(useOpenInPane);
    const retained = result.current;
    const pending = retained({ kind: "dashboard" });
    mocks.client = {};
    rerender();
    mocks.client = original;
    rerender();
    activation.resolve(true);
    expect((await pending).handled).toBe(false);
    expect((await retained({ kind: "dashboard" })).handled).toBe(false);
    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    await result.current({ kind: "dashboard" });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps the newer pane intent when an older activation resolves last", async () => {
    const activation = deferred<boolean>();
    mocks.activate.mockReturnValueOnce(activation.promise).mockResolvedValue(true);
    const { result } = renderHook(useOpenInPane);
    const older = result.current({ kind: "terminal", terminalId: "old" });
    await result.current({ kind: "terminal", terminalId: "new" }, { placement: "split" });
    activation.resolve(true);
    expect((await older).handled).toBe(false);
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
      { kind: "open", content: { kind: "terminal", terminalId: "new" }, placement: "split" },
      { queue: true, scope: "workspace-current" },
    );
  });

  it("does not report a stale activation failure after a newer intent succeeds", async () => {
    const activation = deferred<boolean>();
    mocks.activate.mockReturnValueOnce(activation.promise).mockResolvedValue(true);
    const { result } = renderHook(useOpenInPane);
    const older = result.current({ kind: "dashboard" });
    await result.current({ kind: "dashboard" });
    activation.resolve(false);
    expect(await older).toEqual({ handled: false, message: "" });
  });

  it("suppresses obsolete rejections but preserves a current activation error", async () => {
    const old = deferred<boolean>();
    mocks.activate.mockReturnValueOnce(old.promise).mockResolvedValue(true);
    const { result } = renderHook(useOpenInPane);
    const pending = result.current({ kind: "dashboard" });
    await result.current({ kind: "dashboard" });
    old.reject(new Error("obsolete"));
    expect(await pending).toEqual({ handled: false, message: "" });
    mocks.activate.mockRejectedValueOnce(new Error("current"));
    await expect(result.current({ kind: "dashboard" })).rejects.toThrow("current");
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps the useful error for a current activation refusal", async () => {
    mocks.activate.mockResolvedValue(false);
    const { result } = renderHook(useOpenInPane);
    expect(await result.current({ kind: "dashboard" })).toEqual({
      handled: false,
      message: "KalCode couldn't open that workspace.",
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("does not invalidate its own request when activation updates the displayed workspace", async () => {
    const activation = deferred<boolean>();
    mocks.activate.mockReturnValue(activation.promise);
    const { result, rerender } = renderHook(useOpenInPane);
    const opening = result.current({ kind: "dashboard" }, { workspaceId: "workspace-new" });
    mocks.activeId = "workspace-new";
    rerender();
    activation.resolve(true);
    expect((await opening).handled).toBe(true);
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.anything(), { queue: true, scope: "workspace-new" });
  });

  it("ignores the pending request from discarded root StrictMode setup", async () => {
    const old = deferred<boolean>();
    mocks.activate.mockReturnValueOnce(old.promise).mockResolvedValue(true);
    const calls: ReturnType<ReturnType<typeof useOpenInPane>>[] = [];
    renderHook(
      () => {
        const open = useOpenInPane();
        useEffect(() => {
          calls.push(open({ kind: "dashboard" }));
        }, [open]);
      },
      { reactStrictMode: true },
    );
    expect(calls).toHaveLength(2);
    await act(async () => {
      await calls[1];
      old.resolve(true);
      await calls[0];
    });
    expect((await calls[0])?.handled).toBe(false);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });
});
