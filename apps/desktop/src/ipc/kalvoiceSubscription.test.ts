import type { KalVoiceSignal } from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "./client.ts";
import { createMemoryTransport } from "./memoryTransport.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const transport = createMemoryTransport("default");
  const subscribe = vi.spyOn(transport, "subscribeKalVoice");
  return { transport, subscribe, client: new KalCodeClient(transport) };
}

describe("KalVoice signal subscription", () => {
  it("opens exactly one native channel per client, however many listeners attach and detach", async () => {
    const { client, subscribe } = setup();
    const a: string[] = [];
    const b: string[] = [];
    const removeA = await client.subscribeKalVoice((s) => a.push(s.kind));
    const removeB = await client.subscribeKalVoice((s) => b.push(s.kind));
    removeA();
    const removeC = await client.subscribeKalVoice(() => undefined);
    removeC();
    expect(subscribe).toHaveBeenCalledTimes(1);

    await client.kalvoiceListenStart("talk");
    await tick();
    expect(b).toContain("listening_started");
    expect(a).toEqual([]);
    await client.kalvoiceListenCancel();
    removeB();
  });

  it("renewing replaces the window's channel without duplicating signals (native replace semantics)", async () => {
    const { client, subscribe } = setup();
    const seen: KalVoiceSignal[] = [];
    await client.subscribeKalVoice((s) => seen.push(s));
    await client.renewKalVoiceSubscription();
    await client.renewKalVoiceSubscription();
    expect(subscribe).toHaveBeenCalledTimes(3);
    await client.kalvoiceListenStart("talk");
    await tick();
    expect(seen.filter((s) => s.kind === "listening_started")).toHaveLength(1);
    await client.kalvoiceListenCancel();
  });

  it("a failed native subscribe is retried by the next listener instead of leaving no channel", async () => {
    const { client, subscribe } = setup();
    subscribe.mockRejectedValueOnce({ category: "internal", code: "kalvoice_off", message: "Off.", retryable: true });
    await expect(client.subscribeKalVoice(() => undefined)).rejects.toMatchObject({ code: "kalvoice_off" });
    const seen: string[] = [];
    await client.subscribeKalVoice((s) => seen.push(s.kind));
    expect(subscribe).toHaveBeenCalledTimes(2);
    await client.kalvoiceListenStart("talk");
    await tick();
    expect(seen).toContain("listening_started");
    await client.kalvoiceListenCancel();
  });
});
