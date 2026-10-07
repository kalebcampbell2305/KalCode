import type { ThreadWorktreeState } from "@kalcode/protocol";
import { expect, it } from "vitest";
import { keepUnchanged, readWorktreeStateGeneration } from "./useWorktreeStates.ts";

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
  changedPaths: ["src/a.ts", "src/b.ts"],
  changedPathsTruncated: false,
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

it("treats a different list of changed files as new facts (the agent's outcome shows it)", () => {
  const before = state("a");
  const current = new Map([["a", before]]);
  const next = keepUnchanged(current, [state("a", { changedPaths: ["src/a.ts", "src/c.ts"] })]);
  expect(next).not.toBe(current);
  expect(next.get("a")?.changedPaths).toEqual(["src/a.ts", "src/c.ts"]);
});

it("reads all 100 Squad agents in native-sized chunks and combines one complete generation", async () => {
  const ids = Array.from({ length: 100 }, (_, index) => `agent-${index}`);
  const calls: string[][] = [];
  const generation = await readWorktreeStateGeneration(async (chunk) => {
    calls.push(chunk);
    return chunk.map((id) => state(id));
  }, ids);

  expect(calls.map((call) => call.length)).toEqual([64, 36]);
  expect(generation.states.map((item) => item.threadId)).toEqual(ids);
  expect(generation.incomplete).toBe(false);
});

it("reports omitted agents and rejects a partial chunk failure without returning a mixed generation", async () => {
  const ids = Array.from({ length: 65 }, (_, index) => `agent-${index}`);
  await expect(
    readWorktreeStateGeneration(async (chunk) => {
      if (chunk.length === 1) throw new Error("worktree unavailable");
      return chunk.map((id) => state(id));
    }, ids),
  ).rejects.toThrow("worktree unavailable");

  await expect(
    readWorktreeStateGeneration(async (chunk) => chunk.slice(1).map((id) => state(id)), ids),
  ).resolves.toEqual(expect.objectContaining({ incomplete: true }));
});
