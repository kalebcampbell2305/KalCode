import type { EventEnvelope, ThreadSummary } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { KalCodeClient } from "../client.ts";
import { createMemoryTransport } from "../memoryTransport.ts";

const WORKSPACE_A = "0192f3c4-0000-7000-8000-00000000a001";
const WORKSPACE_B = "0192f3c4-0000-7000-8000-00000000a002";
const CODEX_WORK = "0192f3c4-0000-7000-8000-000000000202";
const GEMINI_PERSONAL = "0192f3c4-0000-7000-8000-000000000301";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function recorder(client: KalCodeClient) {
  const events: EventEnvelope[] = [];
  await client.subscribeEvents((event) => events.push(event));
  return events;
}

function settled(threads: ThreadSummary[]): ThreadSummary {
  const found = threads.find((thread) => thread.status === "idle" || thread.status === "interrupted");
  if (!found) throw new Error("fixture has no settled thread");
  return found;
}

describe("switch accounts memory contract", () => {
  it("rebinds a settled thread to another account of its provider and records thread.account_changed", async () => {
    const client = new KalCodeClient(createMemoryTransport("threads"));
    const events = await recorder(client);
    const thread = settled(await client.listThreads());
    const target = await client.createProviderAccount(thread.providerId, "Second account");

    const rebound = await client.rebindThreadAccount(thread.id, target.id);
    expect(rebound.providerAccountId).toBe(target.id);
    expect(rebound.accountLabel).toBe("Second account");
    expect((await client.getThread(thread.id)).providerAccountId).toBe(target.id);
    await tick();
    expect(events.find((event) => event.type === "thread.account_changed")?.payload).toEqual({
      threadId: thread.id,
      providerAccountId: target.id,
      accountLabel: "Second account",
    });
  });

  it("refuses busy threads, other providers' accounts and signed-out accounts", async () => {
    const client = new KalCodeClient(createMemoryTransport("threads"));
    const threads = await client.listThreads();
    const busy = threads.find((thread) => thread.status === "running_tool");
    if (!busy) throw new Error("fixture has no busy thread");
    const other = await client.createProviderAccount(busy.providerId, "Other");
    await expect(client.rebindThreadAccount(busy.id, other.id)).rejects.toMatchObject({ code: "thread_rebind_busy" });

    const settledThread = settled(threads);
    const foreign = settledThread.providerId === "gemini-cli" ? CODEX_WORK : GEMINI_PERSONAL;
    await expect(client.rebindThreadAccount(settledThread.id, foreign)).rejects.toMatchObject({
      code: "provider_account_mismatch",
    });

    const codexThread = threads.find(
      (thread) => thread.providerId === "codex" && (thread.status === "idle" || thread.status === "interrupted"),
    );
    if (codexThread) {
      await expect(client.rebindThreadAccount(codexThread.id, CODEX_WORK)).rejects.toMatchObject({
        code: "provider_account_not_authenticated",
      });
    }
  });

  it("matches native: pending approvals refuse, an idle live session ends, the current account is a no-op", async () => {
    const client = new KalCodeClient(createMemoryTransport("threads"));
    const threads = await client.listThreads();
    const waiting = threads.find((thread) => thread.status === "waiting_for_permission");
    if (!waiting) throw new Error("fixture has no waiting thread");
    const other = await client.createProviderAccount(waiting.providerId, "Other");
    await expect(client.rebindThreadAccount(waiting.id, other.id)).rejects.toMatchObject({
      code: "thread_rebind_pending_approval",
    });

    const idle = threads.find((thread) => thread.status === "idle");
    if (!idle) throw new Error("fixture has no idle thread");
    const target = await client.createProviderAccount(idle.providerId, "Next");
    const rebound = await client.rebindThreadAccount(idle.id, target.id);
    expect(rebound).toMatchObject({ status: "completed", resumable: false, providerAccountId: target.id });
    expect(await client.rebindThreadAccount(idle.id, target.id)).toMatchObject({ status: "completed" });
    expect((await client.resumeThread(idle.id)).providerAccountId).toBe(target.id);
  });

  it("lists workspace bindings with filters and drops them when the account is archived", async () => {
    const client = new KalCodeClient(createMemoryTransport("threads"));
    const geminiB = await client.createProviderAccount("gemini-cli", "Gemini B");
    await client.bindProviderAccount("gemini-cli", "workspace", WORKSPACE_A, GEMINI_PERSONAL);
    await client.bindProviderAccount("gemini-cli", "workspace", WORKSPACE_B, geminiB.id);
    await client.bindProviderAccount("codex", "workspace", WORKSPACE_A, CODEX_WORK);

    expect(await client.listProviderAccountBindings()).toHaveLength(3);
    expect(await client.listProviderAccountBindings({ providerId: "gemini-cli" })).toEqual([
      { providerId: "gemini-cli", kind: "workspace", scopeId: WORKSPACE_A, accountId: GEMINI_PERSONAL },
      { providerId: "gemini-cli", kind: "workspace", scopeId: WORKSPACE_B, accountId: geminiB.id },
    ]);
    expect(await client.listProviderAccountBindings({ kind: "workspace", scopeId: WORKSPACE_A })).toHaveLength(2);
    await expect(client.bindProviderAccount("gemini-cli", "agent", WORKSPACE_A, geminiB.id)).rejects.toMatchObject({
      code: "provider_account_binding_kind_unsupported",
    });

    await client.archiveProviderAccount(geminiB.id);
    expect(await client.listProviderAccountBindings({ providerId: "gemini-cli" })).toEqual([
      { providerId: "gemini-cli", kind: "workspace", scopeId: WORKSPACE_A, accountId: GEMINI_PERSONAL },
    ]);
  });
});
