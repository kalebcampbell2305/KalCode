import type { KalVoiceSignal } from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "./client.ts";
import type { Transport } from "./transport.ts";

/**
 * A transport with the native runtime's channel semantics (kalvoice_commands.rs,
 * `kalvoice_subscribe`): one channel per window, replaced by every subscribe.
 */
function nativeLikeTransport() {
  let channel: ((signal: KalVoiceSignal) => void) | null = null;
  const subscribeKalVoice = vi.fn(async (onSignal: (signal: KalVoiceSignal) => void) => {
    channel = onSignal;
  });
  const transport = { kind: "tauri", subscribeKalVoice } as unknown as Transport;
  const send = (signal: KalVoiceSignal) => channel?.(signal);
  return { transport, subscribeKalVoice, send };
}

const started = (sessionId: string): KalVoiceSignal => ({ kind: "listening_started", sessionId, mode: "talk" });

describe("KalVoice signal subscription (native replace-on-subscribe semantics)", () => {
  it("a second listener (a remount) does not steal the channel from the first", async () => {
    const { transport, subscribeKalVoice, send } = nativeLikeTransport();
    const client = new KalCodeClient(transport);
    const first: string[] = [];
    const second: string[] = [];
    await client.subscribeKalVoice((s) => first.push(s.kind));
    await client.subscribeKalVoice((s) => second.push(s.kind));
    send(started("a"));
    expect(first).toEqual(["listening_started"]);
    expect(second).toEqual(["listening_started"]);
    expect(subscribeKalVoice).toHaveBeenCalledTimes(1);
  });

  it("a renewal that native refuses keeps delivering on the existing channel", async () => {
    const { transport, subscribeKalVoice, send } = nativeLikeTransport();
    const client = new KalCodeClient(transport);
    const seen: string[] = [];
    await client.subscribeKalVoice((s) => seen.push(s.kind));
    subscribeKalVoice.mockRejectedValueOnce({ category: "internal", code: "x", message: "No.", retryable: true });
    await expect(client.renewKalVoiceSubscription()).rejects.toMatchObject({ code: "x" });
    send(started("a"));
    expect(seen).toEqual(["listening_started"]);
    // A later listener still shares the one live channel instead of opening another.
    await client.subscribeKalVoice(() => undefined);
    expect(subscribeKalVoice).toHaveBeenCalledTimes(2);
  });

  it("a successful renewal replaces the channel and each signal still arrives exactly once", async () => {
    const { transport, subscribeKalVoice, send } = nativeLikeTransport();
    const client = new KalCodeClient(transport);
    const seen: string[] = [];
    await client.subscribeKalVoice((s) => seen.push(s.kind));
    await client.renewKalVoiceSubscription();
    send(started("a"));
    expect(seen).toEqual(["listening_started"]);
    expect(subscribeKalVoice).toHaveBeenCalledTimes(2);
  });
});
