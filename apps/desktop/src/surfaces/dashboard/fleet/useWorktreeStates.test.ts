import type { ThreadWorktreeState } from "@kalcode/protocol";
import { expect, it } from "vitest";
import { keepUnchanged } from "./useWorktreeStates.ts";

const state = (threadId: string, patch: Partial<ThreadWorktreeState> = {}): ThreadWorktreeState => ({
  threadId,
  worktreeId: `wt-${threadId}`,
  branch: `agent/${threadId}`,
  baseBranch: "main",
  ahead: 1,
  behind: 0,
  changed: 2,
  untracked: 0,
  conflicts: false,
  observedAt: "2026-10-05T12:00:00Z",
  ...patch,
});

it("keeps the same map when a read only moves observedAt", () => {
  const current = new Map([
    ["a", state("a")],
    ["b", state("b")],
  ]);
  const next = keepUnchanged(current, [
    state("a", { observedAt: "2026-10-05T12:00:10Z" }),
    state("b", { observedAt: "2026-10-05T12:00:10Z" }),
  ]);
  expect(next).toBe(current);
});

it("replaces only the agent whose facts changed", () => {
  const a = state("a");
  const b = state("b");
  const current = new Map([
    ["a", a],
    ["b", b],
  ]);
  const changed = state("b", { changed: 3, observedAt: "2026-10-05T12:00:10Z" });
  const next = keepUnchanged(current, [state("a", { observedAt: "2026-10-05T12:00:10Z" }), changed]);
  expect(next).not.toBe(current);
  expect(next.get("a")).toBe(a);
  expect(next.get("b")).toBe(changed);
});

it("drops agents the read no longer reports and adds new ones", () => {
  const a = state("a");
  const current = new Map([
    ["a", a],
    ["b", state("b")],
  ]);
  const c = state("c");
  const next = keepUnchanged(current, [a, c]);
  expect([...next.keys()]).toEqual(["a", "c"]);
  expect(next.get("a")).toBe(a);
});
