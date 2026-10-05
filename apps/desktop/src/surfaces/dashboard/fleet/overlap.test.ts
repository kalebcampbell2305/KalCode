import type { ThreadSummary, ThreadWorktreeState } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { thread } from "../data/testing.ts";
import { agentOverlaps, overlapCount, overlapsByAgent } from "./overlap.ts";

function agent(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  const t = thread({ status: "editing", ...overrides });
  return { ...t, worktreeId: overrides.worktreeId === undefined ? `wt-${t.id}` : overrides.worktreeId };
}

function facts(t: ThreadSummary, changedPaths: string[], truncated = false): ThreadWorktreeState {
  return {
    threadId: t.id,
    worktreeId: t.worktreeId ?? "none",
    branch: `kal/${t.id}`,
    baseBranch: "main",
    ahead: 1,
    behind: 0,
    changed: changedPaths.length,
    untracked: 0,
    conflicts: false,
    changedPaths,
    changedPathsTruncated: truncated,
    observedAt: "2026-10-05T00:00:00.000Z",
  };
}

const states = (...list: ThreadWorktreeState[]) => new Map(list.map((s) => [s.threadId, s]));

describe("agentOverlaps", () => {
  it("finds nothing when agents touch different files", () => {
    const a = agent();
    const b = agent();
    expect(agentOverlaps([a, b], states(facts(a, ["src/a.ts"]), facts(b, ["src/b.ts"])))).toEqual([]);
  });

  it("reports a pair and the shared files, sorted", () => {
    const a = agent({ name: "Billing Fix" });
    const b = agent({ name: "Pricing Update", providerName: "Codex" });
    const found = agentOverlaps(
      [a, b],
      states(facts(a, ["src/pricing.ts", "src/billing.ts", "README.md"]), facts(b, ["src/pricing.ts", "README.md"])),
    );
    expect(found).toEqual([
      { agentIds: [a.id, b.id], workspaceId: a.workspaceId, files: ["README.md", "src/pricing.ts"], incomplete: false },
    ]);
    const byAgent = overlapsByAgent(found, [a, b]);
    expect(byAgent.get(a.id)?.[0]?.other.id).toBe(b.id);
    expect(byAgent.get(b.id)?.[0]?.other.id).toBe(a.id);
  });

  it("reports every pair of a three-way overlap, each agent seeing both others", () => {
    const [a, b, c] = [agent(), agent(), agent()];
    const found = agentOverlaps(
      [a, b, c],
      states(facts(a, ["x.ts"]), facts(b, ["x.ts", "y.ts"]), facts(c, ["x.ts", "y.ts"])),
    );
    expect(found.map((o) => o.agentIds)).toEqual([
      [a.id, b.id],
      [a.id, c.id],
      [b.id, c.id],
    ]);
    const byAgent = overlapsByAgent(found, [a, b, c]);
    // Largest overlap first.
    expect(byAgent.get(b.id)?.map((o) => [o.other.id, o.files.length])).toEqual([
      [c.id, 2],
      [a.id, 1],
    ]);
  });

  it("says when a side's file list was truncated (at least N files)", () => {
    const a = agent();
    const b = agent();
    const [found] = agentOverlaps([a, b], states(facts(a, ["x.ts"], true), facts(b, ["x.ts"])));
    expect(found?.incomplete).toBe(true);
    expect(found && overlapCount(found)).toBe("at least 1 file");
    expect(overlapCount({ files: ["a", "b"], incomplete: false })).toBe("2 files");
  });

  it("never pairs agents of different workspaces, archived agents or agents without facts", () => {
    const a = agent();
    const other = agent({ workspaceId: "01999a4e-0001-7001-8a2e-000000009999" });
    const archived = agent({ archivedAt: "2026-10-05T00:00:00.000Z" });
    const unread = agent();
    const folder = agent({ worktreeId: null });
    expect(
      agentOverlaps(
        [a, other, archived, unread, folder],
        states(facts(a, ["x.ts"]), facts(other, ["x.ts"]), facts(archived, ["x.ts"]), facts(folder, ["x.ts"])),
      ),
    ).toEqual([]);
  });
});
