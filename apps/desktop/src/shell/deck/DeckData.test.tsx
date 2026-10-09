// @vitest-environment jsdom
import type { OperationsSnapshot } from "@kalcode/protocol";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeckDataProvider, useDeckData } from "./DeckData.tsx";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] = () => undefined;
  let reject: Deferred<T>["reject"] = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const snapshot = (marker: string) => ({ marker, observedAt: marker }) as unknown as OperationsSnapshot;

const mocks = vi.hoisted(() => ({
  client: null as unknown as {
    transport: { invoke: ReturnType<typeof vi.fn> };
    listProviderHealth: ReturnType<typeof vi.fn>;
    gitStatus: ReturnType<typeof vi.fn>;
  },
  events: [] as { type: string; seq: number }[],
}));

vi.mock("../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({ client: mocks.client }),
  useEvents: () => ({ events: mocks.events }),
}));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({ active: { id: "workspace-a" } }),
}));
vi.mock("../../runtime/useThrottledValue.ts", () => ({ useThrottledValue: <T,>(value: T) => value }));

function makeClient(invoke: ReturnType<typeof vi.fn>) {
  return {
    transport: { invoke },
    listProviderHealth: vi.fn().mockResolvedValue([]),
    gitStatus: vi.fn().mockResolvedValue({ repository: false, summary: null }),
  };
}

const wrapper = ({ children }: { children: ReactNode }) => <DeckDataProvider>{children}</DeckDataProvider>;
const flush = () => act(async () => {});

describe("DeckData polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.events = [];
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("coalesces timer, focus, and event refreshes while a read is in flight", async () => {
    const first = deferred<OperationsSnapshot>();
    const second = deferred<OperationsSnapshot>();
    const invoke = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    mocks.client = makeClient(invoke);

    const { result, rerender } = renderHook(() => useDeckData(), { wrapper });
    expect(invoke).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(40_000);
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    mocks.events = [{ type: "operation.updated", seq: 1 }];
    rerender();
    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve(snapshot("first")));
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current.operations.data).toEqual(snapshot("first"));

    await act(async () => second.resolve(snapshot("second")));
  });

  it("runs one queued recovery read after a failed read settles", async () => {
    const first = deferred<OperationsSnapshot>();
    const second = deferred<OperationsSnapshot>();
    const invoke = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    mocks.client = makeClient(invoke);

    const { result } = renderHook(() => useDeckData(), { wrapper });
    act(() => window.dispatchEvent(new Event("focus")));
    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => first.reject(new Error("temporary failure")));
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current.operations.failed).toBe(true);

    await act(async () => second.resolve(snapshot("recovered")));
    await flush();
    expect(result.current.operations).toEqual({ data: snapshot("recovered"), failed: false });
  });

  it("drops a superseded client result and stops scheduling reads after unmount", async () => {
    const oldRead = deferred<OperationsSnapshot>();
    const newRead = deferred<OperationsSnapshot>();
    const abandonedRead = deferred<OperationsSnapshot>();
    const oldInvoke = vi.fn(() => oldRead.promise);
    const newInvoke = vi
      .fn()
      .mockImplementationOnce(() => newRead.promise)
      .mockImplementationOnce(() => abandonedRead.promise);
    mocks.client = makeClient(oldInvoke);

    const { result, rerender, unmount } = renderHook(() => useDeckData(), { wrapper });
    mocks.client = makeClient(newInvoke);
    rerender();
    expect(oldInvoke).toHaveBeenCalledTimes(1);
    expect(newInvoke).toHaveBeenCalledTimes(1);

    await act(async () => newRead.resolve(snapshot("new client")));
    await flush();
    expect(result.current.operations.data).toEqual(snapshot("new client"));

    await act(async () => oldRead.resolve(snapshot("old client")));
    await flush();
    expect(result.current.operations.data).toEqual(snapshot("new client"));

    act(() => window.dispatchEvent(new Event("focus")));
    expect(newInvoke).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => abandonedRead.resolve(snapshot("after unmount")));
    expect(result.current.operations.data).toEqual(snapshot("new client"));
    act(() => {
      vi.advanceTimersByTime(60_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(newInvoke).toHaveBeenCalledTimes(2);
  });
});
