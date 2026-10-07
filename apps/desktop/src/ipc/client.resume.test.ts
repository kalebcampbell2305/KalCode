import type { ThreadSummary } from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "./client.ts";
import type { Transport } from "./transport.ts";

describe("thread resume IPC", () => {
  it("sends an explicit queued-input policy to native", async () => {
    const invoke = vi.fn(async () => ({}) as ThreadSummary);
    const client = new KalCodeClient({ invoke } as unknown as Transport);

    await client.resumeThread("thread", undefined, null, false);
    await client.resumeThread("thread");

    expect(invoke.mock.calls).toEqual([
      ["thread_resume", { threadId: "thread", text: null, promptReviewId: null, allowPendingInput: false }],
      ["thread_resume", { threadId: "thread", text: null, promptReviewId: null, allowPendingInput: true }],
    ]);
  });
});
