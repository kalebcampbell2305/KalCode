import type { HandoffRecord, ThreadSummary, ThreadWorktreeState } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { thread } from "../../surfaces/dashboard/data/testing.ts";
import {
  areaBase,
  deriveOwnership,
  describeOverlap,
  fileCount,
  inArea,
  needsAttention,
  type OwnershipInput,
  ownershipSignature,
  ownersOf,
  type PairConflict,
  pairKey,
  pairsToCheck,
} from "./model.ts";

function agent(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  const t = thread({ status: "editing", terminalId: "term", ...overrides });
  return { ...t, worktreeId: overrides.worktreeId === undefined ? `wt-${t.id}` : overrides.worktreeId };
}

function facts(
  t: ThreadSummary,
  changedPaths: string[],
  extra: Partial<ThreadWorktreeState> = {},
): ThreadWorktreeState {
  return {
    threadId: t.id,
    worktreeId: t.worktreeId ?? "none",
    branch: `kal/${t.id}`,
    baseBranch: "main",
    ahead: 1,
    behind: 0,
    changed: 0,
    untracked: 0,
    conflicts: false,
    changedPaths,
    changedPathsTruncated: false,
    observedAt: "2026-10-07T00:00:00.000Z",
    ...extra,
  };
}

function input(agents: ThreadSummary[], more: Partial<OwnershipInput> = {}): OwnershipInput {
  return {
    agents,
    worktrees: new Map(),
    touched: new Map(),
    pairs: new Map(),
    declared: new Map(),
    handoffs: [],
    allowed: new Map(),
    ...more,
  };
}

function first<T>(list: readonly T[]): T {
  const [item] = list;
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

const states = (...list: ThreadWorktreeState[]) => new Map(list.map((s) => [s.threadId, s]));

function handoff(source: ThreadSummary, target: ThreadSummary, status: HandoffRecord["status"]): HandoffRecord {
  return {
    id: "handoff-1",
    sourceThreadId: source.id,
    targetThreadId: target.id,
    sourceWorkspaceId: source.workspaceId,
    targetWorkspaceId: target.workspaceId,
    sourceName: source.name,
    targetName: target.name,
    task: "continue",
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
    blocker: null,
    sourceCommit: null,
    sourceBranch: null,
    returnOfId: null,
  };
}

function conflict(a: ThreadSummary, b: ThreadSummary, conflicts: boolean | null, files: string[] = []): PairConflict {
  return { leftThreadId: a.id, rightThreadId: b.id, conflicts, files };
}

describe("deriveOwnership: worktree agents", () => {
  it("finds nothing when agents change different files", () => {
    const [a, b] = [agent(), agent()];
    const result = deriveOwnership(
      input([a, b], { worktrees: states(facts(a, ["src/a.ts"]), facts(b, ["src/b.ts"])) }),
    );
    expect(result.overlaps).toEqual([]);
    expect(result.claims.get(a.id)?.files).toEqual(["src/a.ts"]);
  });

  it("reports the shared files as same-files while Git has not answered", () => {
    const [a, b] = [agent({ name: "Billing Fix" }), agent({ name: "Pricing Update" })];
    const result = deriveOwnership(
      input([a, b], {
        worktrees: states(
          facts(a, ["src/pricing.ts", "src/billing.ts", "README.md"]),
          facts(b, ["src/pricing.ts", "README.md"]),
        ),
      }),
    );
    expect(result.overlaps).toEqual([
      {
        key: pairKey(a.id, b.id),
        agentIds: [a.id, b.id],
        workspaceId: a.workspaceId,
        risk: "same-files",
        files: ["README.md", "src/pricing.ts"],
        incomplete: false,
        area: null,
        allowed: false,
      },
    ]);
    expect(result.byAgent.get(a.id)?.[0]?.other.id).toBe(b.id);
    expect(result.byAgent.get(b.id)?.[0]?.other.id).toBe(a.id);
  });

  it("upgrades to conflict with Git's conflicting files", () => {
    const [a, b] = [agent(), agent()];
    const result = deriveOwnership(
      input([a, b], {
        worktrees: states(facts(a, ["x.ts", "y.ts"]), facts(b, ["x.ts", "y.ts"])),
        pairs: new Map([[pairKey(a.id, b.id), conflict(b, a, true, ["y.ts"])]]),
      }),
    );
    expect(result.overlaps[0]).toMatchObject({ risk: "conflict", files: ["y.ts"] });
    expect(needsAttention(first(result.overlaps))).toBe(true);
  });

  it("calls clean committed work compatible, and keeps it out of Needs You", () => {
    const [a, b] = [agent(), agent()];
    const result = deriveOwnership(
      input([a, b], {
        worktrees: states(facts(a, ["x.ts"]), facts(b, ["x.ts"])),
        pairs: new Map([[pairKey(a.id, b.id), conflict(a, b, false)]]),
      }),
    );
    expect(result.overlaps[0]?.risk).toBe("compatible");
    expect(needsAttention(first(result.overlaps))).toBe(false);
  });

  it("does not trust a clean merge while either worktree has uncommitted changes", () => {
    const [a, b] = [agent(), agent()];
    const result = deriveOwnership(
      input([a, b], {
        worktrees: states(facts(a, ["x.ts"], { changed: 1 }), facts(b, ["x.ts"])),
        pairs: new Map([[pairKey(a.id, b.id), conflict(a, b, false)]]),
      }),
    );
    expect(result.overlaps[0]?.risk).toBe("same-files");
  });

  it("keeps a stopped agent's unmerged files (Git truth) but drops archived agents", () => {
    const a = agent({ status: "interrupted", currentActivity: "Stopped by you" });
    const b = agent();
    const c = agent({ archivedAt: "2026-10-07T00:00:00.000Z" });
    const result = deriveOwnership(
      input([a, b, c], { worktrees: states(facts(a, ["x.ts"]), facts(b, ["x.ts"]), facts(c, ["x.ts"])) }),
    );
    expect(result.claims.get(a.id)?.active).toBe(false);
    expect(result.overlaps.map((o) => o.agentIds)).toEqual([[a.id, b.id]]);
    expect(result.claims.has(c.id)).toBe(false);
  });

  it("marks an overlap incomplete when either list was cut short", () => {
    const [a, b] = [agent(), agent()];
    const result = deriveOwnership(
      input([a, b], { worktrees: states(facts(a, ["x.ts"], { changedPathsTruncated: true }), facts(b, ["x.ts"])) }),
    );
    expect(result.overlaps[0]?.incomplete).toBe(true);
    expect(fileCount(first(result.overlaps))).toBe("at least 1 file");
  });

  it("never pairs agents of different projects", () => {
    const a = agent();
    const b = agent({ workspaceId: "01999a4e-0001-7001-8a2e-000000009999" });
    expect(
      deriveOwnership(input([a, b], { worktrees: states(facts(a, ["x.ts"]), facts(b, ["x.ts"])) })).overlaps,
    ).toEqual([]);
  });
});

describe("deriveOwnership: agents sharing the project folder", () => {
  it("reports live editing of the same files from provider edits", () => {
    const [a, b] = [agent({ worktreeId: null }), agent({ worktreeId: null })];
    const result = deriveOwnership(
      input([a, b], {
        touched: new Map([
          [a.id, { threadId: a.id, paths: ["src\\app.ts", "src/b.ts"], truncated: false }],
          [b.id, { threadId: b.id, paths: ["src/app.ts"], truncated: false }],
        ]),
      }),
    );
    expect(result.overlaps).toMatchObject([{ risk: "live", files: ["src/app.ts"] }]);
  });

  it("forgets a shared-folder agent's edits once its session ends", () => {
    const a = agent({ worktreeId: null, status: "completed" });
    const b = agent({ worktreeId: null });
    const result = deriveOwnership(
      input([a, b], {
        touched: new Map([
          [a.id, { threadId: a.id, paths: ["x.ts"], truncated: false }],
          [b.id, { threadId: b.id, paths: ["x.ts"], truncated: false }],
        ]),
      }),
    );
    expect(result.claims.get(a.id)?.files).toEqual([]);
    expect(result.overlaps).toEqual([]);
  });

  it("compares a shared-folder agent with a worktree agent as same-files", () => {
    const a = agent({ worktreeId: null });
    const b = agent();
    const result = deriveOwnership(
      input([a, b], {
        touched: new Map([[a.id, { threadId: a.id, paths: ["x.ts"], truncated: false }]]),
        worktrees: states(facts(b, ["x.ts"])),
      }),
    );
    expect(result.overlaps[0]?.risk).toBe("same-files");
  });
});

describe("deriveOwnership: declared areas", () => {
  it("warns when an agent enters another active agent's area before the files meet", () => {
    const owner = agent({ name: "Billing Fix" });
    const entrant = agent({ name: "Pricing Update" });
    const result = deriveOwnership(
      input([owner, entrant], {
        worktrees: states(facts(owner, []), facts(entrant, ["src/billing/plans.ts", "README.md"])),
        declared: new Map([[owner.id, ["src/billing/**"]]]),
      }),
    );
    expect(result.overlaps).toMatchObject([
      {
        risk: "area",
        files: ["src/billing/plans.ts"],
        area: { owner: owner.id, entrant: entrant.id, pattern: "src/billing/**" },
      },
    ]);
    const names = new Map([
      [owner.id, owner.name],
      [entrant.id, entrant.name],
    ]);
    expect(describeOverlap(first(result.overlaps), (id) => names.get(id) ?? id)).toBe(
      "Pricing Update changed 1 file in src/billing, which Billing Fix owns.",
    );
  });

  it("releases a declared area when its agent ends", () => {
    const owner = agent({ status: "failed" });
    const entrant = agent();
    const result = deriveOwnership(
      input([owner, entrant], {
        worktrees: states(facts(entrant, ["src/billing/plans.ts"])),
        declared: new Map([[owner.id, ["src/billing/"]]]),
      }),
    );
    expect(result.claims.get(owner.id)?.areas).toEqual([]);
    expect(result.overlaps).toEqual([]);
  });

  it("matches areas like Squads do", () => {
    expect(areaBase("src/billing/**")).toBe("src/billing");
    expect(areaBase("src\\billing\\")).toBe("src/billing");
    expect(inArea("SRC/Billing/a.ts", "src/billing/**")).toBe(true);
    expect(inArea("src/billing", "src/billing/")).toBe(true);
    expect(inArea("src/billingx/a.ts", "src/billing")).toBe(false);
    expect(inArea("anything.ts", "**")).toBe(false);
  });
});

describe("deriveOwnership: handoffs and overrides", () => {
  it("passes the sender's files to the receiver and never warns about the pair", () => {
    const [source, target] = [agent(), agent()];
    const result = deriveOwnership(
      input([source, target], {
        worktrees: states(facts(source, ["x.ts"]), facts(target, ["x.ts"])),
        handoffs: [handoff(source, target, "working")],
      }),
    );
    expect(result.overlaps).toEqual([]);
    expect(result.claims.get(target.id)?.received).toEqual({
      from: source.id,
      handoffId: "handoff-1",
      files: ["x.ts"],
    });
    expect(result.claims.get(source.id)?.handedTo).toEqual({ to: target.id, handoffId: "handoff-1" });
  });

  it("returns to plain facts once the handoff finishes", () => {
    const [source, target] = [agent(), agent()];
    const result = deriveOwnership(
      input([source, target], {
        worktrees: states(facts(source, ["x.ts"]), facts(target, ["x.ts"])),
        handoffs: [handoff(source, target, "completed")],
      }),
    );
    expect(result.overlaps).toHaveLength(1);
    expect(result.claims.get(target.id)?.received).toBeNull();
  });

  it("keeps an allowed overlap allowed until it grows to new files", () => {
    const [a, b] = [agent(), agent()];
    const key = pairKey(a.id, b.id);
    const allowed = new Map([[key, { files: ["x.ts"], risk: "same-files" as const }]]);
    const same = deriveOwnership(input([a, b], { worktrees: states(facts(a, ["x.ts"]), facts(b, ["x.ts"])), allowed }));
    expect(same.overlaps[0]?.allowed).toBe(true);
    expect(needsAttention(first(same.overlaps))).toBe(false);
    const grown = deriveOwnership(
      input([a, b], { worktrees: states(facts(a, ["x.ts", "y.ts"]), facts(b, ["x.ts", "y.ts"])), allowed }),
    );
    expect(grown.overlaps[0]?.allowed).toBe(false);
  });
});

describe("review fixes", () => {
  it("warns again when an allowed overlap gets riskier", () => {
    const [a, b] = [agent(), agent()];
    const key = pairKey(a.id, b.id);
    const allowed = new Map([[key, { files: ["x.ts"], risk: "same-files" as const }]]);
    const worse = deriveOwnership(
      input([a, b], {
        worktrees: states(facts(a, ["x.ts"]), facts(b, ["x.ts"])),
        pairs: new Map([[key, conflict(a, b, true, ["x.ts"])]]),
        allowed,
      }),
    );
    expect(first(worse.overlaps)).toMatchObject({ risk: "conflict", allowed: false });
  });

  it("compares paths case-insensitively and ignores ./ and leading slashes", () => {
    const [a, b] = [agent({ worktreeId: null }), agent()];
    const result = deriveOwnership(
      input([a, b], {
        touched: new Map([[a.id, { threadId: a.id, paths: ["./Src/App.tsx"], truncated: false }]]),
        worktrees: states(facts(b, ["src/app.tsx"])),
      }),
    );
    expect(first(result.overlaps).files).toEqual(["Src/App.tsx"]);
    expect(
      ownersOf(result, a.workspaceId, "/SRC/app.tsx")
        .map((o) => o.agentId)
        .toSorted(),
    ).toEqual([a.id, b.id].toSorted());
  });

  it("stops silencing a pair once its handoff has been stuck for a day", () => {
    const [source, target] = [agent(), agent()];
    const stuck = { ...handoff(source, target, "working"), updatedAt: "2026-10-05T00:00:00.000Z" };
    const result = deriveOwnership(
      input([source, target], {
        worktrees: states(facts(source, ["x.ts"]), facts(target, ["x.ts"])),
        handoffs: [stuck],
        now: Date.parse("2026-10-07T00:00:00.000Z"),
      }),
    );
    expect(result.overlaps).toHaveLength(1);
  });

  it("does not depend on the order agents are listed in", () => {
    const [a, b, c] = [agent(), agent(), agent()];
    const worktrees = states(facts(a, ["x.ts"]), facts(b, ["x.ts"]), facts(c, ["x.ts"]));
    const one = deriveOwnership(input([a, b, c], { worktrees }));
    const two = deriveOwnership(input([c, a, b], { worktrees }));
    expect(ownershipSignature(two)).toBe(ownershipSignature(one));
  });
});

describe("ordering, pairs to check, file owners", () => {
  it("lists the most expensive overlap first", () => {
    const [a, b, c] = [agent(), agent(), agent()];
    const result = deriveOwnership(
      input([a, b, c], {
        worktrees: states(facts(a, ["x.ts", "y.ts", "z.ts"]), facts(b, ["x.ts", "y.ts", "z.ts"]), facts(c, ["x.ts"])),
        pairs: new Map([[pairKey(a.id, c.id), conflict(a, c, true, ["x.ts"])]]),
      }),
    );
    expect(result.overlaps.map((o) => o.risk)).toEqual(["conflict", "same-files", "same-files"]);
    expect(result.byAgent.get(a.id)?.[0]?.other.id).toBe(c.id);
  });

  it("asks Git only about worktree pairs with shared files", () => {
    const [a, b, c] = [agent(), agent(), agent({ worktreeId: null })];
    const d = agent();
    expect(
      pairsToCheck({
        agents: [a, b, c, d],
        worktrees: states(facts(a, ["x.ts"]), facts(b, ["x.ts"]), facts(d, ["other.ts"])),
      }),
    ).toEqual([[a.id, b.id]]);
  });

  it("names who holds a path: editing, then received, then area", () => {
    const [editor, receiver, owner, source] = [agent(), agent(), agent(), agent()];
    const result = deriveOwnership(
      input([editor, receiver, owner, source], {
        worktrees: states(facts(editor, ["src/billing/a.ts"]), facts(source, ["src/billing/a.ts"])),
        declared: new Map([[owner.id, ["src/billing"]]]),
        handoffs: [handoff(source, receiver, "delivered")],
      }),
    );
    expect(ownersOf(result, editor.workspaceId, "src\\billing\\a.ts")).toEqual([
      { agentId: editor.id, how: "editing" },
      { agentId: source.id, how: "editing" },
      { agentId: receiver.id, how: "received" },
      { agentId: owner.id, how: "area" },
    ]);
    expect(ownersOf(result, "another-project", "src/billing/a.ts")).toEqual([]);
  });
});
