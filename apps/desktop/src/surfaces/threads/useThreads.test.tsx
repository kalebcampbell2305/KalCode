// @vitest-environment jsdom
import type { AgentEvent, EventEnvelope } from "@kalcode/protocol";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadDetail, useThreadList } from "./useThreads.ts";

const runtime = vi.hoisted(() => ({ client: null as unknown, events: [] as EventEnvelope[] }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({ client: runtime.client }),
  useEvents: () => ({ events: runtime.events }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function client() {
  return {
    listThreads: vi.fn().mockResolvedValue([]),
    getThread: vi.fn().mockResolvedValue({ id: "thread-a" }),
    threadMessages: vi.fn().mockResolvedValue([]),
    threadToolCalls: vi.fn().mockResolvedValue([]),
    streamThread: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
  };
}

function event(seq: number, threadId = "thread-a"): EventEnvelope {
  return {
    id: `event-${seq}`,
    seq,
    version: 1,
    occurredAt: "2026-09-25T00:00:00Z",
    source: "core",
    correlation: {
      workspaceId: null,
      threadId,
      missionId: null,
      providerId: null,
      requestId: null,
      agentId: null,
      taskId: null,
      automationId: null,
      causationId: null,
    },
    type: "thread.renamed",
    payload: { threadId, name: "Updated" },
  };
}

async function flush() {
  await act(async () => {});
}

describe("thread runtime lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runtime.events = [];
    runtime.client = client();
  });
  afterEach(() => vi.useRealTimers());

  it("refreshes new-runtime thread events even when their sequence restarted", async () => {
    runtime.events = [event(100)];
    const { rerender } = renderHook(() => useThreadList(false));
    await flush();
    const replacement = client();
    runtime.client = replacement;
    runtime.events = [event(1)];
    rerender();
    await flush();
    expect(replacement.listThreads).toHaveBeenCalledTimes(1);
    runtime.events = [event(2), event(1)];
    rerender();
    await act(async () => vi.advanceTimersByTimeAsync(80));
    expect(replacement.listThreads).toHaveBeenCalledTimes(2);
  });

  it("cancels an old runtime's pending event refresh", async () => {
    const { rerender } = renderHook(() => useThreadList(false));
    await flush();
    runtime.events = [event(1)];
    rerender();
    const replacement = client();
    runtime.client = replacement;
    runtime.events = [];
    rerender();
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(80));
    expect(replacement.listThreads).toHaveBeenCalledTimes(1);
  });

  it("ignores deltas from an obsolete subscription whose registration is still pending", async () => {
    const oldClient = client();
    const registration = deferred<() => Promise<void>>();
    oldClient.streamThread.mockReturnValue(registration.promise);
    runtime.client = oldClient;
    const { result, rerender } = renderHook(() => useThreadDetail("thread-a"));
    await flush();
    const oldEvent = oldClient.streamThread.mock.calls[0]?.[1] as (event: AgentEvent) => void;
    runtime.client = client();
    rerender();
    await flush();
    act(() => oldEvent({ kind: "message_delta", messageId: "old-message", text: "Obsolete text" }));
    expect(result.current.live).toEqual([]);
    const stop = vi.fn().mockResolvedValue(undefined);
    await act(async () => registration.resolve(stop));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("ignores obsolete completion events with the same message id", async () => {
    const oldClient = client();
    runtime.client = oldClient;
    const { result, rerender } = renderHook(() => useThreadDetail("thread-a"));
    await flush();
    const oldEvent = oldClient.streamThread.mock.calls[0]?.[1] as (event: AgentEvent) => void;
    const replacement = client();
    runtime.client = replacement;
    rerender();
    await flush();
    const currentEvent = replacement.streamThread.mock.calls[0]?.[1] as (event: AgentEvent) => void;
    act(() => currentEvent({ kind: "message_delta", messageId: "message", text: "Current" }));
    act(() => oldEvent({ kind: "message_completed", messageId: "message", text: "Obsolete" }));
    expect(result.current.live).toEqual([{ messageId: "message", text: "Current", done: false }]);
    act(() => currentEvent({ kind: "message_completed", messageId: "message", text: "Current complete" }));
    expect(result.current.live).toEqual([{ messageId: "message", text: "Current complete", done: true }]);
  });

  it("still coalesces same-runtime events and filters other threads", async () => {
    const activeClient = client();
    runtime.client = activeClient;
    const { rerender } = renderHook(() => useThreadDetail("thread-a"));
    await flush();
    runtime.events = [event(1, "other")];
    rerender();
    await act(async () => vi.advanceTimersByTimeAsync(80));
    expect(activeClient.getThread).toHaveBeenCalledTimes(1);
    runtime.events = [event(2)];
    rerender();
    runtime.events = [event(3), event(2)];
    rerender();
    await act(async () => vi.advanceTimersByTimeAsync(80));
    expect(activeClient.getThread).toHaveBeenCalledTimes(2);
  });
});

describe("thread list contents", () => {
  beforeEach(() => {
    runtime.events = [];
    runtime.client = client();
  });

  it("never lists coding agents (provider panes) as threads", async () => {
    const summaries = [
      { id: "chat", runtimeKind: null, terminalId: null },
      { id: "pane", runtimeKind: "interactive_pty", terminalId: null },
      { id: "attached", runtimeKind: null, terminalId: "term-1" },
    ];
    (runtime.client as ReturnType<typeof client>).listThreads.mockResolvedValue(summaries);
    const { result } = renderHook(() => useThreadList(true));
    await flush();
    expect(result.current.entries.map((entry) => entry.thread.id)).toEqual(["chat"]);
  });
});
