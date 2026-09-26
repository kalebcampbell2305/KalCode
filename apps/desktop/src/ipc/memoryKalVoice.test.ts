import type { CommandRequest, KalVoiceResponse } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { createMemoryKalVoice } from "./memoryKalVoice.ts";

function request(text: string): CommandRequest {
  return {
    requestId: crypto.randomUUID(),
    text,
    input: "voice",
    workspaceId: "0192f3c4-0000-7000-8000-00000000000a",
  };
}

function invoke(memory: ReturnType<typeof createMemoryKalVoice>, name: string, args: Record<string, unknown>) {
  const handler = memory.handlers[name];
  if (!handler) throw new Error(`Missing memory handler: ${name}`);
  return handler(args);
}

describe("memory KalVoice browser parity", () => {
  it("returns the same bounded browser directive as the native command path", async () => {
    const memory = createMemoryKalVoice(() => undefined, "");
    const response = (await invoke(memory, "kalvoice_request", {
      request: request("open localhost 3000"),
    })) as KalVoiceResponse;

    expect(response.intent).toBe("control_browser");
    expect(response.counted).toBe(true);
    expect(response.directive).toEqual({
      kind: "control_browser",
      workspaceId: "0192f3c4-0000-7000-8000-00000000000a",
      command: { kind: "navigate", url: "http://localhost:3000/", browserId: null },
    });
    expect(JSON.stringify(response.directive)).not.toContain("script");

    const polite = (await invoke(memory, "kalvoice_request", {
      request: request("Please open localhost 8000."),
    })) as KalVoiceResponse;
    expect(polite.directive).toEqual({
      kind: "control_browser",
      workspaceId: "0192f3c4-0000-7000-8000-00000000000a",
      command: { kind: "navigate", url: "http://localhost:8000/", browserId: null },
    });
  });

  it("uses the current Free allowance and does not execute unsafe URL schemes", async () => {
    const limited = createMemoryKalVoice(() => undefined, "kalvoice-limit");
    const status = invoke(limited, "kalvoice_status", {}) as { usage: { used: number; allowance: number | null } };
    expect(status.usage).toEqual(expect.objectContaining({ used: 75, allowance: 75 }));

    const events: unknown[] = [];
    const memory = createMemoryKalVoice((event) => events.push(event), "");
    const response = (await invoke(memory, "kalvoice_request", {
      request: request("open javascript:alert(1)"),
    })) as KalVoiceResponse;
    expect(response.outcome).toEqual(expect.objectContaining({ kind: "failed", code: "local_reasoning_unavailable" }));
    expect(response.counted).toBe(false);
    expect(response.directive).toBeNull();
    expect(events).not.toContainEqual(expect.objectContaining({ type: "kalvoice.command_executed" }));
  });
});
