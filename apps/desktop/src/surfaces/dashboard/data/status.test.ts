import { describe, expect, it } from "vitest";
import {
  countThreads,
  isLive,
  isTerminal,
  needsAttention,
  recentOutcomes,
  STATUS_META,
  sortOpenThreads,
} from "./status.ts";
import { ALL_STATUSES, thread } from "./testing.ts";

describe("status groups", () => {
  it("describes every contract status with a sentence-case label, tone and group", () => {
    expect(Object.keys(STATUS_META).sort()).toEqual([...ALL_STATUSES].sort());
    for (const status of ALL_STATUSES) expect(STATUS_META[status].label).toMatch(/^[A-Z][a-z ]+$/);
  });

  it("mirrors the contract's state predicates (crates/contracts/src/threads.rs)", () => {
    expect(ALL_STATUSES.filter(isLive)).toEqual([
      "starting",
      "active",
      "thinking",
      "running_tool",
      "running_command",
      "editing",
      "testing",
      "reviewing",
      "recovering",
    ]);
    expect(ALL_STATUSES.filter(isTerminal)).toEqual(["completed", "failed", "interrupted"]);
    expect(ALL_STATUSES.filter(needsAttention)).toEqual(["waiting_for_permission", "waiting_for_user", "failed"]);
    for (const status of ALL_STATUSES) expect(isLive(status) && isTerminal(status)).toBe(false);
  });

  it("puts terminal statuses, and only those, in the finished group", () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_META[status].group === "finished").toBe(isTerminal(status));
    }
  });

  it("uses distinct tones for needing the user and for working", () => {
    expect(STATUS_META.waiting_for_permission.tone).toBe("waiting");
    expect(STATUS_META.waiting_for_user.tone).toBe("waiting");
    expect(STATUS_META.running_command.tone).toBe("live");
    expect(STATUS_META.failed.tone).toBe("danger");
  });
});

describe("sortOpenThreads", () => {
  it("orders by what the thread needs, then most recent activity; finished threads are excluded", () => {
    const idle = thread({ name: "Idle", status: "idle", lastActivityAt: "2026-09-24T11:00:00Z" });
    const workingOld = thread({ name: "Working old", status: "editing", lastActivityAt: "2026-09-24T10:00:00Z" });
    const workingNew = thread({ name: "Working new", status: "thinking", lastActivityAt: "2026-09-24T10:50:00Z" });
    const approval = thread({
      name: "Approval",
      status: "waiting_for_permission",
      lastActivityAt: "2026-09-24T09:00:00Z",
    });
    const blocked = thread({ name: "Blocked", status: "waiting_for_dependency" });
    const done = thread({ name: "Done", status: "completed" });
    const sorted = sortOpenThreads([idle, workingOld, done, blocked, workingNew, approval]);
    expect(sorted.map((t) => t.name)).toEqual(["Approval", "Working new", "Working old", "Blocked", "Idle"]);
  });

  it("breaks ties by name so the order is stable across refreshes", () => {
    const b = thread({ name: "Beta", status: "active" });
    const a = thread({ name: "Alpha", status: "active" });
    expect(sortOpenThreads([b, a]).map((t) => t.name)).toEqual(["Alpha", "Beta"]);
  });

  it("does not mutate its input", () => {
    const input = [thread({ status: "idle" }), thread({ status: "active" })];
    const copy = [...input];
    sortOpenThreads(input);
    expect(input).toEqual(copy);
  });
});

describe("recentOutcomes", () => {
  it("lists finished threads newest first, capped", () => {
    const items = [
      thread({ name: "Old", status: "completed", lastActivityAt: "2026-09-24T08:00:00Z" }),
      thread({ name: "Failed", status: "failed", lastActivityAt: "2026-09-24T10:00:00Z" }),
      thread({ name: "Stopped", status: "interrupted", lastActivityAt: "2026-09-24T09:00:00Z" }),
      thread({ name: "Open", status: "active" }),
    ];
    expect(recentOutcomes(items).map((t) => t.name)).toEqual(["Failed", "Stopped", "Old"]);
    expect(recentOutcomes(items, 1).map((t) => t.name)).toEqual(["Failed"]);
  });
});

describe("countThreads", () => {
  it("counts runtime truth from statuses and the approval queue", () => {
    const counts = countThreads(
      [
        thread({ status: "running_command" }),
        thread({ status: "recovering" }),
        thread({ status: "waiting_for_user" }),
        thread({ status: "waiting_for_permission", pendingApprovals: 2 }),
        thread({ status: "failed" }),
        thread({ status: "paused" }),
        thread({ status: "idle" }),
        thread({ status: "completed" }),
      ],
      3,
    );
    expect(counts).toEqual({ running: 2, approvals: 3, waitingForUser: 1, failed: 1, idle: 2, completed: 1, open: 6 });
  });
});
