import { describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../ipc/updater.ts";
import { channelOptions, restartAndInstall, updatePresentation } from "./updaterModel.ts";

const base: UpdateStatus = {
  channel: "stable",
  phase: "idle",
  currentVersion: "1.2.3",
  availableVersion: null,
  downloadedBytes: 0,
  totalBytes: null,
  lastError: null,
  recoveryAvailable: false,
};

describe("updatePresentation", () => {
  it("describes verified ready state without implying an automatic restart", () => {
    expect(updatePresentation({ ...base, phase: "ready", availableVersion: "1.2.4" })).toEqual({
      label: "KalCode 1.2.4 is ready",
      detail: "Your work stays open until you choose to restart and install.",
      progress: 100,
    });
  });

  it("presents internal revisions as builds while keeping the public version readable", () => {
    expect(updatePresentation({ ...base, phase: "ready", availableVersion: "0.1.7+218" })).toMatchObject({
      label: "KalCode 0.1.7 build 218 is ready",
    });
    expect(updatePresentation({ ...base, phase: "up_to_date", currentVersion: "0.1.7+217" })).toMatchObject({
      detail: "Version 0.1.7 build 217",
    });
  });

  it("bounds download progress and keeps unknown totals indeterminate", () => {
    expect(updatePresentation({ ...base, phase: "downloading", downloadedBytes: 75, totalBytes: 100 }).progress).toBe(
      75,
    );
    expect(updatePresentation({ ...base, phase: "downloading", downloadedBytes: 150, totalBytes: 100 }).progress).toBe(
      100,
    );
    expect(updatePresentation({ ...base, phase: "downloading", downloadedBytes: 1 }).progress).toBeNull();
  });

  it("surfaces only the native user-safe failure", () => {
    expect(updatePresentation({ ...base, phase: "failed", lastError: "The update signature is invalid." })).toEqual({
      label: "Update check needs attention",
      detail: "The update signature is invalid.",
      progress: null,
    });
  });
});

describe("channelOptions", () => {
  const values = (options: { value: string }[]) => options.map((option) => option.value);

  it("never offers the Dev channel on a Stable build", () => {
    expect(values(channelOptions("stable", "stable"))).toEqual(["stable", "beta"]);
    expect(values(channelOptions("stable", "beta"))).toEqual(["stable", "beta"]);
  });

  it("keeps an already selected Dev channel visible on Stable so the control shows the truth", () => {
    expect(values(channelOptions("stable", "dev"))).toEqual(["stable", "beta", "dev"]);
  });

  it("offers every channel on Beta and Development builds", () => {
    expect(channelOptions("beta", "beta")).toEqual([
      { value: "stable", label: "Stable" },
      { value: "beta", label: "Beta" },
      { value: "dev", label: "Dev" },
    ]);
    expect(values(channelOptions("development", "dev"))).toEqual(["stable", "beta", "dev"]);
  });
});

describe("restartAndInstall", () => {
  it("is the single install path and calls the native install command once", async () => {
    const client = { updaterInstall: vi.fn(async () => undefined) };
    await restartAndInstall(client);
    expect(client.updaterInstall).toHaveBeenCalledOnce();
  });
});
