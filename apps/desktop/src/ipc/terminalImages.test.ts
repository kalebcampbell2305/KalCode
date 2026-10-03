import { describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "./client.ts";
import type { Transport } from "./transport.ts";

describe("terminal image IPC", () => {
  it("binds every image-paste chunk to the staged shell generation", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const client = new KalCodeClient({ kind: "memory", invoke } as unknown as Transport);
    await client.writeTerminal("terminal-a", "image.png", 42);
    expect(invoke.mock.calls).toEqual([
      ["terminal_write", { terminalId: "terminal-a", data: "image.png", expectedGeneration: 42 }],
    ]);
  });
  it("stages pixels for the exact target without writing or submitting terminal input", async () => {
    const result = { path: "/private/kalcode/images/one.png", insertion: "'/private/kalcode/images/one.png'" };
    const invoke = vi.fn().mockResolvedValue(result);
    const client = new KalCodeClient({ kind: "memory", invoke } as unknown as Transport);
    const target = { kind: "agent", threadId: "agent-a", instanceId: "instance-a" } as const;
    expect(await client.importTerminalImage(target, "pixels")).toEqual(result);
    expect(invoke.mock.calls).toEqual([["terminal_image_import", { target, pngBase64: "pixels" }]]);
  });

  it("keeps native target-change errors visible to the attachment UI", async () => {
    const invoke = vi.fn().mockRejectedValue({
      category: "validation",
      code: "terminal_image_target_changed",
      message: "This terminal restarted. Choose the image again.",
      retryable: false,
    });
    const client = new KalCodeClient({ kind: "memory", invoke } as unknown as Transport);
    await expect(client.importTerminalImage({ kind: "terminal", terminalId: "one" }, "pixels")).rejects.toMatchObject({
      code: "terminal_image_target_changed",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
