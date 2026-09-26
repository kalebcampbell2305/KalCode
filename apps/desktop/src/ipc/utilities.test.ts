import { describe, expect, it, vi } from "vitest";
import { UtilityClient, UtilityIpcError } from "./utilities.ts";

describe("UtilityClient", () => {
  it("sends exact typed command arguments for consequential actions", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ kind: "awaiting_approval", approvalId: "approval-1" })
      .mockResolvedValueOnce({
        kind: "process_completed",
        result: {
          pid: 42,
          signal: "terminate",
          outcome: "stopped",
          message: "node.exe stopped.",
        },
      });
    const client = new UtilityClient(invoke);

    await expect(
      client.processSignal({
        pid: 42,
        startTime: "1700000000",
        signal: "terminate",
      }),
    ).resolves.toEqual({ kind: "awaiting_approval", approvalId: "approval-1" });
    await client.effectContinue("approval-1");

    expect(invoke.mock.calls).toEqual([
      [
        "utility_process_signal",
        {
          pid: 42,
          startTime: "1700000000",
          signal: "terminate",
        },
      ],
      ["utility_effect_continue", { approvalId: "approval-1" }],
    ]);
  });

  it("keeps SQLite writes explicit and separate from read queries", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ columns: [], rows: [], truncated: false, nextCursor: null, offset: 0, elapsedMs: 1 })
      .mockResolvedValueOnce({ kind: "awaiting_approval", approvalId: "approval-2" })
      .mockResolvedValueOnce({ kind: "sqlite_completed", result: { changes: 1, elapsedMs: 2 } });
    const client = new UtilityClient(invoke);

    await client.sqliteQuery("db-1", "select 1", null, 100);
    await client.sqliteWrite("db-1", "update notes set done = 1");
    await client.effectContinue("approval-2");

    expect(invoke.mock.calls).toEqual([
      ["utility_sqlite_query", { dbId: "db-1", sql: "select 1", cursor: null, limit: 100 }],
      ["utility_sqlite_write", { dbId: "db-1", sql: "update notes set done = 1" }],
      ["utility_effect_continue", { approvalId: "approval-2" }],
    ]);
  });

  it("normalizes native errors without losing their safe code and message", async () => {
    const client = new UtilityClient(
      vi.fn().mockRejectedValue({ code: "blocked_by_policy", message: "Permission settings blocked this action." }),
    );

    await expect(client.httpSend({ method: "GET", url: "https://example.test" })).rejects.toEqual(
      new UtilityIpcError("blocked_by_policy", "Permission settings blocked this action."),
    );
  });

  it("replaces malformed native failures with a generic safe error", async () => {
    const client = new UtilityClient(vi.fn().mockRejectedValue(new Error("token=private-value")));

    await expect(client.status()).rejects.toEqual(
      new UtilityIpcError("utility_unavailable", "The Utility Dock could not complete that action."),
    );
  });

  it("does not pass control characters from a native failure into the UI", async () => {
    const client = new UtilityClient(
      vi.fn().mockRejectedValue({
        code: "blocked_by_policy",
        message: "Blocked\u0000for safety",
      }),
    );

    await expect(client.status()).rejects.toEqual(
      new UtilityIpcError("utility_unavailable", "The Utility Dock could not complete that action."),
    );
  });
});
