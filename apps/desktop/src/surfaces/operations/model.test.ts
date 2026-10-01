import type { OperationActivity, OperationRecord } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import {
  activityLevel,
  buildActivityHeatmap,
  isActiveRun,
  moveQueueItem,
  operationDurationLabel,
  orderedQueue,
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
