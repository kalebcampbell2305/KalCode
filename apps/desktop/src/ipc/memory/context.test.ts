import type { EventPayload, ThreadSummary } from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import { createContextMemory } from "./context.ts";

const ids = {
  thread: "0192f3c4-0000-7000-8000-000000000011",
  workspace: "0192f3c4-0000-7000-8000-000000000012",
  account: "0192f3c4-0000-7000-8000-000000000013",
} as const;

function threadFixture(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: ids.thread,
    name: "Investigate checkout",
    providerId: "codex",
    providerName: "Codex",
    model: null,
    effort: null,
    providerAccountId: ids.account,
    accountLabel: "Personal",
    workspaceId: ids.workspace,
    workspaceName: "Storefront",
    permissionMode: "approve",
    status: "idle",
    currentActivity: null,
    createdAt: "2026-09-25T12:00:00.000Z",
    lastActivityAt: "2026-09-25T12:00:00.000Z",
    pendingApprovals: 0,
    unreadMessages: 0,
    filesChanged: null,
    branch: null,
    error: null,
    archivedAt: null,
    resumable: true,
    permissionProfileId: null,
    runtimeKind: "headless",
    terminalId: null,
    ...overrides,
  };
}

function fixture() {
  let thread = threadFixture();
  const sent: Array<{ userText: string; providerPayload: string }> = [];
  const events: EventPayload[] = [];
  const memory = createContextMemory({
    getThread: () => thread,
    sendThread: async (_threadId, userText, providerPayload) => {
      sent.push({ userText, providerPayload });
      return thread;
    },
    emit: (event) => events.push(event),
  });
  return {
    memory,
    sent,
    events,
    replaceThread(next: ThreadSummary) {
      thread = next;
    },
    thread: () => thread,
  };
}

describe("context memory transport", () => {
  it("previews redacted user context and sends only after the matching hash is confirmed", async () => {
    const fx = fixture();
    const secret = ["password", "=", "correct-horse-battery-staple"].join("");
    const preview = fx.memory.handlers.context_preview_create?.({
      threadId: ids.thread,
      inputs: [{ kind: "text", label: "Error details", text: `request failed\n${secret}` }],
    }) as { packageId: string; contentSha256: string; items: Array<{ excerpt: string }> };

    expect(preview.items[0]?.excerpt).toContain("[REDACTED]");
    expect(preview.items[0]?.excerpt).not.toContain("correct-horse");
    expect(fx.events.map((event) => event.type)).toContain("context.package_created");

    const result = await fx.memory.handlers.context_send?.({
      packageId: preview.packageId,
      threadId: ids.thread,
      previewedSha256: preview.contentSha256,
      text: "Please investigate this failure.",
    });
    expect(result).toMatchObject({ kind: "sent", thread: { id: ids.thread } });
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]?.userText).toBe("Please investigate this failure.");
    expect(fx.sent[0]?.providerPayload).toContain("Please investigate this failure.");
    expect(fx.sent[0]?.providerPayload).toContain("[REDACTED]");
    expect(fx.sent[0]?.providerPayload).not.toContain("correct-horse");
  });

  it("fails closed when the account identity changes after preview", async () => {
    const fx = fixture();
    const preview = fx.memory.handlers.context_preview_create?.({
      threadId: ids.thread,
      inputs: [{ kind: "text", label: "Notes", text: "A bounded context note." }],
    }) as { packageId: string; contentSha256: string };
    fx.replaceThread({ ...fx.thread(), providerAccountId: "0192f3c4-0000-7000-8000-000000000099" });

    await expect(
      fx.memory.handlers.context_send?.({
        packageId: preview.packageId,
        threadId: ids.thread,
        previewedSha256: preview.contentSha256,
        text: "Use this context.",
      }),
    ).rejects.toMatchObject({ code: "context_target_changed" });
    expect(fx.sent).toEqual([]);
  });

  it("rehashes item choices and refuses a stale confirmation", async () => {
    const fx = fixture();
    const preview = fx.memory.handlers.context_preview_create?.({
      threadId: ids.thread,
      inputs: [
        { kind: "text", label: "Keep", text: "Keep this bounded note." },
        { kind: "text", label: "Remove", text: "Do not include this note." },
      ],
    }) as { packageId: string; contentSha256: string; totalBytes: number };
    const changed = fx.memory.handlers.context_item_set?.({
      packageId: preview.packageId,
      position: 1,
      included: false,
    }) as { contentSha256: string; totalBytes: number };
    expect(changed.contentSha256).not.toBe(preview.contentSha256);
    expect(changed.totalBytes).toBeLessThan(preview.totalBytes);

    await expect(
      fx.memory.handlers.context_send?.({
        packageId: preview.packageId,
        threadId: ids.thread,
        previewedSha256: preview.contentSha256,
        text: "Use the selected context.",
      }),
    ).resolves.toMatchObject({ kind: "stale", preview: { contentSha256: changed.contentSha256 } });
    expect(fx.sent).toEqual([]);

    await fx.memory.handlers.context_send?.({
      packageId: preview.packageId,
      threadId: ids.thread,
      previewedSha256: changed.contentSha256,
      text: "Use the selected context.",
    });
    expect(fx.sent[0]?.providerPayload).toContain("Keep this bounded note.");
    expect(fx.sent[0]?.providerPayload).not.toContain("Do not include this note.");
  });

  it("claims a send before calling the provider and never auto-replays an uncertain failure", async () => {
    let resolvePending!: (value: ThreadSummary) => void;
    let rejectPending!: (reason?: unknown) => void;
    const pending = new Promise<ThreadSummary>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    void resolvePending;
    const thread = threadFixture();
    const sendThread = vi.fn(() => pending);
    const events: EventPayload[] = [];
    const memory = createContextMemory({ getThread: () => thread, sendThread, emit: (event) => events.push(event) });
    const preview = memory.handlers.context_preview_create?.({
      threadId: ids.thread,
      inputs: [{ kind: "text", label: "Notes", text: "One request only." }],
    }) as { packageId: string; contentSha256: string };
    const args = {
      packageId: preview.packageId,
      threadId: ids.thread,
      previewedSha256: preview.contentSha256,
      text: "Send once.",
    };

    const first = memory.handlers.context_send?.(args) as Promise<unknown>;
    await expect(memory.handlers.context_send?.(args)).rejects.toMatchObject({ code: "context_send_in_progress" });
    rejectPending(new Error("provider outcome unknown"));
    await expect(first).rejects.toMatchObject({ code: "context_send_uncertain" });
    await expect(memory.handlers.context_send?.(args)).rejects.toMatchObject({ code: "context_send_uncertain" });
    expect(sendThread).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).not.toContain("context.shared");

    const resolvedEvents: EventPayload[] = [];
    const resolvedFailedSend = vi.fn(async () => ({ ...thread, status: "failed" as const }));
    const resolvedFailed = createContextMemory({
      getThread: () => thread,
      sendThread: resolvedFailedSend,
      emit: (event) => resolvedEvents.push(event),
    });
    const failedPreview = resolvedFailed.handlers.context_preview_create?.({
      threadId: ids.thread,
      inputs: [{ kind: "text", label: "Notes", text: "Provider failure context." }],
    }) as { packageId: string; contentSha256: string };
    const failedArgs = {
      packageId: failedPreview.packageId,
      threadId: ids.thread,
      previewedSha256: failedPreview.contentSha256,
      text: "Attempt once.",
    };
    await expect(resolvedFailed.handlers.context_send?.(failedArgs)).rejects.toMatchObject({
      code: "context_send_uncertain",
    });
    await expect(resolvedFailed.handlers.context_send?.(failedArgs)).rejects.toMatchObject({
      code: "context_send_uncertain",
    });
    expect(resolvedFailedSend).toHaveBeenCalledTimes(1);
    expect(resolvedEvents.map((event) => event.type)).not.toContain("context.shared");
  });

  it("returns a prompt-confirmation failure to Draft so the exact reviewed retry can proceed", async () => {
    const thread = threadFixture();
    const sendThread = vi
      .fn()
      .mockRejectedValueOnce({ code: "context_prompt_confirmation_required" })
      .mockResolvedValueOnce(thread);
    const memory = createContextMemory({ getThread: () => thread, sendThread, emit: vi.fn() });
    const preview = memory.handlers.context_preview_create?.({
      threadId: ids.thread,
      inputs: [{ kind: "text", label: "Notes", text: "One bounded note." }],
    }) as { packageId: string; contentSha256: string };
    const args = {
      packageId: preview.packageId,
      threadId: ids.thread,
      previewedSha256: preview.contentSha256,
      text: "password=review-this-exact-message",
    };

    await expect(memory.handlers.context_send?.(args)).rejects.toMatchObject({
      code: "context_prompt_confirmation_required",
    });
    await expect(
      memory.handlers.context_send?.({ ...args, promptReviewId: "0192f3c4-0000-7000-8000-000000000099" }),
    ).resolves.toMatchObject({ kind: "sent", thread: { id: ids.thread } });
    expect(sendThread).toHaveBeenNthCalledWith(1, ids.thread, args.text, expect.any(String), null);
    expect(sendThread).toHaveBeenNthCalledWith(
      2,
      ids.thread,
      args.text,
      expect.any(String),
      "0192f3c4-0000-7000-8000-000000000099",
    );
  });

  it("redacts sensitive labels and validates the exact provider payload before its one-shot claim", async () => {
    const fx = fixture();
    const marker = ["label", "credential", "must", "not", "persist"].join("-");
    const preview = fx.memory.handlers.context_preview_create?.({
      threadId: ids.thread,
      inputs: [{ kind: "text", label: `password=${marker}`, text: "harmless" }],
    }) as { packageId: string; contentSha256: string; items: Array<{ label: string }> };
    expect(preview.items[0]?.label).toContain("[REDACTED]");
    expect(JSON.stringify(preview)).not.toContain(marker);

    const args = {
      packageId: preview.packageId,
      threadId: ids.thread,
      previewedSha256: preview.contentSha256,
      text: "x".repeat(100_000),
    };
    await expect(fx.memory.handlers.context_send?.(args)).rejects.toMatchObject({ code: "invalid_prompt" });
    expect(fx.sent).toEqual([]);

    await expect(fx.memory.handlers.context_send?.({ ...args, text: "safe\0unsafe" })).rejects.toMatchObject({
      code: "invalid_prompt",
    });
    expect(fx.sent).toEqual([]);

    await fx.memory.handlers.context_send?.({ ...args, text: "retry after deterministic validation" });
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]?.providerPayload).not.toContain(marker);
    expect(fx.sent[0]?.userText).toBe("retry after deterministic validation");

    expect(() =>
      fx.memory.handlers.context_preview_create?.({
        threadId: ids.thread,
        inputs: [{ kind: "text", label: "unsafe\nlabel", text: "body" }],
      }),
    ).toThrow(expect.objectContaining({ code: "context_label_invalid" }));
  });
});
