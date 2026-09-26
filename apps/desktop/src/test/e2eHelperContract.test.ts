import { describe, expect, it } from "vitest";
import helperInventory from "../../scripts/e2e-helpers.json";

describe("native E2E helper inventory", () => {
  it("builds every required sibling for a clean account-bound runtime", () => {
    expect(helperInventory).toEqual([
      {
        package: "kalcode-hook-bridge",
        bin: "kalcode-hook",
        filename: { windows: "kalcode-hook.exe", other: "kalcode-hook" },
      },
      {
        package: "kalcode-providers",
        bin: "kalcode-provider-guardian",
        filename: { windows: "kalcode-provider-guardian.exe", other: "kalcode-provider-guardian" },
      },
      {
        package: "kalcode-providers",
        bin: "kalcode-fake-provider",
        filename: { windows: "kalcode-fake-provider.exe", other: "kalcode-fake-provider" },
      },
    ]);
    expect(new Set(helperInventory.map((helper) => helper.filename.windows)).size).toBe(helperInventory.length);
    expect(new Set(helperInventory.map((helper) => helper.filename.other)).size).toBe(helperInventory.length);
  });
});
