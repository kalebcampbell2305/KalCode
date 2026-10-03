import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeRebindRequest,
  expireRebindRequest,
  getRebindRequest,
  getSelectedThread,
  REBIND_REQUEST_TTL_MS,
  requestRebind,
  resetAccountIntentForTests,
  setSelectedCodeContext,
  setSelectedThread,
  useSelectedCodeContext,
} from "./accountIntent.ts";

const THREAD = "0192f3c4-0000-7000-8000-000000000a01";
const ACCOUNT_B = "0192f3c4-0000-7000-8000-000000000302";

afterEach(() => {
  resetAccountIntentForTests();
  vi.useRealTimers();
});

describe("accountIntent", () => {
  it("observes the focused Code session without copying provider account state", () => {
    const view = renderHook(() => useSelectedCodeContext());
    expect(view.result.current).toBeNull();
    act(() => {
      setSelectedCodeContext({ workspaceId: "workspace-a", content: { kind: "agent", agentId: "agent-a" } });
    });
    expect(view.result.current).toEqual({
      workspaceId: "workspace-a",
      content: { kind: "agent", agentId: "agent-a" },
    });
    act(() => {
      setSelectedCodeContext({ workspaceId: "workspace-a", content: { kind: "terminal", terminalId: "shell-a" } });
    });
    expect(view.result.current?.content).toEqual({ kind: "terminal", terminalId: "shell-a" });
    act(() => {
      setSelectedCodeContext({ workspaceId: "workspace-b", content: null });
    });
    expect(view.result.current).toEqual({ workspaceId: "workspace-b", content: null });
    act(() => resetAccountIntentForTests());
    expect(view.result.current).toBeNull();
  });

  it("keeps identical Code selections stable and ignores an older canvas cleanup", () => {
    const render = vi.fn(() => useSelectedCodeContext());
    const view = renderHook(render);
    let cleanOlder = () => {};
    let cleanCurrent = () => {};
    act(() => {
      cleanOlder = setSelectedCodeContext({ workspaceId: "workspace-a", content: { kind: "agent", agentId: "a" } });
    });
    const first = view.result.current;
    const renderCount = render.mock.calls.length;
    act(() => {
      cleanCurrent = setSelectedCodeContext({ workspaceId: "workspace-a", content: { kind: "agent", agentId: "a" } });
    });
    expect(view.result.current).toBe(first);
    expect(render).toHaveBeenCalledTimes(renderCount);
    act(() => cleanOlder());
    expect(view.result.current).toBe(first);
    act(() => cleanCurrent());
    expect(view.result.current).toBeNull();
  });

  it("tracks the shown thread and ignores identical updates", () => {
    expect(getSelectedThread()).toBeNull();
    setSelectedThread({ threadId: THREAD, providerId: "gemini-cli", providerAccountId: null });
    const first = getSelectedThread();
    setSelectedThread({ threadId: THREAD, providerId: "gemini-cli", providerAccountId: null });
    expect(getSelectedThread()).toBe(first);
    setSelectedThread(null);
    expect(getSelectedThread()).toBeNull();
  });

  it("keeps a rebind request until that exact request is consumed", () => {
    const older = requestRebind(THREAD, ACCOUNT_B);
    const newer = requestRebind(THREAD, ACCOUNT_B);
    expect(newer.nonce).toBeGreaterThan(older.nonce);
    consumeRebindRequest(older.nonce);
    expect(getRebindRequest()).toEqual(newer);
    consumeRebindRequest(newer.nonce);
    expect(getRebindRequest()).toBeNull();
  });

  it("expires an unanswered request after 30 seconds (S4)", () => {
    vi.useFakeTimers();
    const request = requestRebind(THREAD, ACCOUNT_B);
    expect(request.expiresAt - Date.now()).toBe(REBIND_REQUEST_TTL_MS);
    vi.advanceTimersByTime(REBIND_REQUEST_TTL_MS - 1);
    expect(getRebindRequest()).toEqual(request);
    vi.advanceTimersByTime(1);
    expect(getRebindRequest()).toBeNull();
  });

  it("drops a pending request when the person leaves Threads", () => {
    requestRebind(THREAD, ACCOUNT_B);
    expireRebindRequest();
    expect(getRebindRequest()).toBeNull();
  });

  it("a newer request restarts the expiry clock", () => {
    vi.useFakeTimers();
    requestRebind(THREAD, ACCOUNT_B);
    vi.advanceTimersByTime(20_000);
    const newer = requestRebind(THREAD, ACCOUNT_B);
    vi.advanceTimersByTime(20_000);
    expect(getRebindRequest()).toEqual(newer);
    vi.advanceTimersByTime(10_000);
    expect(getRebindRequest()).toBeNull();
  });
});
