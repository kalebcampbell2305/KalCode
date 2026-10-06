import { describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "./client.ts";
import { createMemoryTransport } from "./memoryTransport.ts";
import type { Transport } from "./transport.ts";

/**
 * Agent Fleet's worktree commands take one struct argument natively
 * (`thread_worktree_states(args: ThreadWorktreeStatesArgs)`,
 * `thread_worktree_commit(args: ThreadWorktreeCommitArgs)`), so Tauri reads the payload's `args`
 * key. Sent flat, every call failed with "missing required key args".
 */
describe("thread worktree IPC arguments", () => {
  it("wraps the arguments in `args`, as the native commands expect", async () => {
    const invoke = vi.fn(async () => []);
    const client = new KalCodeClient({ invoke, subscribe: async () => async () => undefined } as unknown as Transport);
    await client.threadWorktreeStates(["t1", "t2"]);
    await client.commitThreadWorktree("t1", "Fix the parser");
    expect(invoke).toHaveBeenNthCalledWith(1, "thread_worktree_states", { args: { threadIds: ["t1", "t2"] } });
    expect(invoke).toHaveBeenNthCalledWith(2, "thread_worktree_commit", {
      args: { threadId: "t1", message: "Fix the parser" },
    });
  });

  it("the in-memory runtime accepts the same shape and reports an isolated agent's worktree", async () => {
    const transport = createMemoryTransport("default", { detectDelayMs: 0 });
    const client = new KalCodeClient(transport);
    await client.detectProviders();
    transport.workspaces.queueFolders("kalcode");
    const workspace = await client.openWorkspaceDialog();
    if (!workspace) throw new Error("the fake folder picker returned nothing");
    const thread = await client.createThread({
      providerId: "claude-code",
      workspaceId: workspace.id,
      model: null,
      permissionMode: "approve",
      prompt: "Tidy the parser",
      name: null,
      isolate: true,
    });
    const states = await client.threadWorktreeStates([thread.id]);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ threadId: thread.id, worktreeId: thread.worktreeId });
  });
});
