// @vitest-environment jsdom
import type { Chain, ChainStep, ChainsSnapshot, OperationRecord } from "@kalcode/protocol";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAINS_POLL_MS, ChainsProvider, useChains, useOptionalChains } from "./useChains.tsx";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  pause: vi.fn(),
  client: null as unknown,
}));
vi.mock("../RuntimeProvider.tsx", () => {
  mocks.client = { chains: { snapshot: mocks.snapshot, pause: mocks.pause } };
  return { useRuntime: () => ({ client: mocks.client }) };
});

function step(patch: Partial<ChainStep> = {}): ChainStep {
  return {
    key: "review",
    name: "Review",
    intent: "review",
    instructions: null,
    dependsOn: [],
    position: 1,
    operationId: "op-1",
    attempt: 1,
    phase: "working",
    waitingReason: null,
    report: null,
    ...patch,
  };
}

function chain(phase: Chain["phase"], steps: ChainStep[] = [step()]): Chain {
  return {
    id: "c1",
    name: "Billing fix",
    goal: "Fix billing",
    acceptance: [],
    workspaceId: "w1",
    worktree: "shared",
    branch: null,
    createdAt: "2026-10-05T12:00:00Z",
    paused: false,
    cancelled: false,
    supersededReason: null,
    phase,
    nextAction: null,
    steps,
  };
}

function operation(): OperationRecord {
  return { id: "op-1", threadId: "thread-1", spec: { name: "Review" } } as OperationRecord;
}

const snapshotOf = (c: Chain): ChainsSnapshot => ({ chains: [c], operations: [operation()] });
const wrapper = ({ children }: { children: ReactNode }) => <ChainsProvider>{children}</ChainsProvider>;
const flush = () => act(async () => {});

describe("ChainsProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.snapshot.mockReset();
    mocks.pause.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is null outside the provider, and useChains throws there", () => {
    expect(renderHook(() => useOptionalChains()).result.current).toBeNull();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useChains())).toThrow();
    quiet.mockRestore();
  });

  it("loads once, then finds a step by operation id or thread id", async () => {
    mocks.snapshot.mockResolvedValue(snapshotOf(chain("settled" as never)));
    const { result } = renderHook(() => useChains(), { wrapper });
    expect(result.current.loading).toBe(true);
    await flush();
    expect(result.current.loading).toBe(false);
    expect(result.current.chains).toHaveLength(1);
    expect(result.current.chainForOperation("op-1")?.step.key).toBe("review");
    expect(result.current.chainForOperation("thread-1")?.chain.id).toBe("c1");
    expect(result.current.chainForOperation("nope")).toBeNull();
  });

  it("polls every 2 s while a chain moves and stops once it is settled", async () => {
    mocks.snapshot.mockResolvedValue(snapshotOf(chain("running")));
    renderHook(() => useChains(), { wrapper });
    await flush();
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(CHAINS_POLL_MS));
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);

    mocks.snapshot.mockResolvedValue(snapshotOf(chain("ready_to_merge", [step({ phase: "passed" })])));
    await act(() => vi.advanceTimersByTimeAsync(CHAINS_POLL_MS));
    expect(mocks.snapshot).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(CHAINS_POLL_MS * 5));
    expect(mocks.snapshot).toHaveBeenCalledTimes(3);
  });

  it("does not poll when nothing is moving", async () => {
    mocks.snapshot.mockResolvedValue({ chains: [], operations: [] });
    renderHook(() => useChains(), { wrapper });
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(CHAINS_POLL_MS * 4));
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps every reference when an identical answer arrives", async () => {
    mocks.snapshot.mockImplementation(async () => structuredClone(snapshotOf(chain("running"))));
    const { result } = renderHook(() => useChains(), { wrapper });
    await flush();
    const before = result.current;
    await act(() => vi.advanceTimersByTimeAsync(CHAINS_POLL_MS));
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(before);
    expect(result.current.chains).toBe(before.chains);
    expect(result.current.operationsById).toBe(before.operationsById);
  });

  it("keeps the last good snapshot and exposes the error when a read fails", async () => {
    mocks.snapshot.mockResolvedValueOnce(snapshotOf(chain("running")));
    const { result } = renderHook(() => useChains(), { wrapper });
    await flush();
    mocks.snapshot.mockRejectedValue({
      category: "internal",
      code: "boom",
      message: "Chains are unavailable.",
      retryable: true,
    });
    await act(() => vi.advanceTimersByTimeAsync(CHAINS_POLL_MS));
    expect(result.current.chains).toHaveLength(1);
    expect(result.current.error?.message).toBe("Chains are unavailable.");
    mocks.snapshot.mockResolvedValue(snapshotOf(chain("running")));
    await act(() => vi.advanceTimersByTimeAsync(CHAINS_POLL_MS));
    expect(result.current.error).toBeNull();
  });

  it("dedupes reads in flight and refreshes after an action", async () => {
    let release: (value: ChainsSnapshot) => void = () => undefined;
    mocks.snapshot.mockImplementationOnce(() => new Promise<ChainsSnapshot>((resolve) => (release = resolve)));
    const { result } = renderHook(() => useChains(), { wrapper });
    // The initial read is still in flight: a focus event does not start another.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    mocks.snapshot.mockResolvedValue(snapshotOf(chain("paused")));
    await act(async () => release(snapshotOf(chain("running"))));
    await flush();

    mocks.pause.mockResolvedValue(chain("paused"));
    const calls = mocks.snapshot.mock.calls.length;
    await act(async () => {
      await result.current.pause("c1");
    });
    expect(mocks.pause).toHaveBeenCalledWith("c1");
    expect(mocks.snapshot.mock.calls.length).toBe(calls + 1);
    expect(result.current.chains[0]?.phase).toBe("paused");
  });
});
