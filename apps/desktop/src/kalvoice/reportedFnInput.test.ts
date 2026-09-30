import { describe, expect, it, vi } from "vitest";
import { attachReportedFnInput } from "./reportedFnInput.ts";

function fixture() {
  const listeners = new Map<string, EventListener>();
  const target = {
    addEventListener: vi.fn((kind: string, listener: EventListener) => listeners.set(kind, listener)),
    removeEventListener: vi.fn((kind: string) => listeners.delete(kind)),
  } as unknown as Window;
  const send = vi.fn<(input: "down" | "up" | "other") => Promise<boolean>>().mockResolvedValue(true);
  const unavailable = vi.fn();
  const stop = attachReportedFnInput(target, send, unavailable);
  const fire = (kind: string, fields: Partial<KeyboardEvent> = {}) => {
    const event = {
      key: "Fn",
      code: "Fn",
      isTrusted: true,
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...fields,
    } as unknown as KeyboardEvent;
    listeners.get(kind)?.(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  };
  const flush = async () => {
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { send, unavailable, stop, fire, flush, listeners };
}

describe("reported Windows Fn input", () => {
  it("forwards a real Fn down/up pair without consuming either event", async () => {
    const f = fixture();
    f.fire("keydown");
    f.fire("keyup");
    await f.flush();
    expect(f.send.mock.calls).toEqual([["down"], ["up"]]);
  });
  it.each(["F8", "Unidentified", "FnLock", "KeyA"])("never guesses that %s is Fn", async (key) => {
    const f = fixture();
    f.fire("keydown", { key, code: key });
    f.fire("keyup", { key, code: key });
    await Promise.resolve();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("ignores synthetic events and repeat-only presses", async () => {
    const f = fixture();
    f.fire("keydown", { isTrusted: false });
    f.fire("keyup", { isTrusted: false });
    f.fire("keydown", { repeat: true });
    await Promise.resolve();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("recognizes Fn by its reported key even when code is unidentified", async () => {
    const f = fixture();
    f.fire("keydown", { code: "Unidentified" });
    f.fire("keyup", { code: "Unidentified" });
    await f.flush();
    expect(f.send.mock.calls).toEqual([["down"], ["up"]]);
  });
  it("sends one chord cancellation and does not forward other key identities", async () => {
    const f = fixture();
    f.fire("keydown");
    f.fire("keydown", { key: "F8", code: "F8" });
    f.fire("keydown", { key: "a", code: "KeyA" });
    f.fire("keyup");
    await f.flush();
    expect(f.send.mock.calls).toEqual([["down"], ["other"], ["up"]]);
  });
  it("suppresses a hold when a previously held other key repeats", async () => {
    const f = fixture();
    f.fire("keydown");
    f.fire("keydown", { key: "a", code: "KeyA", repeat: true });
    f.fire("keyup");
    await f.flush();
    expect(f.send.mock.calls).toEqual([["down"], ["other"], ["up"]]);
  });
  it.each(["ctrlKey", "altKey", "metaKey", "shiftKey"])("suppresses Fn when %s was already held", async (modifier) => {
    const f = fixture();
    f.fire("keydown", { [modifier]: true });
    f.fire("keyup");
    await f.flush();
    expect(f.send.mock.calls).toEqual([["other"], ["up"]]);
  });
  it("releases on blur and removes every listener on cleanup", async () => {
    const f = fixture();
    f.fire("keydown");
    f.fire("blur");
    f.stop();
    await f.flush();
    expect(f.send.mock.calls).toEqual([["down"], ["up"]]);
    expect(f.listeners.size).toBe(0);
  });
  it("releases a held Fn on unmount", async () => {
    const f = fixture();
    f.fire("keydown");
    f.stop();
    await f.flush();
    expect(f.send.mock.calls).toEqual([["down"], ["up"]]);
  });
  it("orders release after an in-flight press", async () => {
    const f = fixture();
    let resolve!: (accepted: boolean) => void;
    f.send.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    f.fire("keydown");
    f.fire("keyup");
    await Promise.resolve();
    expect(f.send.mock.calls).toEqual([["down"]]);
    resolve(true);
    await f.flush();
    expect(f.send.mock.calls).toEqual([["down"], ["up"]]);
  });
  it("reports failed admission and still delivers cleanup after rejection", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error("native unavailable"));
    f.fire("keydown");
    f.fire("keyup");
    await f.flush();
    expect(f.unavailable).toHaveBeenCalledOnce();
    expect(f.send.mock.calls).toEqual([["down"], ["up"]]);
  });
  it("reports a native refusal without claiming Fn is available", async () => {
    const f = fixture();
    f.send.mockResolvedValueOnce(false);
    f.fire("keydown");
    await f.flush();
    expect(f.unavailable).toHaveBeenCalledOnce();
  });
});
