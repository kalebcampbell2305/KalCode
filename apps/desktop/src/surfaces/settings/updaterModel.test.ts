import { describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../ipc/updater.ts";
import { channelOptions, installsWhenClosed, restartAndInstall, updatePresentation } from "./updaterModel.ts";

const base: UpdateStatus = {
  channel: "stable",
  phase: "idle",
  currentVersion: "1.2.3",
  availableVersion: null,
  downloadedBytes: 0,
  totalBytes: null,
  lastError: null,
  recoveryAvailable: false,
  installOnQuit: false,
};

describe("updatePresentation", () => {
  it("describes verified ready state without implying an automatic restart", () => {
    expect(updatePresentation({ ...base, phase: "ready", availableVersion: "1.2.4" })).toEqual({
      label: "KalCode 1.2.4 is ready",
      detail: "Your work stays open until you choose to restart and install.",
      progress: 100,
    });
  });

  it("names a new build of the same public version by its build number", () => {
    const current = { ...base, currentVersion: "0.1.7" };
    expect(updatePresentation({ ...current, phase: "ready", availableVersion: "0.1.7+780" }).label).toBe(
      "A new KalCode 0.1.7 build is ready (build 780)",
    );
    expect(updatePresentation({ ...current, phase: "ready", availableVersion: "0.1.8+900" }).label).toBe(
      "KalCode 0.1.8 build 900 is ready",
    );
    expect(updatePresentation({ ...current, phase: "downloading", availableVersion: "0.1.7+780" }).label).toBe(
      "Downloading KalCode 0.1.7 build 780",
    );
    expect(updatePresentation({ ...base, phase: "up_to_date", currentVersion: "0.1.7+780" }).detail).toBe(
      "Version 0.1.7 build 780",
    );
    expect(updatePresentation({ ...base, currentVersion: "0.1.7+780" }).label).toBe("KalCode 0.1.7 build 780");
  });

  it("says a new build of the running public version installs when KalCode closes", () => {
    const current = { ...base, currentVersion: "0.1.8", phase: "ready" as const, availableVersion: "0.1.8+780" };
    expect(updatePresentation({ ...current, installOnQuit: true })).toEqual({
      label: "A new KalCode 0.1.8 build is ready (build 780)",
      detail: "Installs when you close KalCode.",
      progress: 100,
    });
    expect(updatePresentation(current).detail).toBe("Getting ready to install when you close KalCode.");
    expect(installsWhenClosed(current)).toBe(true);
    // A new public version keeps the restart-and-install prompt.
    const next = { ...current, availableVersion: "0.1.9+801" };
    expect(installsWhenClosed(next)).toBe(false);
    expect(updatePresentation(next).detail).toBe("Your work stays open until you choose to restart and install.");
    expect(installsWhenClosed({ ...base, phase: "ready" })).toBe(false);
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
