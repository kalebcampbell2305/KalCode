import type { OperationRecord, OperationSpec, OperationsSnapshot } from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  OperationsClient,
  type OperationsCommandName,
  type OperationsInvoker,
  OperationsIpcError,
} from "./operations.ts";

const spec: OperationSpec = {
  name: "Run checks",
  workspaceId: "workspace-1",
  kind: "test",
  command: "pnpm test",
  prompt: null,
  providerId: null,
  providerAccountId: null,
  model: null,
  effort: null,
  dependencies: [],
  priority: 2,
  lane: "next",
  environment: "local",
  urls: [],
  envKeys: ["CI"],
};

describe("OperationsClient", () => {
  it("sends exact command argument envelopes", async () => {
    const invokeMock = vi.fn(async (_command: OperationsCommandName, _args?: Record<string, unknown>) => undefined);
    const invoke: OperationsInvoker = async <T>(
      command: Parameters<OperationsInvoker>[0],
      args?: Record<string, unknown>,
    ) => invokeMock(command, args) as Promise<T>;
    const client = new OperationsClient(invoke);

    await client.snapshot();
    await client.detail("run-1");
    await client.history();
    await client.history("run-older");
    await client.enqueue(spec);
    await client.update("run-1", spec, 8);
    await client.reorder(["run-2", "run-1"], 9);
    await client.pause(true);
    await client.hold("run-1", true);
    await client.cancel("run-1");
    await client.runNow("run-1");
    await client.serviceAction("service-1", "restart");
    await client.openUrl("http://localhost:3000");

    expect(invokeMock.mock.calls).toEqual([
      ["operations_snapshot", {}],
      ["operations_detail", { id: "run-1" }],
      ["operations_history", { before: null }],
      ["operations_history", { before: "run-older" }],
      ["operations_enqueue", { spec }],
      ["operations_update", { id: "run-1", spec, revision: 8 }],
      ["operations_reorder", { ids: ["run-2", "run-1"], revision: 9 }],
      ["operations_pause", { paused: true }],
      ["operations_hold", { id: "run-1", paused: true }],
      ["operations_cancel", { id: "run-1" }],
      ["operations_run_now", { id: "run-1" }],
      ["operations_service_action", { id: "service-1", action: "restart" }],
      ["operations_open_url", { url: "http://localhost:3000" }],
    ]);
  });

  it("preserves safe native errors and redacts malformed ones", async () => {
    const nativeInvoker: OperationsInvoker = async () => {
      throw { code: "revision_conflict", message: "The queue changed. Refresh and try again." };
    };
    const native = new OperationsClient(nativeInvoker);
    await expect(native.pause(true)).rejects.toEqual(
      expect.objectContaining({ code: "revision_conflict", message: "The queue changed. Refresh and try again." }),
    );

    const malformedInvoker: OperationsInvoker = async () => {
      throw { code: "NO", message: "secret\u0000value" };
    };
    const malformed = new OperationsClient(malformedInvoker);
    await expect(malformed.snapshot()).rejects.toEqual(
      new OperationsIpcError("operations_unavailable", "Operations could not complete that action."),
    );
  });

  it("returns backend records and snapshots without a production fallback", async () => {
    const snapshot = {
      revision: 1,
      paused: true,
      items: [],
      services: [],
      environments: [],
      activity: [],
      observedAt: "2026-09-30T12:00:00Z",
      warnings: [],
    } satisfies OperationsSnapshot;
    const record = { id: "run-1", spec } as OperationRecord;
    const values: unknown[] = [snapshot, record];
    const invoke: OperationsInvoker = async <T>() => values.shift() as T;
    const client = new OperationsClient(invoke);
    await expect(client.snapshot()).resolves.toBe(snapshot);
    await expect(client.enqueue(spec)).resolves.toBe(record);
  });
});
