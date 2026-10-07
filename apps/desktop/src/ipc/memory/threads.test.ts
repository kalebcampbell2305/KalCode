import type { AgentEvent, EventEnvelope, ThreadSummary } from "@kalcode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../client.ts";
import { KalCodeError } from "../errors.ts";
import { createMemoryTransport } from "../memoryTransport.ts";
import { nameFromPrompt } from "./threads.ts";

/** The workspace threads are created in: a folder opened through Z1's (fake) folder picker. */
let WORKSPACE = "";

async function setup(scenario: "default" | "threads" | "no-providers" = "default") {
  const transport = createMemoryTransport(scenario, { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  const events: EventEnvelope[] = [];
  void transport.subscribe((event) => events.push(event));
  // Provider detection (Z2) decides which providers threads may use; run it up front.
  const detected = client.detectProviders();
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
  await detected;
  transport.workspaces.queueFolders("kalcode");
  const workspace = await client.openWorkspaceDialog();
  if (!workspace) throw new Error("the fake folder picker returned nothing");
  WORKSPACE = workspace.id;
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
  it("uses a clean provider default, accepts one task title, and preserves explicit manual names", async () => {
    const { client, transport } = await setup();
    const pane = () =>
      transport.invoke<ThreadSummary>("provider_pane_create", {
        providerId: "claude-code",
        workspaceId: WORKSPACE,
        permissionMode: "bypass",
        name: null,
      });
    const automatic = await pane();
    expect(automatic.name).toBe("Claude Code");
    await transport.invoke("provider_pane_write", { threadId: automatic.id, data: "fix the login form\r" });
    const named = await client.getThread(automatic.id);
    expect(named.name).toBe("Fix Login Form");
    await transport.invoke("provider_pane_write", { threadId: automatic.id, data: "run the tests\r" });
    expect((await client.getThread(automatic.id)).name).toBe(named.name);

    const manual = await pane();
    // Even choosing the existing provider label explicitly pins that manual name.
    await client.renameThread(manual.id, "Claude Code");
    await transport.invoke("provider_pane_write", { threadId: manual.id, data: "fix the settings page\r" });
    expect((await client.getThread(manual.id)).name).toBe("Claude Code");
    await client.renameThread(automatic.id, "Release Watch");
    await transport.invoke("provider_pane_write", { threadId: automatic.id, data: "review the release\r" });
    expect((await client.getThread(automatic.id)).name).toBe("Release Watch");
  });

  it("duplicates history without starting a provider and moves only inactive threads", async () => {
    const { client, transport } = await setup();
    const source = await create(client, "Keep this conversation");
    transport.workspaces.queueFolders("destination");
    const destination = await client.openWorkspaceDialog();
    if (!destination) throw new Error("destination missing");
    expect(await code(client.moveThread(source.id, destination.id))).toBe("thread_move_busy");
    await client.stopThread(source.id);
    const copy = await client.duplicateThread(source.id);
    expect(copy).toMatchObject({ name: `${source.name} (copy)`, status: "idle", resumable: false, worktreeId: null });
    expect(copy.id).not.toBe(source.id);
    const original = await client.threadMessages(source.id, 100);
    const messages = await client.threadMessages(copy.id, 100);
    expect(messages.map((m) => m.content)).toEqual(original.map((m) => m.content));
    expect(messages[0]?.id).not.toBe(original[0]?.id);
    expect(await client.moveThread(copy.id, destination.id)).toMatchObject({ workspaceId: destination.id });
    expect(await client.getThread(source.id)).toMatchObject({ workspaceId: source.workspaceId });
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a thread, streams a turn and records it as events", async () => {
    const { client, events, transport } = await setup();
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
    const { client } = await setup();
    expect(await code(create(client, "  "))).toBe("invalid_prompt");
    expect(await code(create(client, "x", { providerId: "Bad Id" }))).toBe("invalid_provider");
    expect(await code(create(client, "x", { providerId: "other-cli" }))).toBe("provider_unavailable");
    expect(await code(create(client, "x", { workspaceId: "0192f3c4-0000-7000-8000-0000000000ff" }))).toBe(
      "workspace_not_found",
    );
    expect(await code(create(client, "x", { model: "gpt-9" }))).toBe("invalid_model");
    expect(await code(create(client, "x", { name: "n".repeat(81) }))).toBe("invalid_name");
    expect(await code(client.getThread("../x"))).toBe("invalid_thread_id");
    expect(await client.listThreads()).toEqual([]);
  });

  it("requires a content-free, one-shot confirmation for a warned create prompt", async () => {
    const { client } = await setup();
    const secret = ["password", "=", "deterministic-Q7x-private-value"].join("");
    const input: Parameters<KalCodeClient["createThread"]>[0] = {
      providerId: "claude-code",
      workspaceId: WORKSPACE,
      model: null,
      permissionMode: "approve",
      prompt: `Investigate this failure: ${secret}`,
      name: null,
    };

    const review = await client.reviewCreateThreadPrompt(input);
    expect(review.kind).toBe("confirmation_required");
    if (review.kind !== "confirmation_required") throw new Error("expected a warning");
    expect(review.warning.detectors).toEqual({ password_assignment: 1 });
    expect(JSON.stringify(review.warning)).not.toContain(secret);
    expect(JSON.stringify(review.warning)).not.toContain("deterministic-Q7x-private-value");

    expect(await code(client.createThread(input))).toBe("context_prompt_confirmation_required");
    expect(await client.listThreads()).toEqual([]);
    const thread = await client.createThread(input, review.warning.reviewId);
    expect(thread.name).toBe("New thread");
    expect(await code(client.createThread(input, review.warning.reviewId))).toBe("context_prompt_confirmation_invalid");
  });

  it("consumes a warned prompt confirmation before rejecting changed content or a changed target", async () => {
    const { client } = await setup();
    const first = await create(client, "open the first thread");
    const second = await create(client, "open the second thread");
    const prompt = "api_key=only-for-this-exact-send";

    const changedTextReview = await client.reviewThreadPrompt(first.id, prompt);
    if (changedTextReview.kind !== "confirmation_required") throw new Error("expected a warning");
    expect(await code(client.sendToThread(first.id, `${prompt}-changed`, changedTextReview.warning.reviewId))).toBe(
      "context_prompt_confirmation_invalid",
    );
    expect(await code(client.sendToThread(first.id, prompt, changedTextReview.warning.reviewId))).toBe(
      "context_prompt_confirmation_invalid",
    );

    const changedTargetReview = await client.reviewThreadPrompt(first.id, prompt);
    if (changedTargetReview.kind !== "confirmation_required") throw new Error("expected a warning");
    expect(await code(client.sendToThread(second.id, prompt, changedTargetReview.warning.reviewId))).toBe(
      "context_prompt_confirmation_invalid",
    );
    expect(await code(client.sendToThread(first.id, prompt, changedTargetReview.warning.reviewId))).toBe(
      "context_prompt_confirmation_invalid",
    );
  });

  it("cancels abandoned prompt reviews so the bounded gate never fills", async () => {
    const { client } = await setup();
    const thread = await create(client, "open a cancellation test thread");

    for (let index = 0; index < 65; index += 1) {
      const review = await client.reviewThreadPrompt(thread.id, `secret=cancel-${index}`);
      if (review.kind !== "confirmation_required") throw new Error("expected a warning");
      expect(await client.cancelPromptReview(review.warning.reviewId)).toBe(true);
      expect(await client.cancelPromptReview(review.warning.reviewId)).toBe(false);
    }

    const usable = await client.reviewThreadPrompt(thread.id, "secret=still-usable");
    expect(usable.kind).toBe("confirmation_required");
  });

  it("rejects a prompt confirmation when resume sends no prompt", async () => {
    const { client } = await setup();
    const thread = await create(client, "open a resumable thread");
    await client.stopThread(thread.id);
    const review = await client.reviewThreadPrompt(thread.id, "secret=resume-only");
    if (review.kind !== "confirmation_required") throw new Error("expected a warning");

    expect(await code(client.resumeThread(thread.id, undefined, review.warning.reviewId))).toBe(
      "context_prompt_confirmation_invalid",
    );
  });

  it("resolves an explicitly selected provider account and snapshots its public label", async () => {
    const { client } = await setup();
    const providerAccountId = "0192f3c4-0000-7000-8000-000000000101";
    const thread = await create(client, "use this account", { providerAccountId });
    expect(thread).toMatchObject({ providerAccountId, accountLabel: "Personal" });
    expect(
      await code(create(client, "unknown account", { providerAccountId: "0192f3c4-0000-7000-8000-0000000000aa" })),
    ).toBe("provider_account_not_found");
    expect(await code(create(client, "bad account", { providerAccountId: "not-an-id" }))).toBe(
      "provider_account_id_invalid",
    );
  });

  it("interrupt, stop, resume, rename and archive follow the thread's state", async () => {
    const { client } = await setup();
    const thread = await create(client, "slow task");
    await vi.advanceTimersByTimeAsync(1_000);
    // A working thread must be stopped first; an idle one is archived directly (like native).
    expect(await code(client.archiveThread(thread.id))).toBe("thread_running");
    let t: ThreadSummary = await client.interruptThread(thread.id);
    expect(t).toMatchObject({ status: "idle", currentActivity: "Interrupted by you" });
    expect(await code(client.interruptThread(thread.id))).toBe("thread_not_working");

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
    const { client } = await setup();
    const thread = await create(client, "install lodash");
    await vi.runAllTimersAsync();
    expect(await client.getThread(thread.id)).toMatchObject({ status: "waiting_for_permission", pendingApprovals: 1 });
    expect(await code(client.sendToThread(thread.id, "hi"))).toBe("thread_waiting_for_permission");
    expect(await client.interruptThread(thread.id)).toMatchObject({ status: "idle", pendingApprovals: 0 });
  });

  it("reading the newest messages marks them read", async () => {
    const { client } = await setup("threads");
    const unread = (await client.listThreads()).find((t) => t.unreadMessages > 0);
    expect(unread).toBeDefined();
    await client.threadMessages(unread?.id ?? "", 50);
    expect((await client.getThread(unread?.id ?? "")).unreadMessages).toBe(0);
  });

  it("offers Codex and Gemini CLI when detection reports them usable", async () => {
    const { client } = await setup();
    const options = await client.threadOptions();
    expect(options.providers.map((p) => [p.id, p.displayName, p.hostApprovals])).toEqual([
      ["claude-code", "Claude Code", true],
      ["codex", "Codex", false],
      ["gemini-cli", "Gemini CLI", false],
      ["cursor", "Cursor", false],
    ]);
    const [, codex, gemini] = options.providers;
    expect(codex?.models).toEqual([]);
    expect(gemini?.models.map((m) => m.id)).toEqual(["auto", "pro", "flash", "flash-lite"]);
    expect(codex?.permissionMappings.map((m) => m.mode)).toEqual(["plan", "approve", "auto", "bypass"]);
    const thread = await create(client, "summarize the README", { providerId: "codex" });
    expect(thread).toMatchObject({ providerId: "codex", providerName: "Codex", model: null });
    expect(await code(create(client, "x", { providerId: "codex", model: "gpt-9" }))).toBe("invalid_model");
  });

  it("accepts only exact models reported for the selected provider account", async () => {
    const { client } = await setup();
    const codex = (await client.listProviderAccounts("codex")).find(
      (account) => account.authenticationState === "authenticated",
    );
    expect(codex).toBeDefined();
    if (!codex) throw new Error("authenticated Codex fixture account missing");
    const catalog = await client.providerAccountModels(codex.id);
    const exact = catalog.models[0];
    expect(exact).toBeDefined();
    if (!exact) throw new Error("Codex fixture model missing");

    await expect(
      create(client, "use the exact account model", {
        providerId: "codex",
        providerAccountId: codex.id,
        model: exact.id,
      }),
    ).resolves.toMatchObject({ providerId: "codex", providerAccountId: codex.id, model: exact.id });

    const claude = (await client.listProviderAccounts("claude-code"))[0];
    expect(claude).toBeDefined();
    if (!claude) throw new Error("Claude fixture account missing");
    const wrongProviderModel = (await client.providerAccountModels(claude.id)).models[0];
    expect(wrongProviderModel).toBeDefined();
    if (!wrongProviderModel) throw new Error("Claude fixture model missing");
    expect(
      await code(
        create(client, "reject another provider's model", {
          providerId: "codex",
          providerAccountId: codex.id,
          model: wrongProviderModel.id,
        }),
      ),
    ).toBe("invalid_model");
  });

  it("offers no providers in the no-providers scenario", async () => {
    const { client } = await setup("no-providers");
    const options = await client.threadOptions();
    expect(options.providers).toEqual([]);
    expect(options.defaultPermissionMode).toBe("bypass");
    expect(options.permissionModes).toEqual(["plan", "approve", "auto", "bypass"]);
  });
});
