import type { CommandRequest, KalVoiceResponse } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { createMemoryKalVoice } from "./memoryKalVoice.ts";

function request(text: string): CommandRequest {
  return {
    requestId: crypto.randomUUID(),
    text,
    input: "voice",
    workspaceId: "0192f3c4-0000-7000-8000-00000000000a",
    threadId: null,
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
    expect(status.usage).toEqual(expect.objectContaining({ used: 25, allowance: 25 }));

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

describe("memory KalVoice composer and session commands (TK-3 subset)", () => {
  const THREAD = "0192f3c4-0000-7000-8000-00000000000b";
  const talk = (
    memory: ReturnType<typeof createMemoryKalVoice>,
    text: string,
    target: "field" | "terminal" | "provider_pane" | "none",
  ) =>
    invoke(memory, "kalvoice_talk", {
      request: {
        requestId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        text,
        target,
        durationMs: 400,
        workspaceId: null,
        threadId: THREAD,
      },
    }) as Promise<{ route: string; response: KalVoiceResponse | null }>;

  it("“send that” / “clear that” from a composer target the focused thread's composer", async () => {
    const memory = createMemoryKalVoice(() => undefined, "");
    expect((await talk(memory, "send that", "field")).response?.directive).toEqual({
      kind: "submit_composer",
      threadId: THREAD,
    });
    expect((await talk(memory, "don't send that", "field")).response?.directive).toEqual({
      kind: "clear_composer",
      threadId: THREAD,
    });
  });

  it("allows explicit submit and clear for a governed provider pane", async () => {
    const memory = createMemoryKalVoice(() => undefined, "");
    expect((await talk(memory, "send that", "provider_pane")).response?.directive).toEqual({
      kind: "submit_composer",
      threadId: THREAD,
    });
    expect((await talk(memory, "clear that", "provider_pane")).response?.directive).toEqual({
      kind: "clear_composer",
      threadId: THREAD,
    });
  });

  it("accepts lane B1's native phrasings for send, clear and go back", async () => {
    const memory = createMemoryKalVoice(() => undefined, "");
    for (const text of ["send the message", "press send", "Hey Kal, send that"]) {
      expect((await talk(memory, text, "field")).response?.directive, text).toEqual({
        kind: "submit_composer",
        threadId: THREAD,
      });
    }
    for (const text of ["never mind", "cancel that", "do not send it"]) {
      expect((await talk(memory, text, "field")).response?.directive, text).toEqual({
        kind: "clear_composer",
        threadId: THREAD,
      });
    }
    for (const text of ["go back", "switch back to the previous terminal", "back to the thread I was just using"]) {
      expect((await talk(memory, text, "none")).response?.directive, text).toEqual({ kind: "focus_previous" });
    }
  });

  it("refuses to submit or clear a raw terminal", async () => {
    const memory = createMemoryKalVoice(() => undefined, "");
    const sent = await talk(memory, "send that", "terminal");
    expect(sent.response?.directive).toBeNull();
    expect(sent.response?.outcome).toMatchObject({ kind: "failed", code: "terminal_submit_refused" });
    const cleared = await talk(memory, "clear that", "terminal");
    expect(cleared.response?.directive).toBeNull();
    expect(cleared.response?.outcome).toMatchObject({ kind: "failed", code: "terminal_clear_refused" });
  });

  it("“tell <name> to …” is dictated into a focused box, and resolved when nothing has focus", async () => {
    const memory = createMemoryKalVoice(() => undefined, "");
    memory.setSessionResolver(async (query) =>
      query === "release"
        ? {
            kind: "ambiguous",
            question: "Which one — Release Windows or Release Mac?",
            choices: [],
            total: 2,
          }
        : { kind: "not_found", message: "KalCode couldn't find an open session with that name." },
    );
    expect((await talk(memory, "tell release to bump the version", "field")).route).toBe("dictation");
    const asked = await talk(memory, "tell release to Bump the version.", "none");
    expect(asked.response?.directive).toEqual({
      kind: "choose_session",
      question: "Which one — Release Windows or Release Mac?",
      choices: [],
      followUp: { kind: "compose", text: "Bump the version.", submit: true },
    });
  });
});
