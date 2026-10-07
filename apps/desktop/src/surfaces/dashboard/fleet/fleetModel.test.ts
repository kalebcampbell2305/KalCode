import type { ThreadStatus, ThreadWorktreeState } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { thread } from "../data/testing.ts";
import { fleetStage, fleetSummary, mergeReadiness } from "./fleetModel.ts";

function facts(overrides: Partial<ThreadWorktreeState> = {}): ThreadWorktreeState {
  return {
    threadId: "t",
    worktreeId: "w",
    branch: "kal/agent-1234abcd",
    baseBranch: "main",
    ahead: 2,
    behind: 0,
    changed: 0,
    untracked: 0,
    conflicts: false,
    changedPaths: [],
    changedPathsTruncated: false,
    observedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("mergeReadiness", () => {
  const isolated = (status: ThreadStatus) => thread({ status, worktreeId: "w", branch: "kal/agent-1234abcd" });

  it("is ready only when every fact is observed", () => {
    expect(mergeReadiness(isolated("completed"), facts())).toEqual({ ready: true, ahead: 2, base: "main" });
    expect(mergeReadiness(isolated("idle"), facts())).toMatchObject({ ready: true });
  });

  it("explains why it isn't ready", () => {
    expect(mergeReadiness(thread({ status: "completed" }), facts())).toMatchObject({ ready: false });
    expect(mergeReadiness(isolated("completed"), undefined)).toMatchObject({ reason: "Checking the worktree…" });
    expect(mergeReadiness(isolated("editing"), facts())).toMatchObject({ reason: "Still working" });
    expect(mergeReadiness(isolated("waiting_for_user"), facts())).toMatchObject({ reason: "Waiting for you" });
    expect(mergeReadiness(isolated("failed"), facts())).toMatchObject({ reason: "The run failed" });
    expect(mergeReadiness(isolated("completed"), facts({ changed: 2, untracked: 1 }))).toMatchObject({
      reason: "3 uncommitted changes",
    });
    expect(mergeReadiness(isolated("completed"), facts({ ahead: 0 }))).toMatchObject({ reason: "No commits yet" });
    expect(mergeReadiness(isolated("completed"), facts({ ahead: null }))).toMatchObject({ ready: false });
    expect(mergeReadiness(isolated("completed"), facts({ conflicts: true }))).toMatchObject({
      reason: "Would conflict with main",
    });
    expect(mergeReadiness(isolated("completed"), facts({ conflicts: null }))).toMatchObject({ ready: false });
  });

  it("follows the shared agent state, so a card never says Ready to merge for a failed or waiting agent", () => {
    // Idle after a failed turn: FAILED on the Fleet, the rail and Needs You.
    const failedTurn = thread({ status: "idle", currentActivity: "Last turn failed", worktreeId: "w" });
    expect(mergeReadiness(failedTurn, facts())).toEqual({ ready: false, reason: "The run failed" });
    // A pending approval on an otherwise quiet agent: NEEDS YOU everywhere.
    const approval = thread({ status: "idle", pendingApprovals: 1, worktreeId: "w" });
    expect(mergeReadiness(approval, facts())).toEqual({ ready: false, reason: "Waiting for you" });
    // Recovering is STARTING, not done.
    expect(mergeReadiness(isolated("recovering"), facts())).toMatchObject({ reason: "Still working" });
    expect(mergeReadiness(isolated("waiting_for_dependency"), facts())).toMatchObject({ reason: "Blocked" });
  });
});

describe("fleetStage and summary", () => {
  it("leads with the stage that matters", () => {
    const ready = mergeReadiness(thread({ status: "completed", worktreeId: "w" }), facts());
    expect(fleetStage(thread({ status: "completed", worktreeId: "w" }), ready)).toBe("ready_to_merge");
    const notReady = { ready: false as const, reason: "x" };
    expect(fleetStage(thread({ status: "testing" }), notReady)).toBe("testing");
    expect(fleetStage(thread({ status: "waiting_for_permission" }), notReady)).toBe("needs_you");
    expect(fleetStage(thread({ status: "failed" }), notReady)).toBe("failed");
    expect(fleetStage(thread({ status: "running_command" }), notReady)).toBe("working");
    expect(fleetStage(thread({ status: "completed" }), notReady)).toBe("done");
  });

  it("summarizes the fleet with real counts", () => {
    expect(fleetSummary(["working", "testing", "ready_to_merge", "needs_you", "needs_you", "idle"])).toBe(
      "6 agents · 2 working · 1 ready to merge · 2 need you",
    );
    expect(fleetSummary(["idle"])).toBe("1 agent");
  });
});
