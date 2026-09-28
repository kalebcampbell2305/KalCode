import { describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../ipc/updater.ts";
import { restartAndInstall, updatePresentation } from "./updaterModel.ts";

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

describe("restartAndInstall", () => {
  it("is the single install path and calls the native install command once", async () => {
    const client = { updaterInstall: vi.fn(async () => undefined) };
    await restartAndInstall(client);
    expect(client.updaterInstall).toHaveBeenCalledOnce();
  });
});
