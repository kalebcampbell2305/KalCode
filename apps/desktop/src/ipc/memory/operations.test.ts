import type { OperationDetail, OperationHistoryPage, OperationsSnapshot, Workspace } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { createOperationsMemory } from "./operations.ts";

const workspace: Workspace = {
  id: "00000000-0000-4000-8000-000000000010",
  name: "kalcode-site",
  rootPath: "C:\\Projects\\kalcode-site",
  displayPath: "~\\Projects\\kalcode-site",
  createdAt: "2026-09-30T12:00:00Z",
  lastOpenedAt: "2026-09-30T12:00:00Z",
  activeTerminalId: null,
  available: true,
};

function setup(empty = false) {
  const memory = createOperationsMemory({ empty, workspaces: [workspace], requireCore: () => undefined });
  const invoke = (command: keyof typeof memory.handlers, args: Record<string, unknown> = {}) => {
    const handler = memory.handlers[command];
    if (!handler) throw new Error(`Missing ${command}`);
    return handler(args);
  };
  return { memory, invoke };
}

describe("Operations memory runtime", () => {
  it("cancels started work with the same identity and a truthful final outcome", () => {
    const { invoke } = setup();
    invoke("operations_pause", { paused: false });
    invoke("operations_run_now", { id: "op-typecheck" });
    invoke("operations_cancel", { id: "op-typecheck" });
    const snapshot = invoke("operations_snapshot") as OperationsSnapshot;
    expect(snapshot.items.find((item) => item.id === "op-typecheck")).toEqual(
      expect.objectContaining({ status: "cancelled", outcome: "Cancelled by you.", endedAt: expect.any(String) }),
    );
  });

  it("keeps fixture process and deployment evidence distinct from verified endpoint health", () => {
    const { invoke } = setup();
    const snapshot = invoke("operations_snapshot") as OperationsSnapshot;
    expect(snapshot.environments.find((environment) => environment.kind === "local")?.health).toBe("process_observed");
    for (const environment of snapshot.environments.filter((item) => item.kind !== "local")) {
      expect(environment.deploymentStatus).toBe("deployed_unverified");
      expect(environment.health).toBe("not_probed");
      expect(environment.variables.every((variable) => variable.present === null)).toBe(true);
    }
    expect(snapshot.activity).not.toContainEqual(
      expect.objectContaining({ runId: "op-typecheck", name: expect.stringMatching(/passed/i) }),
    );

    const preview = invoke("operations_detail", { id: "op-release" }) as OperationDetail;
    expect(preview.run.outcome).toBe("Preview build command completed; endpoint health was not probed.");
    expect(preview.logs).toContain("Endpoint health was not probed");
    expect(`${preview.run.outcome}\n${preview.logs}`).not.toMatch(/health probe passed/i);
  });

  it.each([
    ["cancelling the owning run", "cancel"],
    ["stopping the service", "stop"],
  ] as const)("%s clears process evidence and updates local environment truth", (_label, path) => {
    const { invoke } = setup();
    if (path === "cancel") {
      invoke("operations_cancel", { id: "op-service" });
    } else {
      invoke("operations_service_action", { id: "service-web", action: "stop" });
    }

    const snapshot = invoke("operations_snapshot") as OperationsSnapshot;
    expect(snapshot.items.find((item) => item.id === "op-service")).toEqual(
      expect.objectContaining({ status: "cancelled", outcome: "Cancelled by you.", endedAt: expect.any(String) }),
    );
    expect(snapshot.services.find((service) => service.runId === "op-service")).toEqual(
      expect.objectContaining({
        status: "stopped",
        pid: null,
        processName: "Operation service",
        uptimeSeconds: null,
        ports: [],
        urls: [],
        canStop: false,
        canRestart: true,
        actionReason: "The service is not running, but its Operations command can start it again.",
      }),
    );
    expect(snapshot.environments.find((environment) => environment.kind === "local")).toEqual(
      expect.objectContaining({ deploymentStatus: "stopped", health: "stopped", urls: [], runId: "op-service" }),
    );
    const detail = invoke("operations_detail", { id: "op-service" }) as OperationDetail;
    expect(detail.run.status).toBe("cancelled");
    expect(detail.timeline.at(-1)).toEqual(expect.objectContaining({ kind: "cancelled" }));
    expect(snapshot.activity.at(-1)).toEqual(
      expect.objectContaining({ runId: "op-service", name: "Frontend dev server cancelled" }),
    );
  });

  it("restarts a stopped service under one coherent successor run", () => {
    const { invoke } = setup();
    invoke("operations_service_action", { id: "service-web", action: "stop" });
    invoke("operations_pause", { paused: false });
    invoke("operations_service_action", { id: "service-web", action: "restart" });

    const snapshot = invoke("operations_snapshot") as OperationsSnapshot;
    expect(snapshot.items.find((item) => item.id === "op-service")?.status).toBe("cancelled");
    const successor = snapshot.items.find(
      (item) => item.id !== "op-service" && item.spec.name === "Frontend dev server" && item.status === "running",
    );
    expect(successor).toEqual(
      expect.objectContaining({ source: "operations", startedAt: expect.any(String), terminalId: expect.any(String) }),
    );
    expect(successor?.terminalId).toBe(successor?.id);
    const service = snapshot.services.find((candidate) => candidate.runId === successor?.id);
    expect(service).toEqual(
      expect.objectContaining({
        status: "running",
        pid: expect.any(Number),
        processName: "node",
        ports: [3000],
        urls: ["http://localhost:3000"],
        canStop: true,
        canRestart: true,
        actionReason: null,
      }),
    );
    expect(snapshot.environments.find((environment) => environment.kind === "local")).toEqual(
      expect.objectContaining({
        deploymentStatus: "running",
        health: "process_observed",
        urls: ["http://localhost:3000"],
        runId: successor?.id,
      }),
    );
    expect(invoke("operations_detail", { id: successor?.id }) as OperationDetail).toEqual(
      expect.objectContaining({
        run: expect.objectContaining({ id: successor?.id, status: "running" }),
        timeline: expect.arrayContaining([expect.objectContaining({ kind: "running" })]),
      }),
    );
    expect(snapshot.activity.at(-1)).toEqual(
      expect.objectContaining({ runId: successor?.id, name: "Frontend dev server restarted" }),
    );
  });

  it("moves one identity from Queue to Runs only after the global queue resumes", () => {
    const { invoke } = setup();
    const before = invoke("operations_snapshot") as OperationsSnapshot;
    expect(before.paused).toBe(true);
    expect(before.items.find((item) => item.id === "op-typecheck")?.startedAt).toBeNull();

    expect(() => invoke("operations_run_now", { id: "op-typecheck" })).toThrow(
      expect.objectContaining({ code: "operations_paused" }),
    );
    invoke("operations_pause", { paused: false });
    invoke("operations_run_now", { id: "op-typecheck" });

    const after = invoke("operations_snapshot") as OperationsSnapshot;
    expect(after.paused).toBe(false);
    expect(after.items.find((item) => item.id === "op-typecheck")).toEqual(
      expect.objectContaining({ status: "starting", currentAction: "Starting" }),
    );
    expect(after.activity.at(-1)).toEqual(expect.objectContaining({ runId: "op-typecheck" }));
  });

  it("rejects stale queue order and records a complete accepted order", () => {
    const { memory, invoke } = setup();
    const before = invoke("operations_snapshot") as OperationsSnapshot;
    const pending = before.items
      .filter((item) => item.startedAt === null && ["queued", "paused", "blocked"].includes(item.status))
      .sort((left, right) => left.position - right.position)
      .map((item) => item.id);

    expect(() => invoke("operations_reorder", { ids: pending, revision: before.revision - 1 })).toThrow(
      expect.objectContaining({ code: "stale_operations_revision" }),
    );
    invoke("operations_reorder", { ids: pending.toReversed(), revision: before.revision });
    expect(memory.controls.lastAction()).toBe("reorder");
    expect(
      memory.controls
        .snapshot()
        .items.filter((item) => pending.includes(item.id))
        .sort((left, right) => left.position - right.position)
        .map((item) => item.id),
    ).toEqual(pending.toReversed());
  });

  it("keeps the explicit empty scenario honest", () => {
    const { invoke } = setup(true);
    expect(invoke("operations_snapshot")).toEqual(
      expect.objectContaining({ items: [], services: [], environments: [], activity: [] }),
    );
  });

  it("pages only started history with opaque run cursors", () => {
    const { invoke } = setup();
    const first = invoke("operations_history", { before: null }) as OperationHistoryPage;
    expect(first.items).toHaveLength(2);
    expect(first.items.every((item) => item.startedAt !== null)).toBe(true);
    expect(first.nextCursor).toBe(first.items.at(-1)?.id);

    const second = invoke("operations_history", { before: first.nextCursor }) as OperationHistoryPage;
    expect(second.items.map((item) => item.id)).not.toContain(first.items[0]?.id);
    expect(() => invoke("operations_history", { before: "missing" })).toThrow(
      expect.objectContaining({ code: "invalid_operations_history_cursor" }),
    );
  });
});
