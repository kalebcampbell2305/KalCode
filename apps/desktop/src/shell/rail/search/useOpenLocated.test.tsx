// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
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
});
