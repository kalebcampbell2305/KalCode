import { LAST_TURN_FAILED_ACTIVITY } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { ALL_STATUSES, thread } from "../../surfaces/dashboard/data/testing.ts";
import { isWorking, needsYou } from "./rail.ts";

describe("rail counts use the shared agent state (native rail::is_working / needs_you)", () => {
  it("counts starting, working and testing as working, never a wait on a dependency", () => {
    const working = ALL_STATUSES.filter((status) => isWorking(thread({ status })));
    expect(working.sort()).toEqual(
      [
        "active",
        "editing",
        "recovering",
        "reviewing",
        "running_command",
        "running_tool",
        "starting",
        "testing",
        "thinking",
      ].sort(),
    );
  });

  it("counts approvals and replies as needing you, never a failure", () => {
    const needs = ALL_STATUSES.filter((status) => needsYou(thread({ status })));
    expect(needs.sort()).toEqual(["waiting_for_permission", "waiting_for_user"]);
    expect(needsYou(thread({ status: "failed" }))).toBe(false);
    expect(needsYou(thread({ status: "idle", currentActivity: LAST_TURN_FAILED_ACTIVITY }))).toBe(false);
  });

  it("counts a pending approval on a live agent as needing you (not working)", () => {
    const blocked = thread({ status: "running_tool", pendingApprovals: 1 });
    expect(needsYou(blocked)).toBe(true);
    expect(isWorking(blocked)).toBe(false);
    expect(needsYou(thread({ status: "completed", pendingApprovals: 1 }))).toBe(false);
  });
});
