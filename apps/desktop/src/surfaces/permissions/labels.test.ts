import type { PermissionMode } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { startModeFor } from "./labels.ts";

describe("permission start mode", () => {
  it("keeps a saved read-only Plan preference", () => {
    expect(startModeFor("plan")).toBe("plan");
  });

  it.each([null, "approve", "auto", "bypass", "custom"] as const)("starts %s in Bypass: no approvals", (mode) => {
    expect(startModeFor(mode)).toBe("bypass");
  });

  it("never returns a mode the runtime did not offer", () => {
    const offered: readonly PermissionMode[] = ["plan", "approve"];
    expect(startModeFor("bypass", offered)).toBe("approve");
    expect(startModeFor(null, ["plan", "auto"])).toBe("auto");
    expect(startModeFor(null, ["plan"])).toBe("plan");
  });
});
