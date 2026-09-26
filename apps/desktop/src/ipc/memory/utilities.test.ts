import { describe, expect, it } from "vitest";
import { MemoryUtilityApi } from "./utilities.ts";

describe("MemoryUtilityApi", () => {
  it("defaults to truthful, effect-free unavailable and empty states", async () => {
    const api = new MemoryUtilityApi();

    await expect(api.status()).resolves.toEqual({ persistent: false, portSource: null });
    await expect(api.processes("related")).resolves.toMatchObject({
      processes: [],
      total: 0,
      hidden: 0,
      cpuReady: false,
    });
    await expect(api.ports()).resolves.toMatchObject({ ports: [], source: "unavailable" });
    expect(api.calls.httpSend).toEqual([]);
    expect(api.calls.processSignal).toEqual([]);
  });

  it("records the exact consequential request before delegating to an override", async () => {
    const api = new MemoryUtilityApi({
      processSignal: async () => ({ kind: "awaiting_approval", approvalId: "approval-1" }),
      effectContinue: async () => ({
        kind: "process_completed",
        result: { pid: 42, signal: "terminate", outcome: "stopped", message: "Stopped." },
      }),
    });
    const input = {
      pid: 42,
      startTime: "1700000000",
      signal: "terminate" as const,
    };

    await expect(api.processSignal(input)).resolves.toEqual({ kind: "awaiting_approval", approvalId: "approval-1" });
    await expect(api.effectContinue("approval-1")).resolves.toMatchObject({ kind: "process_completed" });
    expect(api.calls.processSignal).toEqual([input]);
    expect(api.calls.effectContinue).toEqual(["approval-1"]);
  });

  it("keeps scratchpad CRUD deterministic without touching a durable store", async () => {
    const api = new MemoryUtilityApi();
    const created = await api.scratchpadSave({
      id: null,
      workspaceId: "workspace-1",
      title: "Release checks",
      content: "Run the bounded probes.",
    });

    await expect(api.scratchpads("workspace-1")).resolves.toEqual({
      items: [created],
      persistent: false,
    });
    await api.scratchpadDelete(created.id);
    await expect(api.scratchpads("workspace-1")).resolves.toEqual({
      items: [],
      persistent: false,
    });
  });
});
