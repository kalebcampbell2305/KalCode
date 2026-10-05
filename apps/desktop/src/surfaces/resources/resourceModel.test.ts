import type { Reading, ResourcePressure } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import type { ResourceAdmissionDecision, ResourceFreshness } from "../../ipc/resources.ts";
import {
  admissionSummary,
  backgroundAdmissionSummary,
  formatBytes,
  freshnessSummary,
  pressureSummary,
  readingSummary,
} from "./resourceModel.ts";

describe("resource model", () => {
  it("never turns unknown telemetry into a zero measurement", () => {
    const unknown: Reading<{ smoothedPercent: number }> = { state: "unknown", detail: "warming up" };

    expect(readingSummary<{ smoothedPercent: number }>(unknown, (value) => `${value.smoothedPercent}%`)).toEqual({
      label: "Unknown",
      detail: "warming up",
      state: "unknown",
    });
  });

  it("keeps unsupported telemetry distinct from temporarily unknown telemetry", () => {
    const unavailable: Reading<number> = { state: "unavailable", detail: "not exposed on this platform" };

    expect(readingSummary(unavailable, String)).toEqual({
      label: "Unavailable",
      detail: "not exposed on this platform",
      state: "unavailable",
    });
  });

  it("reports the worst known pressure and names unknown resources separately", () => {
    const entries: ResourcePressure[] = [
      {
        resource: "cpu",
        level: "elevated",
        signal: { signal: "cpu_percent" },
        value: 70,
        threshold: 65,
        approaching: false,
      },
      {
        resource: "memory",
        level: "high",
        signal: { signal: "memory_available_mb" },
        value: 900,
        threshold: 1_024,
        approaching: false,
      },
    ];

    expect(pressureSummary({ entries, unknown: ["disk_space"] })).toEqual({
      level: "high",
      label: "High pressure",
      detail: "Memory is limiting new work. Disk space has no current reading.",
    });
  });

  it("describes stale and unavailable freshness without claiming a live sample", () => {
    const stale: ResourceFreshness = {
      state: "stale",
      ageMs: 55_000,
      maxAgeMs: 45_000,
      detail: "The latest sample is older than the current safety window.",
    };
    const unavailable: ResourceFreshness = {
      state: "unavailable",
      ageMs: null,
      maxAgeMs: 45_000,
      detail: "The sampler has not produced a reading yet.",
    };

    expect(freshnessSummary(stale)).toEqual({ label: "Stale", tone: "warning" });
    expect(freshnessSummary(unavailable)).toEqual({ label: "No current sample", tone: "danger" });
  });

  it("never says a coding agent waits for CPU: agents start, background work yields", () => {
    const agents: ResourceAdmissionDecision = {
      state: "allowed",
      mode: "balanced",
      additional: 4_294_967_295,
      reasons: [],
      snapshotSeq: 7,
      sampledAtUnixMs: 1_800_000_000_000,
    };
    expect(admissionSummary(agents)).toEqual({
      label: "New coding agents start immediately",
      detail: "CPU load never delays an agent you start; KalCode slows optional background work instead.",
      tone: "success",
    });
    expect(admissionSummary({ ...agents, additional: 2 }).detail).toBe("2 more agents fit your Custom limit.");

    const background: ResourceAdmissionDecision = {
      ...agents,
      state: "held",
      additional: 0,
      reasons: [{ kind: "snapshot_stale", ageMs: 55_000, maxAgeMs: 45_000 }],
    };
    expect(backgroundAdmissionSummary(background)).toEqual({
      label: "Background work is yielding",
      detail: "Waiting for a current resource sample.",
      tone: "warning",
    });
  });

  it("names the real hard-pressure reason when coding agents are held", () => {
    const held: ResourceAdmissionDecision = {
      state: "held",
      mode: "balanced",
      additional: 0,
      reasons: [{ kind: "hard_pressure", pressure: { kind: "disk_full", mount: "C:\\", freeMb: 600, floorMb: 1_024 } }],
      snapshotSeq: 7,
      sampledAtUnixMs: 1_800_000_000_000,
    };
    expect(admissionSummary(held)).toEqual({
      label: "New coding agents are waiting",
      detail: "The disk is almost full (600 MB free on C:\\). Start Anyway is available on each waiting agent.",
      tone: "warning",
    });
  });

  it("keeps background work paused until the selected mode has a matching sample", () => {
    const held = {
      state: "held",
      mode: "performance",
      additional: 0,
      reasons: [
        {
          kind: "snapshot_mode_mismatch",
          snapshotMode: "balanced",
          activeMode: "performance",
        },
      ],
      snapshotSeq: 8,
      sampledAtUnixMs: 1_800_000_000_000,
    } as unknown as ResourceAdmissionDecision;

    expect(backgroundAdmissionSummary(held)).toEqual({
      label: "Background work is yielding",
      detail: "Waiting for a resource sample under the selected mode.",
      tone: "warning",
    });
  });

  it("formats bytes with stable binary units and no false precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1_536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5 GiB");
  });
});
