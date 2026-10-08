import type { ThreadStatus, ThreadSummary } from "@kalcode/protocol";
import { DISPLAY_STATUS_OF } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import {
  activityBuckets,
  chipCounts,
  compareThreads,
  filterThreads,
  fleetCounts,
  fleetFilterOf,
  fleetGroupOf,
  fleetSummaryLine,
  GROUP_MODES,
  groupThreads,
  matchesQuery,
  summaryLine,
} from "./board.ts";

let n = 0;
function thread(status: ThreadStatus, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  n += 1;
  return {
    id: `01999a4e-0002-7${String(n).padStart(3, "0")}-8a2e-${String(n).padStart(12, "0")}`,
    name: `Thread ${n}`,
    providerId: "claude-code",
    providerName: "Claude Code",
    model: "claude-sonnet-4-5",
    effort: null,
    providerAccountId: null,
    accountLabel: null,
    workspaceId: "ws-a",
    workspaceName: "kalcode",
    permissionMode: "approve",
    status,
    currentActivity: null,
    createdAt: "2026-09-25T08:00:00.000Z",
    lastActivityAt: "2026-09-25T09:00:00.000Z",
    pendingApprovals: 0,
    unreadMessages: 0,
    filesChanged: null,
    branch: null,
    error: null,
    archivedAt: null,
    resumable: false,
    permissionProfileId: null,
    runtimeKind: null,
    terminalId: null,
    worktreeId: null,
    ...overrides,
  };
}

describe("chip counts and the summary line", () => {
  it("counts every thread once, through the contract mapping", () => {
    const all = (Object.keys(DISPLAY_STATUS_OF) as ThreadStatus[]).map((s) => thread(s));
    const counts = chipCounts(all);
    expect(counts.all).toBe(18);
    expect(counts.working + counts.waiting_for_you + counts.done + counts.idle).toBe(18);
    // FAILED needs attention: it counts under "Waiting for you".
    expect(counts.waiting_for_you).toBe(3);
    expect(counts.done).toBe(1);
  });

  it("reads like the owner's example and leaves out empty groups", () => {
    const threads = [
      ...Array.from({ length: 2 }, () => thread("running_command")),
      ...Array.from({ length: 19 }, () => thread("idle")),
    ];
    expect(summaryLine(chipCounts(threads))).toBe("21 agents · 2 working · 19 idle");
    expect(summaryLine(chipCounts([thread("completed")]))).toBe("1 agent · 1 done");
    expect(summaryLine(chipCounts([]))).toBe("0 agents");
  });
});

describe("Agent Fleet groups", () => {
  it("partition every agent into exactly one shared group; FAILED and WAITING are their own", () => {
    const all = (Object.keys(DISPLAY_STATUS_OF) as ThreadStatus[]).map((s) => thread(s));
    const counts = fleetCounts(all);
    expect(counts.all).toBe(18);
    expect(counts.needs_you + counts.working + counts.waiting + counts.done + counts.idle + counts.failed).toBe(18);
    expect(counts.needs_you).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.waiting).toBe(1);
    expect(fleetGroupOf(thread("failed"))).toBe("failed");
    expect(fleetGroupOf(thread("waiting_for_user"))).toBe("needs_you");
    expect(fleetGroupOf(thread("waiting_for_dependency"))).toBe("waiting");
    expect(fleetGroupOf(thread("interrupted"))).toBe("done");
    expect(fleetGroupOf(thread("completed"))).toBe("done");
  });

  it("groups agents by state, never by provider", () => {
    const mixed = [
      { ...thread("running_tool"), providerId: "claude-code" },
      { ...thread("editing"), providerId: "codex" },
      { ...thread("active"), providerId: "cursor" },
      { ...thread("testing"), providerId: "gemini-cli" },
    ];
    const counts = fleetCounts(mixed);
    expect(counts.working).toBe(4);
    expect(fleetSummaryLine(counts)).toBe("4 agents · 4 working");
    expect(filterThreads(mixed, "working", "", undefined, "codex").map((t) => t.providerId)).toEqual(["codex"]);
    expect(fleetGroupOf({ ...thread("idle"), pendingApprovals: 1 })).toBe("needs_you");
  });

  it("summarises like the owner's example, with zeros left out", () => {
    const threads = [
      thread("running_command"),
      thread("waiting_for_permission"),
      thread("waiting_for_user"),
      ...Array.from({ length: 9 }, () => thread("completed")),
      ...Array.from({ length: 15 }, () => thread("idle")),
    ];
    expect(fleetSummaryLine(fleetCounts(threads))).toBe("27 agents · 1 working · 2 need you · 9 done · 15 idle");
    expect(fleetSummaryLine(fleetCounts([thread("waiting_for_user"), thread("failed")]))).toBe(
      "2 agents · 1 needs you · 1 failed",
    );
    expect(fleetSummaryLine(fleetCounts([]))).toBe("0 agents");
  });

  it("maps a KalVoice chip request onto the Fleet filter", () => {
    expect(fleetFilterOf("waiting_for_you")).toBe("needs_you");
    expect(fleetFilterOf("working")).toBe("working");
    expect(fleetFilterOf("all")).toBe("all");
  });
});

describe("filtering and search", () => {
  it("filters by group and by every word of the query", () => {
    const a = thread("editing", { name: "Fix login flow", branch: "fix/login" });
    const b = thread("waiting_for_permission", { name: "Bump deps", workspaceName: "atlas-api" });
    const c = thread("completed", { name: "Write docs", providerName: "Codex", providerId: "codex" });
    const d = thread("failed", { name: "Ship it", accountLabel: "Zeta", effort: "high" });
    expect(filterThreads([a, b, c, d], "working", "")).toEqual([a]);
    expect(filterThreads([a, b, c, d], "needs_you", "")).toEqual([b]);
    expect(filterThreads([a, b, c, d], "failed", "")).toEqual([d]);
    // Account, status, effort and caller-supplied fields (the call sign) are searchable too.
    expect(filterThreads([a, b, c, d], "all", "zeta")).toEqual([d]);
    expect(filterThreads([a, b, c, d], "all", "failed")).toEqual([d]);
    expect(filterThreads([a, b, c, d], "all", "high")).toEqual([d]);
    expect(filterThreads([a, b, c, d], "all", "needs")).toEqual([b]);
    expect(filterThreads([a, b, c, d], "all", "codex b", (t) => (t === a ? ["Codex B"] : []))).toEqual([a]);
    // A phrase that names something exactly wins over loose words ("Claude B", not any "b").
    const e = thread("idle", { name: "Bump billing", accountLabel: "Claude A" });
    const f = thread("idle", { name: "Docs", accountLabel: "Claude B" });
    expect(filterThreads([e, f], "all", "claude  b")).toEqual([f]);
    expect(filterThreads([e, f], "all", "claude bump")).toEqual([e]);
    expect(filterThreads([a, b, c], "all", "atlas")).toEqual([b]);
    expect(filterThreads([a, b, c], "all", "codex docs")).toEqual([c]);
    expect(matchesQuery(a, "FIX/LOGIN")).toBe(true);
    expect(matchesQuery(a, "nothing")).toBe(false);
  });

  it("searches provider-reported model and reasoning identifiers", () => {
    const active = {
      ...thread("active"),
      model: "selected/model-v1",
      effort: "high",
      activeModel: "provider/model-v2[reasoning=max]",
      activeEffort: "X-High",
    } as ThreadSummary;
    expect(matchesQuery(active, "provider/model-v2[reasoning=max]")).toBe(true);
    expect(matchesQuery(active, "x-high")).toBe(true);
  });
});

describe("grouping", () => {
  it("offers only status, project and provider (no fake agent or mission grouping)", () => {
    expect(GROUP_MODES).toEqual(["status", "project", "provider"]);
  });

  it("orders status groups by urgency and cards by need, then recency", () => {
    const failed = thread("failed");
    const permission = thread("waiting_for_permission");
    const working = thread("thinking");
    const idle = thread("idle");
    const done = thread("completed");
    const groups = groupThreads([idle, done, working, failed, permission], "status");
    expect(groups.map((g) => g.label)).toEqual(["Needs you", "Working", "Done", "Idle", "Failed"]);
    expect(groups[0]?.threads).toEqual([permission]);
    expect(groups[4]?.threads).toEqual([failed]);
  });

  it("puts the projects and providers that need the person first", () => {
    const calm = thread("idle", { workspaceId: "ws-b", workspaceName: "b" });
    const urgent = thread("waiting_for_user", { workspaceId: "ws-c", workspaceName: "c" });
    const groups = groupThreads([calm, urgent], "project");
    expect(groups.map((g) => g.label)).toEqual(["c", "b"]);
    const byProvider = groupThreads(
      [thread("idle"), thread("editing", { providerId: "codex", providerName: "Codex" })],
      "provider",
    );
    expect(byProvider.map((g) => g.providerId)).toEqual(["codex", "claude-code"]);
  });

  it("is stable: equal threads sort by name then id", () => {
    const x = thread("idle", { name: "B" });
    const y = thread("idle", { name: "A" });
    expect([x, y].sort(compareThreads)).toEqual([y, x]);
  });
});

describe("activity trend", () => {
  it("buckets real events and returns null when nothing happened", () => {
    const now = Date.parse("2026-09-25T10:00:00.000Z");
    const at = (minAgo: number) => ({ occurredAt: new Date(now - minAgo * 60_000).toISOString() });
    const buckets = activityBuckets([at(1), at(2), at(59), at(61)], now);
    expect(buckets).toHaveLength(12);
    expect(buckets?.[11]).toBe(2);
    expect(buckets?.[0]).toBe(1);
    expect(activityBuckets([at(120)], now)).toBeNull();
  });
});

describe("performance", () => {
  it("recomputes counts, filters and groups for 200 agents well within a frame", () => {
    const statuses = Object.keys(DISPLAY_STATUS_OF) as ThreadStatus[];
    const threads = Array.from({ length: 200 }, (_, i) =>
      thread(statuses[i % statuses.length] ?? "idle", {
        workspaceId: `ws-${i % 5}`,
        workspaceName: `ws-${i % 5}`,
        lastActivityAt: new Date(Date.UTC(2026, 8, 25, 9, i)).toISOString(),
      }),
    );
    // Warm up once, then time an event batch's worth of recomputation.
    groupThreads(filterThreads(threads, "all", ""), "status");
    const start = performance.now();
    for (const mode of GROUP_MODES) {
      fleetCounts(threads);
      groupThreads(filterThreads(threads, "all", "ws"), mode);
    }
    expect(performance.now() - start).toBeLessThan(16);
  });
});
