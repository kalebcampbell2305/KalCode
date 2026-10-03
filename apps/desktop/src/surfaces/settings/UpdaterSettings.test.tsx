import { ToastProvider } from "@kalcode/ui/components";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport } from "../../ipc/memoryTransport.ts";
import type { UpdateStatus } from "../../ipc/updater.ts";
import { RuntimeProvider } from "../../runtime/RuntimeProvider.tsx";
import { UpdaterSettings } from "./UpdaterSettings.tsx";

async function fixture() {
  const client = new KalCodeClient(createMemoryTransport("default"));
  const boot = await client.boot();
  const settings = await client.getSettings();
  return { client, boot, settings };
}

function status(overrides: Partial<UpdateStatus>): UpdateStatus {
  return {
    channel: "stable",
    phase: "idle",
    currentVersion: "0.1.9+1116",
    availableVersion: null,
    downloadedBytes: 0,
    totalBytes: null,
    lastError: null,
    recoveryAvailable: false,
    installOnQuit: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("updater settings", () => {
  it("follows a launch-time background check to its staged result instead of freezing on it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runtime = await fixture();
    let native = status({ phase: "downloading", availableVersion: "0.1.9+1125", downloadedBytes: 10, totalBytes: 100 });
    vi.spyOn(runtime.client, "updaterStatus").mockImplementation(async () => native);
    const cancel = vi.spyOn(runtime.client, "updaterCancel");

    render(
      <ToastProvider>
        <RuntimeProvider client={runtime.client} info={runtime.boot.info} initialSettings={runtime.settings}>
          <UpdaterSettings />
        </RuntimeProvider>
      </ToastProvider>,
    );

    expect(await screen.findByRole("button", { name: "Cancel update check" })).toBeTruthy();

    // Native finishes the background check and stages the build for the next close.
    native = status({ phase: "ready", availableVersion: "0.1.9+1125", installOnQuit: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // A stale Cancel would discard the staged build; it must be gone, and Check usable again.
    expect(screen.queryByRole("button", { name: "Cancel update check" })).toBeNull();
    expect((screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("stops polling once nothing is in flight", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runtime = await fixture();
    const read = vi
      .spyOn(runtime.client, "updaterStatus")
      .mockImplementation(async () => status({ phase: "up_to_date" }));

    render(
      <ToastProvider>
        <RuntimeProvider client={runtime.client} info={runtime.boot.info} initialSettings={runtime.settings}>
          <UpdaterSettings />
        </RuntimeProvider>
      </ToastProvider>,
    );
    await screen.findByRole("button", { name: "Check for updates" });
    const reads = read.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(read.mock.calls.length).toBe(reads);
  });
});
