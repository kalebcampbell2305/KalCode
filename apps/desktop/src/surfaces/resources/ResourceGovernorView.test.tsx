import type { ResourceSnapshot } from "@kalcode/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ResourceReport } from "../../ipc/resources.ts";
import { ResourceGovernorContent } from "./ResourceGovernorView.tsx";

function report(): ResourceReport {
  const snapshot: ResourceSnapshot = {
    seq: 7,
    sampledAtUnixMs: Date.now() - 1_000,
    mode: "balanced",
    cpu: {
      state: "value",
      detail: { totalPercent: 18, smoothedPercent: 20, logicalCores: 8 },
    },
    memory: {
      state: "value",
      detail: {
        totalBytes: 16 * 1024 ** 3,
        availableBytes: 10 * 1024 ** 3,
        usedBytes: 6 * 1024 ** 3,
        usedPercent: 37.5,
        smoothedUsedPercent: 37.5,
        smoothedAvailableBytes: 10 * 1024 ** 3,
        commit: { state: "unavailable", detail: "not exposed on this platform" },
      },
    },
    volumes: { state: "unknown", detail: "no workspace roots are registered" },
    diskIo: { state: "unknown", detail: "warming up" },
    network: { state: "unknown", detail: "not sampled yet" },
    processCount: { state: "value", detail: 321 },
    kalcodeTree: { state: "unknown", detail: "not sampled yet" },
    gpu: { state: "unavailable", detail: "GPU metrics are not available in this build" },
    pressure: {
      entries: [
        {
          resource: "cpu",
          level: "normal",
          signal: { signal: "cpu_percent" },
          value: 20,
          threshold: null,
          approaching: false,
        },
        {
          resource: "memory",
          level: "normal",
          signal: { signal: "memory_used_percent" },
          value: 37.5,
          threshold: null,
          approaching: false,
        },
      ],
      unknown: ["disk_space"],
    },
    sampling: {
      refreshed: { fast: true, slow: false, processes: false, inventory: false },
      nextIntervalMs: 1_000,
      reason: "resource_view_open",
      consecutiveFailures: 0,
    },
  };
  return {
    status: { state: "running" },
    snapshot,
    history: [],
    transitions: [],
    stats: {
      samples: 7,
      failedSamples: 0,
      slowTierSamples: 2,
      processTierSamples: 1,
      totalProbeMs: 20,
      lastProbeMs: 2,
      maxProbeMs: 5,
      maxProcessTierMs: 5,
      droppedUpdates: 0,
    },
    capacity: {
      mode: "balanced",
      additional: 3,
      holds: [],
      constraints: [],
      perProvider: [],
      data: { kind: "partial", unknown: ["disk_space"] },
      notes: [],
    },
    admission: {
      state: "allowed",
      mode: "balanced",
      additional: 4_294_967_295,
      reasons: [],
      snapshotSeq: 7,
      sampledAtUnixMs: snapshot.sampledAtUnixMs,
    },
    backgroundAdmission: {
      state: "allowed",
      mode: "balanced",
      additional: 3,
      reasons: [],
      snapshotSeq: 7,
      sampledAtUnixMs: snapshot.sampledAtUnixMs,
    },
    freshness: {
      state: "fresh",
      ageMs: 1_000,
      maxAgeMs: 5_000,
      detail: "The latest resource sample is current.",
    },
  };
}

describe("ResourceGovernorContent", () => {
  it("shows measured values while preserving unknown and unavailable states", () => {
    const current = report();
    current.snapshot.diskIo = {
      state: "value",
      detail: { readBytesPerSec: 1_536, writeBytesPerSec: 5 * 1024 ** 2 },
    };
    current.snapshot.network = {
      state: "value",
      detail: { rxBytesPerSec: 2_048, txBytesPerSec: 512 },
    };
    current.snapshot.kalcodeTree = {
      state: "value",
      detail: {
        processes: [],
        truncated: false,
        totalCpuPercent: 3.5,
        totalRssBytes: 512 * 1024 ** 2,
        providerSessions: [],
      },
    };
    render(<ResourceGovernorContent report={current} changingMode={false} onModeChange={vi.fn()} />);

    expect(screen.getByRole("list", { name: "Resource governor state" })).toBeVisible();
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(screen.getByText("37.5%")).toBeInTheDocument();
    expect(screen.getByText("1.5 KiB/s read · 5 MiB/s write")).toBeInTheDocument();
    expect(screen.getByText("2 KiB/s received · 512 B/s sent")).toBeInTheDocument();
    expect(screen.getByText("512 MiB memory · 3.5% CPU")).toBeInTheDocument();
    expect(screen.getByText("GPU metrics are not available in this build")).toBeInTheDocument();
    expect(screen.getByText(/Disk space has no current reading\./)).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("uses the existing mode control vocabulary and forwards an explicit selection", () => {
    const onModeChange = vi.fn();
    render(<ResourceGovernorContent report={report()} changingMode={false} onModeChange={onModeChange} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Resource mode" }), {
      target: { value: "performance" },
    });

    expect(onModeChange).toHaveBeenCalledWith("performance");
  });

  it("says coding agents start immediately under CPU load while background work yields", () => {
    const busy = report();
    busy.backgroundAdmission = {
      ...busy.backgroundAdmission,
      state: "held",
      additional: 0,
      reasons: [{ kind: "snapshot_stale", ageMs: 6_000, maxAgeMs: 5_000 }],
    };
    render(<ResourceGovernorContent report={busy} changingMode={false} onModeChange={vi.fn()} />);

    expect(screen.getByText("New coding agents start immediately")).toBeInTheDocument();
    expect(screen.getByText(/CPU load never delays an agent you start/)).toBeInTheDocument();
    expect(screen.getByText("Background work is yielding")).toBeInTheDocument();
    expect(screen.getByText(/Running work continues/)).toBeInTheDocument();
    expect(screen.queryByText(/CPU busy/)).not.toBeInTheDocument();
  });

  it("shows the real reason when hard pressure holds new coding agents", () => {
    const held = report();
    held.admission = {
      ...held.admission,
      state: "held",
      additional: 0,
      reasons: [{ kind: "hard_pressure", pressure: { kind: "memory_critical", availableMb: 412, floorMb: 634 } }],
    };
    render(<ResourceGovernorContent report={held} changingMode={false} onModeChange={vi.fn()} />);

    expect(screen.getByText("New coding agents are waiting")).toBeInTheDocument();
    expect(screen.getByText(/Memory is critically low \(412 MB free\)/)).toBeInTheDocument();
    expect(screen.getByText(/Start Anyway/)).toBeInTheDocument();
  });

  it("shows a selected mode while waiting for its first matching sample", () => {
    const pending = report();
    pending.backgroundAdmission = {
      ...pending.backgroundAdmission,
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
    };
    render(<ResourceGovernorContent report={pending} changingMode={false} onModeChange={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: "Resource mode" })).toHaveValue("performance");
    expect(screen.getByText("Waiting for a resource sample in performance mode…")).toBeInTheDocument();
  });
});
