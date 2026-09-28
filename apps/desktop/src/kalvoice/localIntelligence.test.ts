import { describe, expect, it } from "vitest";
import { localIntelligence } from "./localIntelligence.ts";

describe("local intelligence status copy", () => {
  it("names each governor hold without offering a retry", () => {
    for (const [issue, label] of [
      ["resource_monitor_starting", "Waiting for resource readings"],
      ["memory_headroom", "Waiting for memory headroom"],
      ["cpu_headroom", "Waiting for CPU headroom"],
      ["resource_pressure", "Waiting for system pressure to ease"],
      ["something_new", "Waiting for capacity"],
    ] as const) {
      const view = localIntelligence({ localReasoning: "waiting", localReasoningIssue: issue });
      expect(view.label).toBe(label);
      expect(view.retry).toBe(false);
      expect(view.detail).toMatch(/Direct commands remain available/);
    }
  });

  it("shows the failure code and offers a retry", () => {
    const known = localIntelligence({ localReasoning: "failed", localReasoningIssue: "capacity_wait_exhausted" });
    expect(known.label).toBe("Couldn't start: capacity_wait_exhausted");
    expect(known.detail).toMatch(/waited 15 minutes/);
    expect(known.retry).toBe(true);
    const unknown = localIntelligence({ localReasoning: "failed", localReasoningIssue: "worker_rejected" });
    expect(unknown.detail).toMatch(/Startup failed \(worker_rejected\)/);
    expect(localIntelligence({ localReasoning: "failed" }).label).toBe("Couldn't start");
  });

  it("keeps the existing states and treats a missing status as unavailable", () => {
    expect(localIntelligence({ localReasoning: "installed" }).label).toBe("Installed; not running");
    expect(localIntelligence({ localReasoning: "ready" }).retry).toBe(false);
    expect(localIntelligence(null).label).toBe("Unavailable");
  });
});
