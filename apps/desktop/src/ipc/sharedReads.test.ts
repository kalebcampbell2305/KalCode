import { describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "./client.ts";
import type { Transport } from "./transport.ts";

/** A transport whose reads stay in flight until released. */
function gatedTransport() {
  const pending: (() => void)[] = [];
  let onEvent: ((event: unknown) => void) | null = null;
  const invoke = vi.fn(
    (command: string) =>
      new Promise((resolve) => {
        pending.push(() => resolve(command.endsWith("_list") ? [{ id: "one", name: "One" }] : { id: "one" }));
      }),
  );
  const transport = {
    invoke,
    subscribe: async (listener: (event: unknown) => void) => {
      onEvent = listener;
      return async () => undefined;
    },
  } as unknown as Transport;
  return {
    transport,
    invoke,
    release: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
    emit: () => onEvent?.({ seq: 1 }),
  };
}

describe("shared in-flight reads", () => {
  it("identical concurrent list reads share one native call, each caller getting its own copy", async () => {
    const gate = gatedTransport();
    const client = new KalCodeClient(gate.transport);
    const first = client.listProviderAccounts();
    const second = client.listProviderAccounts();
    const other = client.listProviderAccounts("codex");
    gate.release();
    const [a, b] = await Promise.all([first, second, other]);
    expect(gate.invoke).toHaveBeenCalledTimes(2);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
  });

  it("a read never joins one that started before a change (a command or an event)", async () => {
    const gate = gatedTransport();
    const client = new KalCodeClient(gate.transport);
    await client.subscribeEvents(() => undefined);
    void client.listThreads();
    void client.renameThread("one", "Renamed");
    void client.listThreads();
    expect(gate.invoke.mock.calls.filter(([command]) => command === "thread_list")).toHaveLength(2);
    gate.emit();
    void client.listThreads();
    expect(gate.invoke.mock.calls.filter(([command]) => command === "thread_list")).toHaveLength(3);
    gate.release();
  });

  it("does not share commands that change state", async () => {
    const gate = gatedTransport();
    const client = new KalCodeClient(gate.transport);
    void client.stopThread("one");
    void client.stopThread("one");
    expect(gate.invoke).toHaveBeenCalledTimes(2);
    gate.release();
  });
});
