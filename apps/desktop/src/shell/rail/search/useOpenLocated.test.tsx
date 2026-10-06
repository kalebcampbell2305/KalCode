// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOpenLocated } from "./useOpenLocated.ts";

const mocks = vi.hoisted(() => ({
  client: { locatorOpen: vi.fn() },
  focus: vi.fn(),
  openInPane: vi.fn(),
  show: vi.fn(),
}));
vi.mock("../../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => ({ client: mocks.client }) }));
vi.mock("../../../runtime/uiIntents.tsx", () => ({ useUiIntents: () => ({ focus: mocks.focus }) }));
vi.mock("../../panes/useOpenInPane.ts", () => ({ useOpenInPane: () => mocks.openInPane }));
vi.mock("@kalcode/ui/components", () => ({ useToast: () => ({ show: mocks.show }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const target = (id: string) => ({ threadId: id, workspaceId: "workspace" });

describe("locator open lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.client = { locatorOpen: vi.fn().mockResolvedValue(target("current")) };
    mocks.focus.mockResolvedValue(undefined);
  });

  it("does not open a superseded selection that resolves last", async () => {
    const old = deferred<ReturnType<typeof target>>();
    mocks.client.locatorOpen.mockReturnValueOnce(old.promise);
    const { result } = renderHook(useOpenLocated);
    let first!: Promise<boolean>;
    act(() => {
      first = result.current("thread", "old", "rail");
    });
    await act(async () => {
      expect(await result.current("thread", "current", "rail")).toBe(true);
    });
    await act(async () => {
      old.resolve(target("old"));
      expect(await first).toBe(false);
    });
    expect(mocks.focus.mock.calls).toEqual([[{ kind: "thread", threadId: "current", workspaceId: "workspace" }]]);
  });

  it("does not report an obsolete lookup error", async () => {
    const old = deferred<ReturnType<typeof target>>();
    mocks.client.locatorOpen.mockReturnValueOnce(old.promise);
    const { result } = renderHook(useOpenLocated);
    let first!: Promise<boolean>;
    act(() => {
      first = result.current("thread", "old", "rail");
    });
    await act(async () => {
      await result.current("thread", "current", "rail");
    });
    await act(async () => {
      old.reject({ category: "validation", code: "not_found", message: "Obsolete failure", retryable: false });
      expect(await first).toBe(false);
    });
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it.each(["replacement", "unmount"])("ignores lookup resolution after %s", async (change) => {
    const old = deferred<ReturnType<typeof target>>();
    mocks.client.locatorOpen.mockReturnValueOnce(old.promise);
    const { result, rerender, unmount } = renderHook(useOpenLocated);
    let first!: Promise<boolean>;
    act(() => {
      first = result.current("thread", "old", "rail");
    });
    if (change === "replacement") {
      mocks.client = { locatorOpen: vi.fn() };
      rerender();
    } else unmount();
    await act(async () => {
      old.resolve(target("old"));
      expect(await first).toBe(false);
    });
    expect(mocks.focus).not.toHaveBeenCalled();
  });

  it("still reports a current lookup failure", async () => {
    mocks.client.locatorOpen.mockRejectedValueOnce({
      category: "validation",
      code: "not_found",
      message: "Current failure",
      retryable: false,
    });
    const { result } = renderHook(useOpenLocated);
    await act(async () => {
      expect(await result.current("thread", "current", "rail")).toBe(false);
    });
    expect(mocks.show).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't open that", description: "Current failure" }),
    );
  });

  it("does not revive a pending lookup when a previous runtime client returns", async () => {
    const old = deferred<ReturnType<typeof target>>();
    mocks.client.locatorOpen.mockReturnValueOnce(old.promise);
    const original = mocks.client;
    const { result, rerender } = renderHook(useOpenLocated);
    const first = result.current("thread", "old", "rail");
    mocks.client = { locatorOpen: vi.fn() };
    rerender();
    mocks.client = original;
    rerender();
    await act(async () => {
      old.resolve(target("old"));
      expect(await first).toBe(false);
    });
    expect(mocks.focus).not.toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it.each(["unmount", "round-trip"])("rejects retained callbacks after %s", async (change) => {
    const { result, rerender, unmount } = renderHook(useOpenLocated);
    const retained = result.current;
    const original = mocks.client;
    if (change === "unmount") unmount();
    else {
      mocks.client = { locatorOpen: vi.fn() };
      rerender();
      mocks.client = original;
      rerender();
    }
    expect(await retained("thread", "old", "rail")).toBe(false);
    expect(original.locatorOpen).not.toHaveBeenCalled();
    expect(mocks.focus).not.toHaveBeenCalled();
  });

  it("preserves silent cancellation from pane opening", async () => {
    mocks.client.locatorOpen.mockResolvedValue({ terminalId: "terminal", workspaceId: "workspace" });
    mocks.openInPane.mockResolvedValue({ handled: false, message: "" });
    const { result } = renderHook(useOpenLocated);
    expect(await result.current("terminal", "terminal", "rail")).toBe(false);
    expect(mocks.openInPane).toHaveBeenCalledWith(
      { kind: "terminal", terminalId: "terminal" },
      { workspaceId: "workspace" },
    );
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it("does not focus a lookup from discarded root StrictMode setup", async () => {
    const old = deferred<ReturnType<typeof target>>();
    mocks.client.locatorOpen.mockReturnValueOnce(old.promise);
    const calls: Promise<boolean>[] = [];
    renderHook(
      () => {
        const open = useOpenLocated();
        useEffect(() => {
          calls.push(open("thread", "current", "rail"));
        }, [open]);
      },
      { reactStrictMode: true },
    );
    expect(calls).toHaveLength(2);
    await act(async () => {
      await calls[1];
      old.resolve(target("discarded"));
      await calls[0];
    });
    expect(await calls[0]).toBe(false);
    expect(mocks.focus).toHaveBeenCalledExactlyOnceWith({
      kind: "thread",
      threadId: "current",
      workspaceId: "workspace",
    });
  });

  it("opens a located coding agent through the canonical agent focus, never as a chat thread", async () => {
    mocks.client.locatorOpen.mockResolvedValueOnce({ threadId: "agent-1", terminalId: "term-1", workspaceId: "w1" });
    const { result } = renderHook(useOpenLocated);
    await act(async () => {
      expect(await result.current("thread", "agent-1", "palette")).toBe(true);
    });
    expect(mocks.focus).toHaveBeenCalledExactlyOnceWith({ kind: "agent", agentId: "agent-1", workspaceId: "w1" });
  });
});
