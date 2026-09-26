import { describe, expect, it } from "vitest";
import { createUpdaterMemory } from "./updater.ts";

describe("memory updater contract", () => {
  it("defaults to stable and preserves exact closed channel values", async () => {
    const memory = createUpdaterMemory("0.1.5");
    expect(memory.handlers.updater_status?.({})).toMatchObject({
      channel: "stable",
      currentVersion: "0.1.5",
      phase: "idle",
    });
    expect(memory.handlers.updater_set_channel?.({ channel: "beta" })).toMatchObject({
      channel: "beta",
      phase: "idle",
    });
    expect(() => memory.handlers.updater_set_channel?.({ channel: "preview" })).toThrow();
  });

  it("reports up to date after a check and refuses unverified install or recovery", () => {
    const memory = createUpdaterMemory("0.1.5");
    expect(memory.handlers.updater_check?.({})).toMatchObject({ phase: "up_to_date" });
    expect(() => memory.handlers.updater_install?.({})).toThrow();
    expect(() => memory.handlers.updater_restore_previous?.({})).toThrow();
  });

  it("cancels a background check without changing the selected channel", () => {
    const memory = createUpdaterMemory("0.1.5");
    memory.handlers.updater_set_channel?.({ channel: "beta" });

    expect(memory.handlers.updater_cancel?.({})).toMatchObject({
      channel: "beta",
      phase: "idle",
      downloadedBytes: 0,
      totalBytes: null,
    });
  });
});
