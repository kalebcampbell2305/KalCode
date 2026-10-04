import type { OperationActivity, OperationRecord } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import {
  activityLevel,
  buildActivityHeatmap,
  isActiveRun,
  moveQueueItem,
  operationDurationLabel,
  orderedQueue,
  planActivityHistory,
  planRunHistory,
  queueSections,
} from "./model.ts";

function record(
  id: string,
  status: OperationRecord["status"],
  lane: OperationRecord["spec"]["lane"],
  position: number,
  priority = 0,
): OperationRecord {
  return {
    id,
    source: "operations",
    status,
    workspaceName: "KalCode",
    branch: "main",
    version: null,
    accountLabel: null,
    terminalId: null,
    threadId: null,
    createdAt: "2026-09-30T10:00:00Z",
    startedAt: null,
    endedAt: null,
    currentAction: null,
    outcome: null,
    position,
    blockers: [],
    spec: {
      name: id,
      workspaceId: "workspace-1",
      kind: "script",
      command: "echo test",
      prompt: null,
      providerId: null,
      providerAccountId: null,
      model: null,
      effort: null,
      dependencies: [],
      priority,
      lane,
      environment: "local",
      urls: [],
      envKeys: [],
    },
  };
}

describe("Operations view model", () => {
  it("uses the backend position as queue authority and exposes Now / Next / Later", () => {
    const blocked = record("blocked-active", "blocked", "next", 8);
    blocked.startedAt = "2026-09-30T11:00:00Z";
    const paused = record("paused-active", "paused", "next", 7);
    paused.startedAt = "2026-09-30T10:30:00Z";
    const items = [
      record("later", "queued", "later", 3),
      record("running", "running", "next", 9),
      blocked,
      paused,
      record("first", "queued", "next", 1),
      record("held", "paused", "next", 2),
    ];
    expect(orderedQueue(items).map((item) => item.id)).toEqual(["first", "held", "later"]);
    const sections = queueSections(items);
    expect(sections.now.map((item) => item.id)).toEqual(["paused-active", "blocked-active", "running"]);
    expect(sections.next.map((item) => item.id)).toEqual(["first", "held"]);
    expect(sections.later.map((item) => item.id)).toEqual(["later"]);
  });

  it("supports deterministic keyboard reordering without losing ids", () => {
    expect(moveQueueItem(["one", "two", "three"], "two", -1)).toEqual(["two", "one", "three"]);
    expect(moveQueueItem(["one", "two", "three"], "two", 1)).toEqual(["one", "three", "two"]);
    expect(moveQueueItem(["one", "two"], "one", -1)).toEqual(["one", "two"]);
  });

  it("keeps historical runs with unknown completion evidence out of every queue lane", () => {
    const unknown = record("historical-agent-turn", "unknown", "next", 1);
    unknown.startedAt = "2026-09-29T10:00:00Z";

    expect(isActiveRun(unknown)).toBe(false);
    expect(orderedQueue([unknown])).toEqual([]);
    expect(queueSections([unknown])).toEqual({ now: [], next: [], later: [] });
    expect(operationDurationLabel(unknown)).toBe("Unavailable");
  });

  it("builds heatmap counts only from real events in the selected range", () => {
    const events: OperationActivity[] = [
      {
        id: "a",
        at: "2026-09-30T11:55:00Z",
        kind: "test",
        name: "Tests passed",
        area: "desktop",
        workspaceId: "workspace-1",
        runId: "run-1",
      },
      {
        id: "b",
        at: "2026-09-30T11:40:00Z",
        kind: "commit",
        name: "Commit",
        area: "desktop",
        workspaceId: "workspace-1",
        runId: null,
      },
      {
        id: "old",
        at: "2026-09-29T11:40:00Z",
        kind: "build",
        name: "Old",
        area: "website",
        workspaceId: "workspace-1",
        runId: null,
      },
    ];
    const result = buildActivityHeatmap(events, [], "1h", new Date("2026-09-30T12:00:00Z"));
    expect(result.events.map((event) => event.id)).toEqual(["a", "b"]);
    expect(result.rows).toEqual([expect.objectContaining({ area: "desktop", total: 2 })]);
    expect(activityLevel(0, 2)).toBe(0);
    expect(activityLevel(2, 2)).toBe(4);
  });

  it("reports missing release evidence rather than claiming a release window", () => {
    const result = buildActivityHeatmap(
      [
        {
          id: "ancient",
          at: "2001-01-01T00:00:00Z",
          kind: "commit",
          name: "Ancient",
          area: "archive",
          workspaceId: null,
          runId: null,
        },
      ],
      [],
      "release",
      new Date("2026-09-30T12:00:00Z"),
    );
    expect(result.rangeNote).toMatch(/no completed release is recorded/i);
    expect(result.rows).toEqual([]);
    expect(result.bins.length).toBeLessThanOrEqual(56);
  });
});

describe("plan history retention", () => {
  const observedAt = "2026-10-04T12:00:00Z";
  function completed(id: string, daysAgo: number): OperationRecord {
    return {
      ...record(id, "succeeded", "next", 0),
      endedAt: new Date(Date.parse(observedAt) - daysAgo * 86_400_000).toISOString(),
    };
  }
  it("keeps Pro's last 30 days and Max's last year without hiding ongoing work", () => {
    const active = { ...record("active", "running", "next", 0), startedAt: "2020-01-01T00:00:00Z" };
    const runs = [
      completed("recent", 1),
      completed("boundary", 30),
      completed("old", 31),
      completed("year", 365),
      completed("older", 366),
      active,
    ];
    expect(planRunHistory(runs, "pro", observedAt).map((run) => run.id)).toEqual(["recent", "boundary", "active"]);
    expect(planRunHistory(runs, "max", observedAt).map((run) => run.id)).toEqual([
      "recent",
      "boundary",
      "old",
      "year",
      "active",
    ]);
    expect(planRunHistory(runs, "max2x", observedAt)).toEqual(runs);
    expect(planRunHistory(runs, "pro", observedAt, "older").map((run) => run.id)).toContain("older");
  });
  it("shows Free ten recent finished runs while retaining active work", () => {
    const runs = Array.from({ length: 12 }, (_, index) => completed(String(index), index));
    runs.push(record("active", "running", "next", 0));
    expect(planRunHistory(runs, "free", observedAt).map((run) => run.id)).toEqual([
      ...Array.from({ length: 10 }, (_, index) => String(index)),
      "active",
    ]);
  });
});

describe("Activity history plan retention", () => {
  it("keeps Starter recent and applies Pro/Max windows without truncating Max 2X", () => {
    const observedAt = "2026-10-04T12:00:00Z";
    const events: OperationActivity[] = Array.from({ length: 13 }, (_, i) => ({
      id: String(i),
      at: new Date(Date.parse(observedAt) - i * 31 * 86_400_000).toISOString(),
      kind: "run",
      name: "Completed",
      area: "Code",
      workspaceId: null,
      runId: null,
    }));
    expect(planActivityHistory(events, "free", observedAt)).toHaveLength(10);
    expect(planActivityHistory(events, "pro", observedAt).map((event) => event.id)).toEqual(["0"]);
    expect(planActivityHistory(events, "max", observedAt)).toHaveLength(12);
    expect(planActivityHistory(events, "max2x", observedAt)).toEqual(events);
  });
});
