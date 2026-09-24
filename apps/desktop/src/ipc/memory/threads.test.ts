import type { AgentEvent, EventEnvelope, ThreadSummary } from "@kalcode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../client.ts";
import { KalCodeError } from "../errors.ts";
import { createMemoryTransport } from "../memoryTransport.ts";
import { nameFromPrompt } from "./threads.ts";

const WORKSPACE = "0192f3c4-0000-7000-8000-00000000a001";

function setup(scenario: "default" | "threads" | "no-providers" = "default") {
  const transport = createMemoryTransport(scenario);
  const client = new KalCodeClient(transport);
  const events: EventEnvelope[] = [];
  void transport.subscribe((event) => events.push(event));
  return { transport, client, events };
}

const create = (
  client: KalCodeClient,
  prompt: string,
  extra: Partial<Parameters<KalCodeClient["createThread"]>[0]> = {},
) =>
  client.createThread({
    providerId: "claude-code",
    workspaceId: WORKSPACE,
    model: null,
    permissionMode: "approve",
    prompt,
    name: null,
    ...extra,
  });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(KalCodeError);
    return (error as KalCodeError).code;
  }
  throw new Error("expected a failure");
}

describe("nameFromPrompt (mirrors crates/threads/src/naming.rs)", () => {
  it.each([
    ["fix the OAuth callback race in the login flow", "Fix OAuth Callback Race"],
    ["Can you please fix the race condition in our OAuth callback?", "Fix Race Condition in OAuth Callback"],
    ["I want you to add a dark mode toggle to the settings page", "Add Dark Mode Toggle"],
    ["write unit tests for the parser module. Then run them.", "Write Unit Tests for Parser Module"],
    ["Update README with install steps", "Update README with Install Steps"],
    ["refactor useEffect cleanup in App.tsx", "Refactor useEffect Cleanup in App.tsx"],
    ["Help me migrate the api to v2", "Migrate API to v2"],
    ["deploy to", "Deploy"],
    ["", "New thread"],
    ["can you help me", "New thread"],
  ])("%j → %j", (prompt, expected) => {
    expect(nameFromPrompt(prompt)).toBe(expected);
  });
});

describe("memory thread runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a thread, streams a turn and records it as events", async () => {
    const { client, events, transport } = setup();
    const thread = await create(client, "fix the OAuth callback race in the login flow");
    expect(thread).toMatchObject({ name: "Fix OAuth Callback Race", status: "active", providerName: "Claude Code" });

    const streamed: AgentEvent[] = [];
    const stop = await transport.streamThread(thread.id, (event) => streamed.push(event));
    await vi.runAllTimersAsync();
    await stop();

    const done = await client.getThread(thread.id);
    expect(done.status).toBe("idle");
    expect(done.filesChanged).toBe(1);
    expect(streamed.some((e) => e.kind === "message_delta")).toBe(true);
    expect(streamed.filter((e) => e.kind === "message_completed")).toHaveLength(2);
    const messages = await client.threadMessages(thread.id, 50);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    const tools = await client.threadToolCalls(thread.id, 50);
    expect(tools).toMatchObject([{ tool: "Bash", status: "completed", resultSummary: "42 tests passed" }]);

    const types = events.map((e) => e.type);
    expect(types).toContain("thread.created");
    expect(types).toContain("tool.completed");
    const threadEvents = events.filter((e) => e.correlation.threadId === thread.id);
    expect(threadEvents.every((e) => e.correlation.workspaceId === WORKSPACE)).toBe(true);
  });

  it("validates like the native runtime", async () => {
    const { client } = setup();
    expect(await code(create(client, "  "))).toBe("invalid_prompt");
    expect(await code(create(client, "x", { permissionMode: "bypass" }))).toBe("bypass_not_allowed_at_create");
    expect(await code(create(client, "x", { providerId: "Bad Id" }))).toBe("invalid_provider");
    expect(await code(create(client, "x", { providerId: "gemini-cli" }))).toBe("provider_unavailable");
    expect(await code(create(client, "x", { workspaceId: "0192f3c4-0000-7000-8000-0000000000ff" }))).toBe(
      "workspace_not_found",
    );
    expect(await code(create(client, "x", { model: "gpt-9" }))).toBe("invalid_model");
    expect(await code(create(client, "x", { name: "n".repeat(81) }))).toBe("invalid_name");
    expect(await code(client.getThread("../x"))).toBe("invalid_thread_id");
    expect(await client.listThreads()).toEqual([]);
  });

  it("interrupt, stop, resume, rename and archive follow the thread's state", async () => {
    const { client } = setup();
    const thread = await create(client, "slow task");
    await vi.advanceTimersByTimeAsync(1_000);
    let t: ThreadSummary = await client.interruptThread(thread.id);
    expect(t).toMatchObject({ status: "idle", currentActivity: "Interrupted by you" });
    expect(await code(client.interruptThread(thread.id))).toBe("thread_not_working");
    expect(await code(client.archiveThread(thread.id))).toBe("thread_running");

    t = await client.stopThread(thread.id);
    expect(t).toMatchObject({ status: "interrupted", currentActivity: "Stopped by you" });
    expect(await code(client.sendToThread(thread.id, "more"))).toBe("thread_not_running");

    t = await client.resumeThread(thread.id);
    expect(t.status).toBe("idle");
    expect(await code(client.resumeThread(thread.id))).toBe("thread_already_running");
    await client.stopThread(thread.id);

    t = await client.renameThread(thread.id, "  Better   name ");
    expect(t.name).toBe("Better name");
    await client.archiveThread(thread.id);
    expect(await client.listThreads()).toEqual([]);
    expect((await client.listThreads({ includeArchived: true })).map((x) => x.id)).toEqual([thread.id]);
    expect(await code(client.resumeThread(thread.id))).toBe("thread_archived");
  });

  it("a thread waiting for permission refuses messages until interrupted", async () => {
    const { client } = setup();
    const thread = await create(client, "install lodash");
    await vi.runAllTimersAsync();
    expect(await client.getThread(thread.id)).toMatchObject({ status: "waiting_for_permission", pendingApprovals: 1 });
    expect(await code(client.sendToThread(thread.id, "hi"))).toBe("thread_waiting_for_permission");
    expect(await client.interruptThread(thread.id)).toMatchObject({ status: "idle", pendingApprovals: 0 });
  });

  it("reading the newest messages marks them read", async () => {
    const { client } = setup("threads");
    const unread = (await client.listThreads()).find((t) => t.unreadMessages > 0);
    expect(unread).toBeDefined();
    await client.threadMessages(unread?.id ?? "", 50);
    expect((await client.getThread(unread?.id ?? "")).unreadMessages).toBe(0);
  });

  it("offers no providers in the no-providers scenario", async () => {
    const { client } = setup("no-providers");
    const options = await client.threadOptions();
    expect(options.providers).toEqual([]);
    expect(options.defaultPermissionMode).toBe("approve");
    expect(options.permissionModes).toEqual(["plan", "approve", "auto"]);
  });
});
