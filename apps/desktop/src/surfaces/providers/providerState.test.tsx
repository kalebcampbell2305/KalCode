import type { HealthRollup, ProviderHealth, ProviderStatus } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectFake, providerCatalog } from "../../ipc/memoryProviders.ts";
import { useProviderHealth } from "./useProviderHealth.ts";
import { useProviders } from "./useProviders.ts";
import { useProvidersSummary } from "./useProvidersSummary.ts";

const runtime = vi.hoisted(() => ({ client: {} as ReturnType<typeof makeClient>, events: [] }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime, useEvents: () => runtime }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const detected = () => detectFake(providerCatalog(), "default", "2026-09-25T00:00:00Z").next;
function health(): ProviderHealth {
  return {
    providerId: "codex",
    displayName: "Codex",
    state: "healthy",
    detection: "installed",
    auth: "authenticated",
    accountLabel: null,
    version: "1.0",
    minimumVersion: null,
    models: [],
    processRunning: true,
    activeSessions: 1,
    latencyP50Ms: null,
    latencyP95Ms: null,
    latencySamples: 0,
    recentFailures: 0,
    lastFailure: null,
    capacity: "available",
    backoffUntil: null,
    trend: "stable",
    recoverability: "none",
    reasonCode: null,
    reason: null,
    checkedAt: null,
    observedAt: "2026-09-25T00:00:00Z",
  };
}
function rollup(): HealthRollup {
  return {
    providerId: "codex",
    hourStart: "2026-09-25T00:00:00Z",
    sessionsStarted: 1,
    failures: 0,
    backoffs: 0,
    latencyP50Ms: null,
    latencyP95Ms: null,
    samples: 0,
  };
}
function makeClient() {
  return {
    listProviders: vi.fn(async () => detected()),
    detectProviders: vi.fn(async () => detected()),
    listProviderHealth: vi.fn(async () => [health()]),
    providerHealthTrend: vi.fn(async (_id: string, _hours: number): Promise<HealthRollup[]> => [rollup()]),
  };
}
function wrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}
beforeEach(() => {
  runtime.client = makeClient();
  runtime.events = [];
});

describe("provider snapshot lifetimes", () => {
  it("does not let an older detection overwrite the latest result", async () => {
    const { result } = renderHook(useProviders, { wrapper });
    await waitFor(() => expect(result.current.statuses).not.toBeNull());
    const old = deferred<ProviderStatus[]>();
    runtime.client.detectProviders.mockReturnValueOnce(old.promise);
    let first!: Promise<void>;
    act(() => {
      first = result.current.detect();
    });
    runtime.client.detectProviders.mockResolvedValue([]);
    await act(() => result.current.detect());
    await act(async () => {
      old.resolve(detected());
      await first;
    });
    expect(result.current.statuses).toEqual([]);
  });

  it("does not show an old failure or clear a newer in-flight detection", async () => {
    const { result } = renderHook(useProviders, { wrapper });
    await waitFor(() => expect(result.current.statuses).not.toBeNull());
    const old = deferred<ProviderStatus[]>();
    const fresh = deferred<ProviderStatus[]>();
    runtime.client.detectProviders.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.detect();
      second = result.current.detect();
    });
    await act(async () => {
      old.reject(new Error("old detection"));
      await first;
    });
    expect(result.current.detectError).toBeNull();
    expect(result.current.detecting).toBe(true);
    await act(async () => {
      fresh.resolve([]);
      await second;
    });
    expect(result.current.detecting).toBe(false);
  });

  it("rejects stale cache results after an explicit detection", async () => {
    const cache = deferred<ProviderStatus[]>();
    runtime.client.listProviders.mockReturnValue(cache.promise);
    runtime.client.detectProviders.mockResolvedValue([]);
    const { result } = renderHook(useProviders, { wrapper });
    await act(() => result.current.detect());
    await act(async () => {
      cache.resolve(providerCatalog());
    });
    expect(result.current.statuses).toEqual([]);
    expect(runtime.client.detectProviders).toHaveBeenCalledTimes(1);
  });

  it("hides old status and rejects old detection callbacks after a runtime switch", async () => {
    const old = runtime.client;
    const pending = deferred<ProviderStatus[]>();
    old.detectProviders.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(useProviders, { wrapper });
    await waitFor(() => expect(result.current.statuses).not.toBeNull());
    const retained = result.current.detect;
    let detecting!: Promise<void>;
    act(() => {
      detecting = retained();
    });
    runtime.client = makeClient();
    runtime.client.listProviders.mockReturnValue(new Promise(() => {}));
    rerender();
    expect(result.current.statuses).toBeNull();
    expect(result.current.detecting).toBe(false);
    await act(async () => {
      pending.resolve(detected());
      await detecting;
      await retained();
    });
    expect(result.current.statuses).toBeNull();
    expect(old.detectProviders).toHaveBeenCalledTimes(1);
  });

  it("clears the previous client's dashboard summary while the replacement loads", async () => {
    const { result, rerender } = renderHook(useProvidersSummary, { wrapper });
    await waitFor(() => expect(result.current.summary?.installed).toBeGreaterThan(0));
    runtime.client = makeClient();
    runtime.client.listProviders.mockReturnValue(new Promise(() => {}));
    rerender();
    expect(result.current).toEqual({ summary: null, failed: false });
  });

  it("does not keep another runtime's health and trends while inactive", async () => {
    const { result, rerender } = renderHook(({ active }) => useProviderHealth(active), {
      initialProps: { active: true },
      wrapper,
    });
    await waitFor(() => expect(result.current.trends.codex).toHaveLength(1));
    runtime.client = makeClient();
    rerender({ active: false });
    expect(result.current.list).toBeNull();
    expect(result.current.trends).toEqual({});
    expect(result.current.error).toBeNull();
    expect(runtime.client.listProviderHealth).not.toHaveBeenCalled();
  });

  it("clears old trend values when a fresh health snapshot arrives", async () => {
    const { result } = renderHook(() => useProviderHealth(true), { wrapper });
    await waitFor(() => expect(result.current.trends.codex).toHaveLength(1));
    const trend = deferred<HealthRollup[]>();
    runtime.client.providerHealthTrend.mockReturnValueOnce(trend.promise);
    runtime.client.listProviderHealth.mockResolvedValue([{ ...health(), activeSessions: 5 }]);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.list?.[0]?.activeSessions).toBe(5));
    expect(result.current.trends).toEqual({});
    await act(async () => {
      trend.resolve([]);
    });
    expect(result.current.trends).toEqual({ codex: [] });
  });

  it("runs first detection once under StrictMode and reports a current detection failure", async () => {
    runtime.client.listProviders.mockResolvedValue(providerCatalog());
    runtime.client.detectProviders.mockRejectedValue({
      category: "provider",
      code: "detection_failed",
      message: "current detection failed",
      retryable: true,
    });
    const { result } = renderHook(useProviders, { wrapper });
    await waitFor(() => expect(result.current.detectError?.message).toBe("current detection failed"));
    expect(result.current.statuses).toHaveLength(3);
    expect(result.current.detecting).toBe(false);
    expect(runtime.client.detectProviders).toHaveBeenCalledTimes(1);
  });

  it("retries a cache failure without performing unnecessary detection", async () => {
    runtime.client.listProviders.mockRejectedValue(new Error("cache unavailable"));
    const { result } = renderHook(useProviders, { wrapper });
    await waitFor(() => expect(result.current.listError).not.toBeNull());
    runtime.client.listProviders.mockResolvedValue(detected());
    act(() => result.current.retryList());
    await waitFor(() => expect(result.current.statuses).toHaveLength(3));
    expect(result.current.listError).toBeNull();
    expect(runtime.client.detectProviders).not.toHaveBeenCalled();
  });

  it("does not publish old trend completions after the health tab becomes inactive", async () => {
    const old = deferred<HealthRollup[]>();
    runtime.client.providerHealthTrend.mockReturnValue(old.promise);
    const { result, rerender } = renderHook(({ active }) => useProviderHealth(active), {
      initialProps: { active: true },
      wrapper,
    });
    await waitFor(() => expect(result.current.list).toHaveLength(1));
    rerender({ active: false });
    await act(async () => {
      old.resolve([rollup()]);
    });
    expect(result.current.trends).toEqual({});
  });

  it("reports unavailable trends without losing current health or inventing history", async () => {
    runtime.client.providerHealthTrend.mockRejectedValue(new Error("no trend"));
    const { result } = renderHook(() => useProviderHealth(true), { wrapper });
    await waitFor(() => expect(result.current.trends.codex).toBeNull());
    expect(result.current.list).toEqual([health()]);
    expect(result.current.error).toBeNull();
  });

  it("does not let a replaced runtime's summary failure affect its replacement", async () => {
    const old = deferred<ProviderStatus[]>();
    runtime.client.listProviders.mockReturnValue(old.promise);
    const { result, rerender } = renderHook(useProvidersSummary, { wrapper });
    runtime.client = makeClient();
    rerender();
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    await act(async () => {
      old.reject(new Error("obsolete runtime"));
    });
    expect(result.current.failed).toBe(false);
  });

  it("does not resurrect a cached snapshot when returning to a previous runtime before refresh", async () => {
    const first = runtime.client;
    const { result, rerender } = renderHook(
      () => ({ summary: useProvidersSummary(), health: useProviderHealth(true) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.health.trends.codex).toHaveLength(1));
    runtime.client = makeClient();
    runtime.client.listProviders.mockReturnValue(new Promise(() => {}));
    runtime.client.listProviderHealth.mockReturnValue(new Promise(() => {}));
    rerender();
    first.listProviders.mockReturnValue(new Promise(() => {}));
    first.listProviderHealth.mockReturnValue(new Promise(() => {}));
    runtime.client = first;
    rerender();
    expect(result.current.summary.summary).toBeNull();
    expect(result.current.health.list).toBeNull();
  });
});
