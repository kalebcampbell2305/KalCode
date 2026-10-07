import { describe, expect, it } from "vitest";
import type { LiveStatus } from "../../ipc/liveUpdate.ts";
import { liveUpdateLine } from "./liveUpdateModel.ts";

const base: LiveStatus = {
  phase: "IDLE",
  shellVersion: "0.1.9+1873",
  uiVersion: "0.1.9+1873",
  pendingVersion: null,
  pendingClass: null,
  waitingFor: null,
  lastUpdated: null,
  timings: {
    detectMs: null,
    downloadMs: null,
    verifyMs: null,
    activateMs: null,
    rendererRefreshMs: null,
    coreHandoffMs: null,
    stateRestoreMs: null,
  },
  lastError: null,
};

describe("liveUpdateLine", () => {
  it("says nothing when nothing happened", () => {
    expect(liveUpdateLine(null)).toBeNull();
    expect(liveUpdateLine(base)).toBeNull();
  });

  it("reports a live UI update with its refresh time", () => {
    const line = liveUpdateLine({
      ...base,
      phase: "UPDATED",
      uiVersion: "0.1.9+1900",
      lastUpdated: { version: "0.1.9+1900", class: "ui", at: 1 },
      timings: { ...base.timings, rendererRefreshMs: 840 },
    });
    expect(line?.label).toBe("Updated to 0.1.9 build 1900 without a restart");
    expect(line?.detail).toBe("Applied live in 840 ms. Terminals and agents kept running.");
    expect(line?.tone).toBe("success");
  });

  it("explains why a core update waits instead of interrupting agents", () => {
    const line = liveUpdateLine({
      ...base,
      phase: "STAGED",
      pendingVersion: "0.1.9+1901",
      pendingClass: "core",
      waitingFor: "coding agents are running",
    });
    expect(line?.label).toBe("0.1.9 build 1901 is ready");
    expect(line?.detail).toContain("Waiting because coding agents are running.");
  });

  it("surfaces a rollback", () => {
    const line = liveUpdateLine({ ...base, phase: "ROLLED_BACK", lastError: "The previous one is back." });
    expect(line).toEqual({ label: "Live update", detail: "The previous one is back.", tone: "warning" });
  });

  it("shows a live interface on an older core", () => {
    expect(liveUpdateLine({ ...base, uiVersion: "0.1.9+1900" })?.label).toBe("Interface 0.1.9 build 1900");
  });
});
