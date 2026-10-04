import type { EventEnvelope, ProviderAccount, ProviderAccountUsage } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KalCodeClient } from "../../ipc/client.ts";
import { EventFeed } from "../../runtime/eventFeed.ts";
import { usageSummary, useAccountUsage } from "./accountUsage.ts";
import {
  nextUsageMap,
  toAccountUsageState,
  USAGE_AFTER_SESSION_DELAY_MS,
  USAGE_FOCUS_THROTTLE_MS,
  USAGE_REFRESH_MS,
  USAGE_STALE_AFTER_MS,
  useAccountUsageReader,
} from "./accountUsageReader.ts";
import { ProviderAccountSessionsProvider } from "./ProviderAccountSessions.tsx";

const runtime = vi.hoisted(() => ({ client: null as unknown as KalCodeClient, feed: null as EventFeed | null }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime }));

const NOW = Date.parse("2026-10-03T17:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function account(id: string, providerId: string): ProviderAccount {
  return {
    id,
    providerId,
    displayName: id,
    providerReportedIdentity: null,
    authenticationState: "authenticated",
    isDefault: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: null,
    lastCheckedAt: null,
    lastErrorCode: null,
    archivedAt: null,
  };
}

const CLAUDE = account("claude-a", "claude-code");
const CODEX = account("codex-b", "codex");
const GEMINI = account("gemini-c", "gemini-cli");

function claudeUsage(checkedAgoMs = 30_000): ProviderAccountUsage {
  return {
    accountId: CLAUDE.id,
    status: "available",
    plan: "Max 20x",
    windows: [
      { id: "weekly", label: "Weekly", remainingPercent: 42, resetsAt: iso(3 * 86_400_000) },
      { id: "five_hour", label: "5-hour", remainingPercent: 64, resetsAt: iso(134 * 60_000) },
    ],
    checkedAt: iso(-checkedAgoMs),
    reason: null,
  };
}

const CODEX_LOW: ProviderAccountUsage = {
  accountId: CODEX.id,
  status: "available",
  plan: "Pro",
  windows: [{ id: "weekly", label: "Weekly", remainingPercent: 8, resetsAt: iso(86_400_000) }],
  checkedAt: iso(-60_000),
  reason: null,
};

const GEMINI_NONE: ProviderAccountUsage = {
  accountId: GEMINI.id,
  status: "unavailable",
  plan: null,
  windows: [],
  checkedAt: null,
  reason: "This provider doesn't report plan usage",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function usageClient(read: () => Promise<ProviderAccountUsage[]>) {
  const providerAccountUsage = vi.fn(read);
  return { client: { providerAccountUsage } as unknown as KalCodeClient, providerAccountUsage };
}

describe("usage state mapping", () => {
  it.each([null, undefined, "0", Number.NaN, Number.POSITIVE_INFINITY, -1, 101])(
    "rejects invalid native percentages %s without hiding valid windows",
    (remainingPercent) => {
      const invalid = { ...CODEX_LOW.windows[0], remainingPercent } as ProviderAccountUsage["windows"][number];
      const bad = toAccountUsageState({ ...CODEX_LOW, windows: [invalid] }, NOW);
      expect(usageSummary(bad)).toEqual({ short: "Usage unavailable", low: false, tone: "muted" });
      const valid = toAccountUsageState(
        { ...CODEX_LOW, windows: [invalid, { ...invalid, id: "valid", remainingPercent: 0 }] },
        NOW,
      );
      expect(valid.windows).toHaveLength(1);
      expect(usageSummary(valid).short).toBe("0% left");
    },
  );

  it.each([null, "bad timestamp"])("requires a provider observation time: %s", (checkedAt) => {
    expect(usageSummary(toAccountUsageState({ ...CODEX_LOW, checkedAt }, NOW)).short).toBe("Usage unavailable");
  });

  it("does not erase a measured quota when reset timing is unavailable", () => {
    const native = { ...CODEX_LOW, windows: [{ ...CODEX_LOW.windows[0], resetsAt: null }] } as ProviderAccountUsage;
    expect(usageSummary(toAccountUsageState(native, NOW)).short).toBe("8% left");
  });

  it("an account omitted by a completed read loses its previous quota", () => {
    const first = nextUsageMap(new Map(), [CODEX], [CODEX_LOW], NOW);
    const next = nextUsageMap(first, [CODEX], [], NOW);
    expect(next.get(CODEX.id)).toMatchObject({ status: "unavailable", plan: "Pro", windows: [] });
  });
  it("labels real numbers fresh or stale by the provider read's age", () => {
    expect(toAccountUsageState(claudeUsage(), NOW)).toMatchObject({ status: "fresh", plan: "Max 20x" });
    expect(toAccountUsageState(claudeUsage(USAGE_STALE_AFTER_MS + 1), NOW).status).toBe("stale");
    expect(usageSummary(toAccountUsageState(CODEX_LOW, NOW))).toEqual({ short: "8% left", low: true, tone: "low" });
    expect(toAccountUsageState(GEMINI_NONE, NOW)).toMatchObject({
      status: "unavailable",
      windows: [],
      reason: "This provider doesn't report plan usage",
    });
  });

  it("drops windows whose reset passed instead of showing an outdated number", () => {
    const later = NOW + 135 * 60_000;
    expect(toAccountUsageState(claudeUsage(), later).windows.map((window) => window.id)).toEqual(["weekly"]);
    expect(toAccountUsageState(claudeUsage(), NOW + 4 * 86_400_000)).toMatchObject({
      status: "not_checked",
      windows: [],
      reason: "Usage reset since the last agent run",
    });
  });

  it("keeps the map and entry identity when nothing changed", () => {
    const first = nextUsageMap(new Map(), [CLAUDE, CODEX], [claudeUsage(), CODEX_LOW], NOW);
    const same = nextUsageMap(first, [CLAUDE, CODEX], [claudeUsage(), CODEX_LOW], NOW + 1_000);
    expect(same).toBe(first);
    const moved = nextUsageMap(first, [CLAUDE, CODEX], [claudeUsage(), { ...CODEX_LOW, checkedAt: iso(0) }], NOW);
    expect(moved).not.toBe(first);
    expect(moved.get(CLAUDE.id)).toBe(first.get(CLAUDE.id));
    // A removed account disappears; a checking pass keeps known numbers in place.
    const removed = nextUsageMap(first, [CLAUDE], "checking", NOW);
    expect([...removed.keys()]).toEqual([CLAUDE.id]);
    expect(removed.get(CLAUDE.id)).toBe(first.get(CLAUDE.id));
  });
});

describe("useAccountUsageReader", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = () => act(async () => vi.advanceTimersByTimeAsync(0));

  it("a replacement runtime never inherits quota from the previous native client", async () => {
    const oldRead = deferred<ProviderAccountUsage[]>();
    const newRead = deferred<ProviderAccountUsage[]>();
    const oldClient = usageClient(() => oldRead.promise).client;
    const newClient = usageClient(() => newRead.promise).client;
    const view = renderHook(({ client }) => useAccountUsageReader(client, [CODEX], null), {
      initialProps: { client: oldClient },
    });
    await flush();
    view.rerender({ client: newClient });
    oldRead.resolve([CODEX_LOW]);
    await flush();
    expect(view.result.current.get(CODEX.id)).toMatchObject({ status: "checking", windows: [] });
    newRead.resolve([{ ...CODEX_LOW, status: "unavailable", windows: [], checkedAt: null }]);
    await flush();
    expect(view.result.current.get(CODEX.id)?.status).toBe("unavailable");
  });

  it("invalidates cached quota during a same-identity reconnect revision", async () => {
    const { client, providerAccountUsage } = usageClient(async () => [CODEX_LOW]);
    const revisions = new Map([[CODEX.id, 0]]);
    const pending = deferred<ProviderAccountUsage[]>();
    const view = renderHook(
      ({ render }) => {
        void render;
        return useAccountUsageReader(client, [CODEX], null, 0, revisions);
      },
      { initialProps: { render: 0 } },
    );
    await flush();
    expect(view.result.current.get(CODEX.id)?.status).toBe("fresh");
    providerAccountUsage.mockImplementationOnce(() => pending.promise);
    revisions.set(CODEX.id, 1);
    view.rerender({ render: 1 });
    expect(view.result.current.get(CODEX.id)).toMatchObject({ status: "checking", windows: [] });
    pending.resolve([{ ...CODEX_LOW, status: "unavailable", windows: [], checkedAt: null, plan: null }]);
    await flush();
    expect(view.result.current.get(CODEX.id)).toMatchObject({ status: "unavailable", windows: [], plan: null });
  });

  it("never exposes a prior identity's cache or in-flight result after reconnect", async () => {
    const oldIdentity = { ...CODEX, providerReportedIdentity: "old@example.test" };
    const newIdentity = { ...CODEX, providerReportedIdentity: "new@example.test" };
    const oldRead = deferred<ProviderAccountUsage[]>();
    const newRead = deferred<ProviderAccountUsage[]>();
    const { client, providerAccountUsage } = usageClient(async () => [CODEX_LOW]);
    const view = renderHook(({ accounts, request }) => useAccountUsageReader(client, accounts, null, request), {
      initialProps: { accounts: [oldIdentity], request: 0 },
    });
    await flush();
    expect(view.result.current.get(CODEX.id)?.windows[0]?.remainingPercent).toBe(8);
    providerAccountUsage.mockImplementationOnce(() => oldRead.promise).mockImplementationOnce(() => newRead.promise);
    view.rerender({ accounts: [oldIdentity], request: 1 });
    await flush();
    view.rerender({ accounts: [newIdentity], request: 1 });
    expect(view.result.current.get(CODEX.id)).toBeUndefined();
    oldRead.resolve([CODEX_LOW]);
    await flush();
    expect(view.result.current.get(CODEX.id)).toMatchObject({ status: "checking", windows: [] });
    newRead.resolve([
      {
        ...CODEX_LOW,
        plan: null,
        windows: [{ ...CODEX_LOW.windows[0], remainingPercent: 62 }],
      } as ProviderAccountUsage,
    ]);
    await flush();
    expect(view.result.current.get(CODEX.id)).toMatchObject({ status: "fresh", plan: null });
    expect(view.result.current.get(CODEX.id)?.windows[0]?.remainingPercent).toBe(62);
  });

  it("reads after accounts restore without blocking, showing checking until the read lands", async () => {
    const pending = deferred<ProviderAccountUsage[]>();
    const { client, providerAccountUsage } = usageClient(() => pending.promise);
    const view = renderHook(({ accounts }) => useAccountUsageReader(client, accounts, null), {
      initialProps: { accounts: null as ProviderAccount[] | null },
    });
    expect(view.result.current.size).toBe(0);
    expect(providerAccountUsage).not.toHaveBeenCalled();

    view.rerender({ accounts: [CLAUDE, CODEX, GEMINI] });
    await flush();
    expect(providerAccountUsage).toHaveBeenCalledTimes(1);
    expect(view.result.current.get(CLAUDE.id)?.status).toBe("checking");

    pending.resolve([claudeUsage(), CODEX_LOW, GEMINI_NONE]);
    await flush();
    expect(view.result.current.get(CLAUDE.id)).toMatchObject({ status: "fresh", plan: "Max 20x" });
    expect(usageSummary(view.result.current.get(CLAUDE.id) ?? toAccountUsageState(GEMINI_NONE, NOW)).short).toBe(
      "42% left",
    );
    expect(view.result.current.get(CODEX.id)?.windows[0]?.remainingPercent).toBe(8);
    expect(view.result.current.get(GEMINI.id)?.status).toBe("unavailable");
  });

  it("refreshes on an interval only while visible, and throttles focus refreshes", async () => {
    const { client, providerAccountUsage } = usageClient(async () => [claudeUsage()]);
    let visibility: DocumentVisibilityState = "visible";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    try {
      const view = renderHook(() => useAccountUsageReader(client, [CLAUDE], null));
      await flush();
      expect(providerAccountUsage).toHaveBeenCalledTimes(1);
      const first = view.result.current;

      await act(async () => vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS));
      expect(providerAccountUsage).toHaveBeenCalledTimes(2);
      // Same provider numbers: the map identity is unchanged, so nothing re-renders downstream.
      expect(view.result.current).toBe(first);

      visibility = "hidden";
      await act(async () => vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS * 3));
      expect(providerAccountUsage).toHaveBeenCalledTimes(2);

      visibility = "visible";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await flush();
      expect(providerAccountUsage).toHaveBeenCalledTimes(3);
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await flush();
      expect(providerAccountUsage).toHaveBeenCalledTimes(3);
      await act(async () => vi.advanceTimersByTimeAsync(USAGE_FOCUS_THROTTLE_MS));
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await flush();
      expect(providerAccountUsage).toHaveBeenCalledTimes(4);
    } finally {
      spy.mockRestore();
    }
  });

  it("refreshes on picker demand while preserving cached usage during the asynchronous read", async () => {
    let complete: ((read: ProviderAccountUsage[]) => void) | undefined;
    const { client, providerAccountUsage } = usageClient(async () => [claudeUsage()]);
    const view = renderHook(({ request }) => useAccountUsageReader(client, [CLAUDE], null, request), {
      initialProps: { request: 0 },
    });
    await flush();
    providerAccountUsage.mockImplementationOnce(
      () =>
        new Promise<ProviderAccountUsage[]>((resolve) => {
          complete = resolve;
        }),
    );
    view.rerender({ request: 1 });
    await flush();
    expect(providerAccountUsage).toHaveBeenCalledTimes(2);
    expect(view.result.current.get(CLAUDE.id)?.windows[0]?.remainingPercent).toBe(42);
    complete?.([
      {
        ...claudeUsage(),
        windows: [{ id: "weekly", label: "Weekly", remainingPercent: 33, resetsAt: iso(86_400_000) }],
      },
    ]);
    await flush();
    expect(view.result.current.get(CLAUDE.id)?.windows[0]?.remainingPercent).toBe(33);
  });

  it("re-reads shortly after an agent session ends", async () => {
    const feed = new EventFeed();
    const { client, providerAccountUsage } = usageClient(async () => [claudeUsage()]);
    renderHook(() => useAccountUsageReader(client, [CLAUDE], feed));
    await flush();
    expect(providerAccountUsage).toHaveBeenCalledTimes(1);

    act(() => {
      feed.merge([{ seq: 10, type: "thread.status_changed", payload: {} } as unknown as EventEnvelope]);
    });
    await act(async () => vi.advanceTimersByTimeAsync(USAGE_AFTER_SESSION_DELAY_MS));
    expect(providerAccountUsage).toHaveBeenCalledTimes(1);

    act(() => {
      feed.merge([
        { seq: 11, type: "agent.turn_completed", payload: {} } as unknown as EventEnvelope,
        { seq: 12, type: "thread.completed", payload: {} } as unknown as EventEnvelope,
      ]);
    });
    await act(async () => vi.advanceTimersByTimeAsync(USAGE_AFTER_SESSION_DELAY_MS - 1));
    expect(providerAccountUsage).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(providerAccountUsage).toHaveBeenCalledTimes(2);
  });

  it("failed reads make usage unavailable while preserving independent plan metadata", async () => {
    let result: () => Promise<ProviderAccountUsage[]> = async () => {
      throw new Error("Runtime starting");
    };
    const { client, providerAccountUsage } = usageClient(() => result());
    const view = renderHook(() => useAccountUsageReader(client, [CLAUDE], null));
    await flush();
    expect(view.result.current.get(CLAUDE.id)).toMatchObject({
      status: "unavailable",
      windows: [],
      reason: "Usage couldn't be read",
    });

    result = async () => [claudeUsage()];
    await act(async () => vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS));
    expect(view.result.current.get(CLAUDE.id)?.status).toBe("fresh");

    result = async () => {
      throw new Error("transient");
    };
    vi.setSystemTime(NOW + USAGE_STALE_AFTER_MS + 60_000);
    await act(async () => vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS));
    expect(providerAccountUsage).toHaveBeenCalledTimes(3);
    expect(view.result.current.get(CLAUDE.id)).toMatchObject({
      status: "unavailable",
      plan: "Max 20x",
      windows: [],
      checkedAt: null,
    });
  });

  it("coalesces triggers that arrive during a read into one follow-up read", async () => {
    const reads: ReturnType<typeof deferred<ProviderAccountUsage[]>>[] = [];
    const { client, providerAccountUsage } = usageClient(() => {
      const next = deferred<ProviderAccountUsage[]>();
      reads.push(next);
      return next.promise;
    });
    const view = renderHook(({ accounts }) => useAccountUsageReader(client, accounts, null), {
      initialProps: { accounts: [CLAUDE] },
    });
    await flush();
    view.rerender({ accounts: [CLAUDE, CODEX] });
    view.rerender({ accounts: [CLAUDE, CODEX, GEMINI] });
    await flush();
    expect(providerAccountUsage).toHaveBeenCalledTimes(1);
    reads[0]?.resolve([claudeUsage()]);
    await flush();
    expect(providerAccountUsage).toHaveBeenCalledTimes(2);
    reads[1]?.resolve([claudeUsage(), CODEX_LOW, GEMINI_NONE]);
    await flush();
    expect([...view.result.current.keys()]).toEqual([CLAUDE.id, CODEX.id, GEMINI.id]);
    expect(view.result.current.get(CODEX.id)?.status).toBe("fresh");
  });
});

describe("ProviderAccountSessions usage slot", () => {
  it("publishes the background read through useAccountUsage", async () => {
    runtime.feed = new EventFeed();
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [CLAUDE]),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn(),
      refreshGeminiAccount: vi.fn(),
      providerAccountUsage: vi.fn(async () => [claudeUsage()]),
    } as unknown as KalCodeClient;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ProviderAccountSessionsProvider>{children}</ProviderAccountSessionsProvider>
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const view = renderHook(() => useAccountUsage(CLAUDE.id), { wrapper });
      await waitFor(() => expect(view.result.current.status).toBe("fresh"));
      expect(view.result.current.windows.map((window) => window.label)).toEqual(["Weekly", "5-hour"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
