import type { OperationsSnapshot } from "@kalcode/protocol";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationsApi } from "../../ipc/operations.ts";
import { useOperations } from "./useOperations.ts";

const snapshot = (revision: number): OperationsSnapshot => ({
  revision,
  paused: true,
  items: [],
  services: [],
  environments: [],
  activity: [],
  observedAt: `2026-09-30T12:00:0${revision}Z`,
  warnings: [],
});

function api(read: () => Promise<OperationsSnapshot>): OperationsApi {
  return {
    snapshot: read,
    detail: vi.fn(),
    history: vi.fn(),
    enqueue: vi.fn(),
    update: vi.fn(),
    reorder: vi.fn(),
    pause: vi.fn(),
    hold: vi.fn(),
    cancel: vi.fn(),
    runNow: vi.fn(),
    serviceAction: vi.fn(),
    openUrl: vi.fn(),
  } as OperationsApi;
}

describe("useOperations", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps one snapshot request outstanding across timer and focus refreshes", async () => {
    let resolve!: (value: OperationsSnapshot) => void;
    const read = vi.fn(
      () =>
        new Promise<OperationsSnapshot>((done) => {
          resolve = done;
        }),
    );
    const client = api(read);
    renderHook(() => useOperations(client));
    expect(read).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(9_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => resolve(snapshot(1)));
    act(() => vi.advanceTimersByTime(3_000));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("pauses polling while hidden and resumes with a fresh observation", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const read = vi.fn(async () => snapshot(2));
    const client = api(read);
    const { result } = renderHook(() => useOperations(client));
    expect(read).not.toHaveBeenCalled();

    await act(async () => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(result.current.snapshot?.revision).toBe(2);
    expect(read).toHaveBeenCalledTimes(1);
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
  });

  it("does no work while its projection is disabled and refreshes when enabled", async () => {
    const read = vi.fn(async () => snapshot(4));
    const client = api(read);
    const { result, rerender } = renderHook(({ enabled }) => useOperations(client, enabled), {
      initialProps: { enabled: false },
    });

    act(() => {
      vi.advanceTimersByTime(9_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(read).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();

    await act(async () => {
      rerender({ enabled: true });
      await Promise.resolve();
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot?.revision).toBe(4);

    rerender({ enabled: false });
    act(() => vi.advanceTimersByTime(6_000));
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot?.revision).toBe(4);
  });

  it("fences a slower snapshot from a replaced client lifetime", async () => {
    let resolveOld!: (value: OperationsSnapshot) => void;
    const oldApi = api(
      () =>
        new Promise<OperationsSnapshot>((done) => {
          resolveOld = done;
        }),
    );
    const nextApi = api(async () => snapshot(3));
    const { result, rerender } = renderHook(({ client }) => useOperations(client), {
      initialProps: { client: oldApi },
    });
    await act(async () => {
      rerender({ client: nextApi });
      await Promise.resolve();
    });
    expect(result.current.snapshot?.revision).toBe(3);
    await act(async () => resolveOld(snapshot(1)));
    expect(result.current.snapshot?.revision).toBe(3);
  });

  it("never shows a background poll as refreshing; a manual refresh does", async () => {
    let resolve!: (value: OperationsSnapshot) => void;
    const read = vi.fn(
      () =>
        new Promise<OperationsSnapshot>((done) => {
          resolve = done;
        }),
    );
    const client = api(read);
    const { result } = renderHook(() => useOperations(client));
    expect(result.current.refreshing).toBe(false);
    await act(async () => resolve(snapshot(1)));
    act(() => vi.advanceTimersByTime(3_000));
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.refreshing).toBe(false);

    // A manual refresh joining the poll in flight shows until that answer lands.
    act(() => void result.current.refresh());
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.refreshing).toBe(true);
    await act(async () => resolve(snapshot(2)));
    expect(result.current.refreshing).toBe(false);
    expect(result.current.snapshot?.revision).toBe(2);
  });

  it("keeps an unchanged snapshot while the observation time moves on", async () => {
    let observedAt = "2026-09-30T12:00:01Z";
    const read = vi.fn(async () => ({ ...snapshot(1), observedAt }));
    const client = api(read);
    const { result } = renderHook(() => useOperations(client));
    await act(async () => Promise.resolve());
    const first = result.current.snapshot;
    expect(result.current.observedAt).toBe("2026-09-30T12:00:01Z");

    observedAt = "2026-09-30T12:00:04Z";
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(result.current.snapshot).toBe(first);
    expect(result.current.observedAt).toBe("2026-09-30T12:00:04Z");

    read.mockResolvedValue({ ...snapshot(1), paused: false, observedAt: "2026-09-30T12:00:07Z" });
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(result.current.snapshot).not.toBe(first);
    expect(result.current.snapshot?.paused).toBe(false);
  });
});
