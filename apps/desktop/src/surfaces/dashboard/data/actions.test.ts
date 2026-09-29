import type { ThreadStatus } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { availableActions, type ThreadAction } from "./actions.ts";
import { isLive, isTerminal } from "./status.ts";
import { ALL_STATUSES } from "./testing.ts";

describe("availableActions", () => {
  it.each<[ThreadStatus, ThreadAction[]]>([
    ["starting", ["open", "stop"]],
    ["running_command", ["open", "interrupt", "stop"]],
    ["recovering", ["open", "stop"]],
    ["waiting_for_permission", ["open", "interrupt", "stop"]],
    ["waiting_for_user", ["open", "archive"]],
    // Includes a launch held for system resources: only Stop cancels the wait.
    ["waiting_for_dependency", ["open", "stop"]],
    ["idle", ["open", "archive"]],
    ["paused", ["open", "resume", "stop"]],
    ["offline", ["open", "resume"]],
    ["completed", ["open", "archive"]],
    ["failed", ["open", "retry", "archive"]],
    ["interrupted", ["open", "resume", "archive"]],
  ])("%s offers %j", (status, expected) => {
    expect(availableActions(status)).toEqual(expected);
  });

  it("always offers Open first", () => {
    for (const status of ALL_STATUSES) expect(availableActions(status)[0]).toBe("open");
  });

  it("never offers an action that is invalid for the state", () => {
    for (const status of ALL_STATUSES) {
      const actions = availableActions(status);
      if (isTerminal(status)) {
        expect(actions).not.toContain("interrupt");
        expect(actions).not.toContain("stop");
      }
      if (isLive(status)) {
        expect(actions).not.toContain("archive");
        expect(actions).not.toContain("resume");
        expect(actions).not.toContain("retry");
      }
      if (status !== "failed") expect(actions).not.toContain("retry");
      // Nothing is running on a quiet open thread: it is archived, never stopped.
      if (status === "idle" || status === "waiting_for_user") expect(actions).not.toContain("stop");
      // A thread is either stopped (something is in progress) or archived, never both.
      expect(actions.includes("stop") && actions.includes("archive")).toBe(false);
      // Resume and Retry both call `thread_resume`; a state never offers both.
      expect(actions.includes("resume") && actions.includes("retry")).toBe(false);
    }
  });
});
