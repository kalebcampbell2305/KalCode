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
  it("cloud requests alone consume the allowance and exhaustion leaves local commands and dictation usable", async () => {
    const events: unknown[] = [];
    const memory = createMemoryKalVoice((event) => events.push(event), "");
    for (let index = 0; index < 25; index++) {
      const cloud = memory.controls.cloudRequest(`cloud-${index}`);
      expect(cloud.counted).toBe(true);
      expect(cloud.usage.used).toBe(index + 1);
    }
    expect(memory.controls.cloudRequest("cloud-0")).toMatchObject({ counted: false, usage: { used: 25 } });
    expect(memory.controls.cloudRequest("cloud-over-limit")).toMatchObject({
      counted: false,
      outcome: { kind: "limit_reached" },
      usage: { used: 25, allowance: 25 },
    });
    const local = request("go to settings");
    const response = (await invoke(memory, "kalvoice_request", { request: local })) as KalVoiceResponse;
    expect(response).toMatchObject({ counted: false, outcome: { kind: "completed" }, usage: { used: 25 } });
    expect(response.directive).toMatchObject({ kind: "navigate", surface: "settings" });
    expect(await invoke(memory, "kalvoice_request", { request: local })).toMatchObject({
      outcome: { kind: "failed", code: "duplicate_request" },
    });
    const ui = { requestId: "local-ui", command: "scene", input: "voice" };
    expect(invoke(memory, "kalvoice_meter_ui_command", { request: ui })).toMatchObject({
      counted: false,
      outcome: { kind: "completed" },
      usage: { used: 25 },
    });
    invoke(memory, "kalvoice_meter_ui_command", { request: ui });
    expect(events.filter((event) => (event as { type: string }).type === "kalvoice.command_executed")).toHaveLength(2);
    const dictated = await invoke(memory, "kalvoice_talk", {
      request: { ...request("write the release notes"), target: "field" },
    });
    expect(dictated).toMatchObject({ route: "dictation", response: null });
    expect(invoke(memory, "kalvoice_type_instead", { requestId: local.requestId })).toBe(true);
    expect(invoke(memory, "kalvoice_status", {})).toMatchObject({ usage: { used: 25 } });
  });

  it("late exact cancellation leaves a successor microphone session alone", () => {
    const memory = createMemoryKalVoice(() => undefined, "");
    const first = invoke(memory, "kalvoice_listen_start", {});
    expect(invoke(memory, "kalvoice_listen_cancel", { sessionId: first })).toBe(true);
    const second = invoke(memory, "kalvoice_listen_start", {});
    try {
      expect(invoke(memory, "kalvoice_listen_cancel", { sessionId: first })).toBe(false);
      expect(invoke(memory, "kalvoice_listen_cancel", { sessionId: second })).toBe(true);
    } finally {
      invoke(memory, "kalvoice_listen_cancel", {});
    }
  });

  it("returns the same bounded browser directive as the native command path", async () => {
    const memory = createMemoryKalVoice(() => undefined, "");
    const response = (await invoke(memory, "kalvoice_request", {
      request: request("open localhost 3000"),
    })) as KalVoiceResponse;

    expect(response.intent).toBe("control_browser");
    expect(response.counted).toBe(false);
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

describe("memory KalVoice agent status (mirrors native grammar_agents)", () => {
  async function ask(text: string) {
    const memory = createMemoryKalVoice(() => undefined, "");
    return (await invoke(memory, "kalvoice_request", { request: request(text) })) as KalVoiceResponse;
  }

  it.each([
    ["show me all agents that need me", "needs_you", null],
    ["show working agents", "working", null],
    ["show me all the idle agents", "idle", null],
    ["show done agents", "done", null],
    ["show me the failed agents", "failed", null],
    ["show waiting agents", "waiting", null],
    ["show me the agents waiting for me", "needs_you", null],
    ["show all agents", "all", null],
    ["show my codex agents that need me", "needs_you", "codex"],
    ["show cursor agents", "all", "cursor"],
    ["show everything waiting for me", "needs_you", null],
  ])("%j filters the Agents tab", async (text, filter, providerId) => {
    const response = await ask(text);
    expect(response.intent).toBe("filter_agents");
    expect(response.directive).toEqual({ kind: "filter_agents", filter, providerId });
  });

  it.each([
    ["which agents need me", "which_agents", { kind: "filter_agents", filter: "needs_you", providerId: null }],
    ["which agent failed", "which_agents", { kind: "filter_agents", filter: "failed", providerId: null }],
    ["how many agents are working", "count_agents", null],
    ["close all idle agents", "close_idle_agents", { kind: "close_idle_agents", providerId: null }],
    ["stop all idle agents", "close_idle_agents", { kind: "close_idle_agents", providerId: null }],
    ["kill all idle cursor agents", "close_idle_agents", { kind: "close_idle_agents", providerId: "cursor" }],
  ])("%j is %s", async (text, intent, directive) => {
    const response = await ask(text);
    expect(response.intent).toBe(intent);
    expect(response.directive).toEqual(directive);
  });

  it("never reads a narrower state as stop everything", async () => {
    for (const text of ["stop all idle agents", "stop the paused threads", "pause all idle agents"]) {
      expect((await ask(text)).intent).not.toMatch(/^(stop|pause|resume)_threads$/);
    }
    expect((await ask("stop all running agents")).intent).toBe("stop_threads");
  });

  it("opens the agent that just finished for any provider (native finds it)", async () => {
    const any = await ask("open the agent that just finished");
    expect(any.intent).toBe("open_finished_agent");
    const cursor = await ask("open the cursor agent that just finished");
    expect(cursor.outcome).toMatchObject({ kind: "failed", message: "No Cursor agent has finished yet." });
  });
});
