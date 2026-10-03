import { describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "./client.ts";
import { HandoffsClient, type HandoffsInvoker } from "./handoffs.ts";
import type { Transport } from "./transport.ts";

describe("agent handoff IPC", () => {
  it("pins every send to the preview and keeps return findings as a preview", async () => {
    const invoke = vi.fn(async () => undefined);
    const client = new HandoffsClient(invoke as HandoffsInvoker);
    await client.preview({
      sourceThreadId: "source",
      targetThreadId: "target",
      task: "review",
      instructions: "Check persistence",
    });
    await client.preview({
      sourceThreadId: "source",
      targetThreadId: "target",
      task: "test",
      instructions: "",
      editedText: "Exact edited brief",
      priorPreviewId: "prior-preview",
    });
    await client.send("handoff", "preview-hash");
    await client.list("source");
    await client.list();
    await client.cancel("handoff");
    await client.complete("handoff", "completed", "Tests passed; no findings.");
    await client.returnFindings("handoff");
    expect(invoke.mock.calls).toEqual([
      [
        "handoff_preview",
        {
          sourceThreadId: "source",
          targetThreadId: "target",
          task: "review",
          instructions: "Check persistence",
          editedText: null,
          priorPreviewId: null,
        },
      ],
      [
        "handoff_preview",
        {
          sourceThreadId: "source",
          targetThreadId: "target",
          task: "test",
          instructions: "",
          editedText: "Exact edited brief",
          priorPreviewId: "prior-preview",
        },
      ],
      ["handoff_send", { id: "handoff", previewHash: "preview-hash" }],
      ["handoff_list", { threadId: "source" }],
      ["handoff_list", { threadId: null }],
      ["handoff_cancel", { id: "handoff" }],
      ["handoff_complete", { id: "handoff", outcome: "completed", result: "Tests passed; no findings." }],
      ["handoff_return", { id: "handoff" }],
    ]);
  });

  it("preserves native failure without inventing successful delivery", async () => {
    const error = {
      category: "validation",
      code: "handoff_preview_stale",
      message: "The target changed. Preview again.",
      retryable: true,
    };
    const client = new HandoffsClient((async () => {
      throw error;
    }) as HandoffsInvoker);
    await expect(client.send("h", "hash")).rejects.toMatchObject(error);
  });

  it("uses the runtime client's transport and returns its actual queued state", async () => {
    const queued = { id: "h", status: "queued", blocker: "Recipient is working" };
    const invoke = vi.fn(async () => queued);
    const client = new KalCodeClient({ invoke } as unknown as Transport);
    await expect(client.handoffs.send("h", "hash")).resolves.toBe(queued);
    expect(invoke).toHaveBeenCalledOnce();
  });
});
