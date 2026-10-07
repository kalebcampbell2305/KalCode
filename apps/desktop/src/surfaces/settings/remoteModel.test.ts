import { describe, expect, it } from "vitest";
import type { RemoteStatus } from "../../ipc/remote.ts";
import { countdown, deviceDetail, isTablet, remoteSummary, remoteVisible } from "./remoteModel.ts";

const base: RemoteStatus = {
  available: true,
  enabled: true,
  listening: true,
  port: 47820,
  addresses: ["192.168.1.20:47820"],
  error: null,
  machineName: "Desk",
  pairing: null,
  devices: [],
};

describe("Remote settings model", () => {
  it("shows Remote to MAX and up, where the plan includes it", () => {
    const shipped = [{ id: "remote", state: "available", visible: true }];
    for (const tier of ["max", "max2x", "owner"] as const) expect(remoteVisible(shipped, tier)).toBe(true);
    for (const tier of ["free", "pro"] as const) expect(remoteVisible(shipped, tier)).toBe(false);
    expect(remoteVisible([{ id: "remote", state: "gated", visible: true }], "owner")).toBe(false);
    expect(remoteVisible([], "owner")).toBe(false);
  });

  it("says honestly whether devices can connect", () => {
    expect(remoteSummary({ ...base, enabled: false })).toEqual({
      tone: "off",
      text: "Off. No device can connect to this computer.",
    });
    expect(remoteSummary(base)).toEqual({ tone: "listening", text: "Listening on 1 address" });
    expect(
      remoteSummary({
        ...base,
        addresses: ["a:1", "b:1"],
        devices: [
          {
            id: "d",
            name: "P",
            platform: "ios",
            model: "iPhone17,1",
            app: "",
            pairedAt: "",
            lastSeenAt: null,
            online: true,
          },
        ],
      }).text,
    ).toBe("Listening on 2 addresses · 1 device connected");
    const portBusy = { code: "ports_in_use", message: "Ports 47820–47829 are all in use." };
    expect(remoteSummary({ ...base, listening: false, error: portBusy })).toEqual({
      tone: "failed",
      text: "Ports 47820–47829 are all in use.",
    });
    expect(remoteSummary({ ...base, addresses: [] }).tone).toBe("failed");
  });

  it("counts down to the pairing code's expiry", () => {
    expect(countdown(1_000_300, 1_000_000_000)).toBe("5:00");
    expect(countdown(1_000_300, 1_000_052_500)).toBe("4:08");
    expect(countdown(1_000_300, 1_000_400_000)).toBe("0:00");
  });

  it("describes devices without raw identifiers alone", () => {
    expect(deviceDetail({ platform: "ios", model: "iPhone17,1", app: "1.0 (1)" })).toBe(
      "iPhone · iOS · KalCode 1.0 (1)",
    );
    expect(deviceDetail({ platform: "android", model: "Pixel 9", app: "" })).toBe("Pixel 9 · Android");
    expect(isTablet({ model: "iPad16,3" })).toBe(true);
    expect(isTablet({ model: "iPhone17,1" })).toBe(false);
  });
});
