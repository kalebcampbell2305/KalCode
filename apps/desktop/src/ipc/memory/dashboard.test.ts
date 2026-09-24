import type { EventEnvelope } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { ACTION_LABELS, availableActions, type ThreadAction } from "../../surfaces/dashboard/data/actions.ts";
import { KalCodeClient } from "../client.ts";
import { COMMAND_UNAVAILABLE, isCommandUnavailable, toKalCodeError } from "../errors.ts";
import { createMemoryTransport } from "../memoryTransport.ts";
import { isValidId } from "./dashboard.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

async function recorder(client: KalCodeClient) {
  const events: EventEnvelope[] = [];
  await client.subscribeEvents((e) => events.push(e));
  return events;
}

describe("commands missing from this build", () => {
  it("maps Tauri's rejections for unregistered commands to command_unavailable", () => {
    for (const raw of [
      "Command thread_list not allowed by ACL",
      "thread_list not allowed. Command not found",
      "Command thread_list not found",
    ]) {
      const error = toKalCodeError(raw, "thread_list");
      expect(error.code).toBe(COMMAND_UNAVAILABLE);
      expect(isCommandUnavailable(error)).toBe(true);
    }
  });

  it("does not mistake other failures, or another command's rejection, for a missing command", () => {
    expect(toKalCodeError("Command approval_list not allowed by ACL", "thread_list").code).toBe("ipc_rejected");
    expect(toKalCodeError("invalid args `threadId` for command `thread_stop`", "thread_stop").code).toBe(
      "ipc_rejected",
    );
    expect(toKalCodeError("thread_list not allowed by ACL").code).toBe("ipc_rejected");
  });

  it("is what the default (native-equivalent) transport reports for every Dashboard command", async () => {
    const client = new KalCodeClient(createMemoryTransport("default"));
    const calls = [
      client.listThreads(),
      client.listApprovals(),
      client.decideApproval("01999a4e-0004-7001-8a2e-000000004001", "deny"),
      client.stopThread("01999a4e-0002-7001-8a2e-000000002001"),
    ];
    for (const call of calls) await expect(call).rejects.toMatchObject({ code: COMMAND_UNAVAILABLE });
    // Terminals are native since Z1: nothing runs in a fresh session.
    await expect(client.runningTerminals()).resolves.toEqual([]);
  });
});

describe("busy fixtures", () => {
  it("are consistent: canonical ids, approval counters match the queue, statuses match approvals", async () => {
    const client = new KalCodeClient(createMemoryTransport("busy"));
    const [threads, approvals, terminals] = await Promise.all([
      client.listThreads(),
      client.listApprovals(),
      client.runningTerminals(),
    ]);
    expect(threads.length).toBeGreaterThanOrEqual(10);
    expect(new Set(threads.map((t) => t.providerId))).toEqual(new Set(["claude-code", "codex", "gemini-cli"]));
    expect(approvals.length).toBe(2);
    expect(terminals.every((t) => t.status === "running")).toBe(true);
    for (const t of threads) {
      expect(isValidId(t.id)).toBe(true);
      const pending = approvals.filter((a) => a.action.threadId === t.id).length;
      expect(t.pendingApprovals).toBe(pending);
      if (pending > 0) expect(t.status).toBe("waiting_for_permission");
    }
    for (const a of approvals) {
      expect(isValidId(a.id)).toBe(true);
      expect(a.status).toBe("pending");
    }
  });

  it("records history so the activity feed has real events", async () => {
    const client = new KalCodeClient(createMemoryTransport("busy"));
    const types = (await client.recentEvents(100)).map((e) => e.type);
    expect(types).toContain("approval.requested");
    expect(types).toContain("thread.failed");
    expect(types.at(-1)).toBe("database.migrated");
  });
});

describe("approval_decide", () => {
  it("approving resolves the request, resumes the thread and records events", async () => {
    const client = new KalCodeClient(createMemoryTransport("busy"));
    const events = await recorder(client);
    const [first] = await client.listApprovals();
    if (!first) throw new Error("fixture has approvals");
    const resolved = await client.decideApproval(first.id, "approve_once");
    expect(resolved).toMatchObject({ status: "approved", resolvedDecision: "approve_once" });
    await tick();
    expect(events.map((e) => e.type)).toEqual(["approval.approved", "thread.status_changed"]);
    expect(events[0]?.correlation.requestId).toBe(first.id);
    const thread = (await client.listThreads()).find((t) => t.id === first.action.threadId);
    expect(thread?.pendingApprovals).toBe(0);
    expect(thread?.status).not.toBe("waiting_for_permission");
    expect((await client.listApprovals()).map((a) => a.id)).not.toContain(first.id);
  });

  it("denying records approval.denied", async () => {
    const client = new KalCodeClient(createMemoryTransport("busy"));
    const events = await recorder(client);
    const [first] = await client.listApprovals();
    if (!first) throw new Error("fixture has approvals");
    await client.decideApproval(first.id, "deny");
    await tick();
    expect(events[0]?.type).toBe("approval.denied");
  });

  it("validates like the native command", async () => {
    const client = new KalCodeClient(createMemoryTransport("busy"));
    const [first] = await client.listApprovals();
    if (!first) throw new Error("fixture has approvals");
    await expect(client.decideApproval("../etc", "deny")).rejects.toMatchObject({ code: "invalid_id" });
    await expect(client.decideApproval(first.id, "yes" as never)).rejects.toMatchObject({ code: "ipc_rejected" });
    await client.decideApproval(first.id, "deny");
    await expect(client.decideApproval(first.id, "approve_once")).rejects.toMatchObject({
      code: "approval_not_pending",
    });
  });
});

describe("thread actions", () => {
  const COMMANDS: Record<Exclude<ThreadAction, "open">, (c: KalCodeClient, id: string) => Promise<unknown>> = {
    interrupt: (c, id) => c.interruptThread(id),
    stop: (c, id) => c.stopThread(id),
    resume: (c, id) => c.resumeThread(id),
    retry: (c, id) => c.resumeThread(id),
    archive: (c, id) => c.archiveThread(id),
  };

  it("every action the Dashboard offers succeeds, and offered-never actions are refused", async () => {
    const probe = new KalCodeClient(createMemoryTransport("busy"));
    const threads = await probe.listThreads();
    for (const thread of threads) {
      const offered = availableActions(thread.status);
      for (const action of Object.keys(COMMANDS) as Exclude<ThreadAction, "open">[]) {
        // Retry and Resume share `thread_resume`; only check the one this state offers.
        const sharesCommand =
          (action === "retry" && !offered.includes("retry")) || (action === "resume" && offered.includes("retry"));
        if (sharesCommand) continue;
        const client = new KalCodeClient(createMemoryTransport("busy"));
        const call = COMMANDS[action](client, thread.id);
        const label = `${ACTION_LABELS[action]} on ${thread.status}`;
        if (offered.includes(action)) await expect(call, label).resolves.toBeTruthy();
        else await expect(call, label).rejects.toMatchObject({ code: "invalid_transition" });
      }
    }
  });

  it("pausing expires the thread's pending approvals", async () => {
    const client = new KalCodeClient(createMemoryTransport("busy"));
    const events = await recorder(client);
    const [first] = await client.listApprovals();
    if (!first) throw new Error("fixture has approvals");
    const paused = await client.interruptThread(first.action.threadId);
    expect(paused.status).toBe("paused");
    expect(paused.pendingApprovals).toBe(0);
    await tick();
    expect(events.map((e) => e.type)).toEqual(["approval.expired", "thread.status_changed"]);
    expect((await client.listApprovals()).map((a) => a.id)).not.toContain(first.id);
  });

  it("archiving removes the thread from the list and records thread.archived", async () => {
    const client = new KalCodeClient(createMemoryTransport("busy"));
    const done = (await client.listThreads()).find((t) => t.status === "completed");
    if (!done) throw new Error("fixture has a completed thread");
    await client.archiveThread(done.id);
    expect((await client.listThreads()).map((t) => t.id)).not.toContain(done.id);
    await expect(client.archiveThread(done.id)).rejects.toMatchObject({ code: "thread_not_found" });
  });

  it("rejects malformed ids before anything runs", async () => {
    const client = new KalCodeClient(createMemoryTransport("busy"));
    await expect(client.stopThread("not-an-id")).rejects.toMatchObject({ code: "invalid_id" });
  });
});

describe("scenarios", () => {
  it("empty: commands exist and return nothing", async () => {
    const client = new KalCodeClient(createMemoryTransport("empty"));
    await expect(client.listThreads()).resolves.toEqual([]);
    await expect(client.listApprovals()).resolves.toEqual([]);
    await expect(client.runningTerminals()).resolves.toEqual([]);
  });

  it("approvals-flood: many requests across several threads", async () => {
    const client = new KalCodeClient(createMemoryTransport("approvals-flood"));
    const approvals = await client.listApprovals();
    expect(approvals.length).toBeGreaterThanOrEqual(8);
    expect(new Set(approvals.map((a) => a.action.threadId)).size).toBeGreaterThanOrEqual(4);
    const times = approvals.map((a) => a.action.requestedAt);
    expect([...times].sort()).toEqual(times); // longest waiting first
  });

  it("errors: reads fail with typed retryable errors until recovered", async () => {
    const transport = createMemoryTransport("errors");
    const client = new KalCodeClient(transport);
    await expect(client.listThreads()).rejects.toMatchObject({ category: "database", retryable: true });
    await expect(client.listApprovals()).rejects.toMatchObject({ retryable: true });
    transport.dashboard?.recover();
    await expect(client.listThreads()).resolves.not.toHaveLength(0);
  });

  it("loading: reads never settle", async () => {
    const client = new KalCodeClient(createMemoryTransport("loading"));
    const result = await Promise.race([client.listThreads().then(() => "settled"), tick().then(() => "pending")]);
    expect(result).toBe("pending");
  });

  it("a live approval request records approval.requested and blocks its thread", async () => {
    const transport = createMemoryTransport("busy");
    const client = new KalCodeClient(transport);
    const events = await recorder(client);
    const id = transport.dashboard?.requestApproval();
    await tick();
    expect(events.map((e) => e.type)).toContain("approval.requested");
    const approval = (await client.listApprovals()).find((a) => a.id === id);
    expect(approval).toBeDefined();
    const thread = (await client.listThreads()).find((t) => t.id === approval?.action.threadId);
    expect(thread?.status).toBe("waiting_for_permission");
  });
});
