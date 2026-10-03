import type { PermissionMode } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { startModeFor } from "./labels.ts";

describe("permission start mode", () => {
  it.each(["plan", "approve", "auto"] as const)("preserves an explicit %s preference", (mode) => {
    expect(startModeFor(mode)).toBe(mode);
  });

  it("uses Auto only for a fresh install", () => {
    expect(startModeFor(null)).toBe("auto");
  });

  it.each(["custom", "bypass"] as const)("keeps an unstartable %s preference on Approve", (mode) => {
    expect(startModeFor(mode)).toBe("approve");
  });

  it("never returns a mode the runtime did not offer", () => {
    const offered: readonly PermissionMode[] = ["plan", "approve"];
    expect(startModeFor("bypass", offered)).toBe("approve");
    expect(startModeFor(null, ["plan"])).toBe("plan");
  });
});
