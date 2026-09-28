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
    // Never final: the next round follows on its own.
    expect(known.detail).toMatch(/retries automatically, and when you return to KalCode/);
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

describe("automatic local intelligence copy", () => {
  it("shows 'Preparing local intelligence (850 MB)…' with progress and a Pause", () => {
    const view = localIntelligence({
      localReasoning: "not_installed",
      provisioning: [
        {
          modelId: "local-reasoning",
          automatic: true,
          phase: "downloading",
          receivedBytes: 100_000_000,
          totalBytes: 850_000_000,
        },
      ],
    });
    expect(view.label).toBe("Preparing local intelligence (850 MB)…");
    expect(view.pausable).toBe(true);
    expect(view.progress).toEqual({ received: 100_000_000, total: 850_000_000 });
    expect(view.detail).toMatch(/Direct commands work now/);
  });

  it("offers Resume only for a paused download", () => {
    const paused = localIntelligence({
      localReasoning: "not_installed",
      provisioning: [{ modelId: "local-reasoning", automatic: true, phase: "paused", receivedBytes: 0, totalBytes: 0 }],
    });
    expect(paused).toMatchObject({ label: "Paused", resumable: true });
    expect(paused.pausable).toBeUndefined();
  });

  it("keeps the manual review path when automatic preparation is off", () => {
    expect(localIntelligence({ localReasoning: "not_installed" }).label).toBe("Not installed");
  });
});
