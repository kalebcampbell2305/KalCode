import { beforeEach, describe, expect, it } from "vitest";
import {
  focusHistory,
  forgetFocus,
  MAX_FOCUS_HISTORY,
  previousFocus,
  recordFocus,
  resetFocusHistoryForTests,
} from "./focusHistory.ts";

const ids = () =>
  focusHistory().map((e) => (e.kind === "agent" ? e.agentId : e.kind === "thread" ? e.threadId : e.terminalId));

describe("focus history", () => {
  beforeEach(() => resetFocusHistoryForTests());

  it("keeps the newest first, without duplicates", () => {
    recordFocus({ kind: "thread", threadId: "a", workspaceId: null });
    recordFocus({ kind: "terminal", terminalId: "t1", workspaceId: "w" });
    recordFocus({ kind: "thread", threadId: "a", workspaceId: null });
    expect(ids()).toEqual(["a", "t1"]);
    expect(previousFocus()).toEqual({ kind: "terminal", terminalId: "t1", workspaceId: "w" });
  });

  it("is bounded", () => {
    for (let i = 0; i < MAX_FOCUS_HISTORY + 3; i++)
      recordFocus({ kind: "thread", threadId: `t${i}`, workspaceId: null });
    expect(focusHistory()).toHaveLength(MAX_FOCUS_HISTORY);
    expect(ids()[0]).toBe(`t${MAX_FOCUS_HISTORY + 2}`);
  });

  it("re-recording the current target changes nothing but can learn its workspace", () => {
    recordFocus({ kind: "thread", threadId: "a", workspaceId: null });
    const before = focusHistory();
    recordFocus({ kind: "thread", threadId: "a", workspaceId: null });
    expect(focusHistory()).toBe(before);
    recordFocus({ kind: "thread", threadId: "a", workspaceId: "w" });
    expect(focusHistory()[0]).toEqual({ kind: "thread", threadId: "a", workspaceId: "w" });
  });

  it("keeps a known workspace when a thread comes back without one", () => {
    recordFocus({ kind: "thread", threadId: "a", workspaceId: "w" });
    recordFocus({ kind: "thread", threadId: "b", workspaceId: null });
    recordFocus({ kind: "thread", threadId: "a", workspaceId: null });
    expect(focusHistory()[0]).toEqual({ kind: "thread", threadId: "a", workspaceId: "w" });
  });

  it("forgets targets that no longer exist, by kind", () => {
    recordFocus({ kind: "thread", threadId: "x", workspaceId: null });
    recordFocus({ kind: "terminal", terminalId: "x", workspaceId: "w" });
    forgetFocus("thread", "x");
    expect(focusHistory()).toEqual([{ kind: "terminal", terminalId: "x", workspaceId: "w" }]);
    expect(previousFocus()).toBeNull();
  });
});
