import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliverToProviderTerminal,
  deliverToProviderThread,
  dictationTargetForProviderTerminal,
  dictationTargetForProviderThread,
  dictationTargetForRawTerminal,
  providerInputPayload,
  reconnectTarget,
  registerDictationSink,
  resetDictationSinkRegistryForTests,
  submitCapturedProviderTarget,
  submitProviderThread,
} from "./dictation.ts";

function mountedHost(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  return host;
}

function providerSink(
  host: Element,
  identity: { threadId: string; terminalId: string; providerAccountId?: string; instanceId?: string },
  writes: string[],
) {
  return registerDictationSink(host, {
    label: "Claude",
    destination: {
      kind: "provider_pane",
      threadId: identity.threadId,
      terminalId: identity.terminalId,
      instanceId: identity.instanceId ?? `${identity.terminalId}-instance`,
      providerId: "claude-code",
      providerAccountId: identity.providerAccountId ?? "personal",
    },
    async deliver(text, options) {
      const payload = providerInputPayload(text, options?.mode ?? "send");
      writes.push(payload);
      return payload.length - (options?.mode === "insert" ? 0 : 1);
    },
    async submit() {
      writes.push("\r");
    },
  });
}

afterEach(() => {
  resetDictationSinkRegistryForTests();
  document.body.replaceChildren();
});

describe("destination-indexed dictation sinks", () => {
  it("selects the newest live provider registration and a stale cleanup cannot remove it", () => {
    const firstHost = mountedHost();
    const secondHost = mountedHost();
    const first = providerSink(firstHost, { threadId: "thread-1", terminalId: "pty-1" }, []);
    const second = providerSink(secondHost, { threadId: "thread-1", terminalId: "pty-1" }, []);

    expect(dictationTargetForProviderThread("thread-1")?.element).toBe(secondHost);
    expect(dictationTargetForProviderTerminal("pty-1")?.element).toBe(secondHost);

    first();
    expect(dictationTargetForProviderThread("thread-1")?.element).toBe(secondHost);
    second();
    expect(dictationTargetForProviderThread("thread-1")).toBeNull();
  });

  it("falls back to the older live registration when the newest overlapping mount closes", () => {
    const firstHost = mountedHost();
    const secondHost = mountedHost();
    const first = providerSink(firstHost, { threadId: "thread-1", terminalId: "pty-1" }, []);
    const second = providerSink(secondHost, { threadId: "thread-1", terminalId: "pty-1" }, []);

    second();
    expect(dictationTargetForProviderThread("thread-1")?.element).toBe(firstHost);
    first();
  });

  it("does not resolve an unmounted destination even when cleanup has not run yet", () => {
    const host = mountedHost();
    providerSink(host, { threadId: "thread-1", terminalId: "pty-1" }, []);

    host.remove();

    expect(dictationTargetForProviderThread("thread-1")).toBeNull();
    expect(dictationTargetForProviderTerminal("pty-1")).toBeNull();
  });

  it("keeps raw terminal ids and provider PTY ids in separate namespaces", async () => {
    const rawHost = mountedHost();
    const providerHost = mountedHost();
    const rawWrites: string[] = [];
    registerDictationSink(rawHost, {
      label: "PowerShell",
      destination: { kind: "raw_terminal", terminalId: "shared-id" },
      async deliver(text) {
        rawWrites.push(text);
      },
    });
    const providerWrites: string[] = [];
    providerSink(providerHost, { threadId: "thread-1", terminalId: "shared-id" }, providerWrites);

    expect(dictationTargetForRawTerminal("shared-id")?.element).toBe(rawHost);
    expect(dictationTargetForProviderTerminal("shared-id")?.element).toBe(providerHost);
    await expect(deliverToProviderThread("shared-id", "whoami")).rejects.toMatchObject({ code: "target_closed" });
    expect(rawWrites).toEqual([]);
    expect(providerWrites).toEqual([]);
  });

  it("supports insert-only, send, and submit with trusted Enter behavior", async () => {
    const writes: string[] = [];
    providerSink(mountedHost(), { threadId: "thread-1", terminalId: "pty-1" }, writes);

    await expect(deliverToProviderThread("thread-1", "draft\nonly\u001b[200~", { mode: "insert" })).resolves.toBe(10);
    await expect(deliverToProviderTerminal("pty-1", "send\rnow", { mode: "send" })).resolves.toBe(8);
    await expect(submitProviderThread("thread-1")).resolves.toBeUndefined();

    expect(writes).toEqual(["draft only", "send now\r", "\r"]);
    expect([...(writes[1] ?? "")].filter((character) => character === "\r")).toHaveLength(1);
  });

  it("cancels before provider delivery and never falls through to a raw shell", async () => {
    const providerWrites: string[] = [];
    providerSink(mountedHost(), { threadId: "thread-1", terminalId: "pty-1" }, providerWrites);
    const abort = new AbortController();
    abort.abort();

    await expect(deliverToProviderThread("thread-1", "do not send", { signal: abort.signal })).rejects.toMatchObject({
      code: "dictation_cancelled",
    });
    expect(providerWrites).toEqual([]);

    const rawDeliver = vi.fn(async () => undefined);
    registerDictationSink(mountedHost(), {
      label: "Terminal",
      destination: { kind: "raw_terminal", terminalId: "thread-raw" },
      deliver: rawDeliver,
    });
    await expect(submitProviderThread("thread-raw")).rejects.toMatchObject({ code: "target_closed" });
    expect(rawDeliver).not.toHaveBeenCalled();
  });

  it("never rebinds captured submit to a replacement mount with the same thread id", async () => {
    const firstWrites: string[] = [];
    const firstHost = mountedHost();
    const unregisterFirst = providerSink(firstHost, { threadId: "thread-1", terminalId: "pty-1" }, firstWrites);
    const captured = dictationTargetForProviderThread("thread-1");
    if (!captured) throw new Error("provider target was not registered");

    unregisterFirst();
    const replacementWrites: string[] = [];
    providerSink(mountedHost(), { threadId: "thread-1", terminalId: "pty-2" }, replacementWrites);

    await expect(submitCapturedProviderTarget(captured)).rejects.toMatchObject({ code: "target_closed" });
    expect(firstWrites).toEqual([]);
    expect(replacementWrites).toEqual([]);
  });

  it("reconnects a remounted provider pane only when its full runtime identity is unchanged", () => {
    const firstHost = mountedHost();
    const unregister = providerSink(firstHost, { threadId: "thread-1", terminalId: "pty-1" }, []);
    const captured = dictationTargetForProviderThread("thread-1");
    if (!captured) throw new Error("provider target was not registered");
    unregister();

    const sameHost = mountedHost();
    const unregisterSame = providerSink(sameHost, { threadId: "thread-1", terminalId: "pty-1" }, []);
    expect(reconnectTarget(captured)).toMatchObject({ kind: "sink", element: sameHost });
    unregisterSame();

    providerSink(
      mountedHost(),
      {
        threadId: "thread-1",
        terminalId: "pty-1",
        providerAccountId: "different",
        instanceId: "replacement-instance",
      },
      [],
    );
    expect(reconnectTarget(captured)).toBeNull();
  });
});
