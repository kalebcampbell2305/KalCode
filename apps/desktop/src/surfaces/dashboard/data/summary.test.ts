import type { ApprovalRequest } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { describeRuntime, summarizeRuntime } from "./summary.ts";
import { thread } from "./testing.ts";

const approval = { id: "a" } as ApprovalRequest;
const W2 = "01999a4e-0001-7002-8a2e-000000001002";

describe("summarizeRuntime and describeRuntime", () => {
  it("leads with what needs the user", () => {
    const summary = summarizeRuntime(
      [
        thread({ status: "waiting_for_permission" }),
        thread({ status: "waiting_for_user" }),
        thread({ status: "failed" }),
        thread({ status: "editing", workspaceId: W2 }),
        thread({ status: "thinking" }),
      ],
      [approval, approval],
    );
    expect(describeRuntime(summary)).toBe(
      "2 approvals need you, 1 thread is waiting for your reply and 1 thread failed. 2 threads are working across 2 workspaces.",
    );
    expect(summary.openByGroup).toEqual({ working: 2, attention: 2, resting: 0 });
  });

  it("uses singular forms", () => {
    const summary = summarizeRuntime([thread({ status: "active" })], [approval]);
    expect(describeRuntime(summary)).toBe("1 approval needs you. 1 thread is working.");
  });

  it("is honest when nothing is working or open", () => {
    expect(describeRuntime(summarizeRuntime([thread({ status: "idle" })], []))).toBe("Nothing is working right now.");
    expect(describeRuntime(summarizeRuntime([thread({ status: "completed" })], []))).toBe("No threads are open.");
    expect(describeRuntime(summarizeRuntime([], []))).toBe("No threads are open.");
  });

  it("lists highlights for threads that are not idle, using their activity", () => {
    const summary = summarizeRuntime(
      [
        thread({ name: "A", status: "running_command", currentActivity: "Running npm test" }),
        thread({ name: "B", status: "waiting_for_user" }),
        thread({ name: "C", status: "idle" }),
        thread({ name: "D", status: "completed" }),
      ],
      [],
    );
    expect(summary.highlights).toEqual(["A: Running npm test", "B: Needs your reply"]);
  });

  it("counts running terminals only", () => {
    const base = { workspaceId: "w", shellId: "pwsh", title: "PowerShell", startedAt: null, endedAt: null };
    const summary = summarizeRuntime(
      [],
      [],
      [
        { ...base, id: "t", position: 0, status: "running", exitCode: null },
        { ...base, id: "u", position: 1, status: "exited", exitCode: 0 },
      ],
    );
    expect(summary.runningTerminals).toBe(1);
  });
});
