import type { EventEnvelope, EventPayload } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { type DashboardResource, RefreshTracker, resourcesFor } from "./refresh.ts";

function envelope(seq: number, event: EventPayload): EventEnvelope {
  return {
    id: `e${seq}`,
    seq,
    version: 1,
    occurredAt: "2026-09-24T10:00:00Z",
    source: "core",
    correlation: { workspaceId: null, threadId: null, missionId: null, providerId: null, requestId: null },
    ...event,
  } as EventEnvelope;
}

const T = "01999a4e-0002-7001-8a2e-000000002001";

describe("resourcesFor", () => {
  it.each<[EventEnvelope["type"], DashboardResource[]]>([
    ["thread.status_changed", ["threads"]],
    ["thread.archived", ["threads"]],
    ["tool.started", ["threads"]],
    ["file.modified", ["threads"]],
    ["agent.message", ["threads"]],
    ["approval.requested", ["approvals", "threads"]],
    ["approval.expired", ["approvals", "threads"]],
    ["permission.mode_changed", ["threads", "approvals"]],
    ["shell.started", ["terminals"]],
    ["shell.failed", ["terminals"]],
    ["workspace.removed", ["threads", "terminals"]],
    ["provider.disconnected", ["threads"]],
    ["settings.changed", []],
    ["app.started", []],
    ["unrecognized", []],
  ])("%s refreshes %j", (type, expected) => {
    expect(resourcesFor(type)).toEqual(expected);
  });
});

describe("RefreshTracker", () => {
  const status = (seq: number) =>
    envelope(seq, {
      type: "thread.status_changed",
      payload: { threadId: T, from: "idle", to: "active", detail: null },
    });
  const shell = (seq: number) =>
    envelope(seq, { type: "shell.started", payload: { terminalId: T, shellId: "pwsh", shellName: "PowerShell" } });
  const settings = (seq: number) => envelope(seq, { type: "settings.changed", payload: { keys: [] } });

  it("ignores events at or below the starting watermark", () => {
    const tracker = new RefreshTracker(5);
    expect([...tracker.observe([status(5), status(4)])]).toEqual([]);
  });

  it("collects the resources of every new event and advances the watermark", () => {
    const tracker = new RefreshTracker(1);
    expect([...tracker.observe([shell(3), status(2), status(1)])].sort()).toEqual(["terminals", "threads"]);
    expect(tracker.seq).toBe(3);
    expect([...tracker.observe([shell(3), status(2)])]).toEqual([]);
  });

  it("advances past events that change nothing without refreshing", () => {
    const tracker = new RefreshTracker(0);
    expect([...tracker.observe([settings(1)])]).toEqual([]);
    expect(tracker.seq).toBe(1);
  });

  it("does not refresh for older history paged in later", () => {
    const tracker = new RefreshTracker(10);
    expect([...tracker.observe([status(9), status(8), status(7)])]).toEqual([]);
    expect(tracker.seq).toBe(10);
  });
});
