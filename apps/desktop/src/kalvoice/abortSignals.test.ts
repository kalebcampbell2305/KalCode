import { afterEach, describe, expect, it, vi } from "vitest";
import { combineAbortSignals } from "./abortSignals.ts";

const nativeAny = Object.getOwnPropertyDescriptor(AbortSignal, "any");

function removeNativeAny() {
  Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined, writable: true });
}

afterEach(() => {
  if (nativeAny) Object.defineProperty(AbortSignal, "any", nativeAny);
  vi.restoreAllMocks();
});

describe("combineAbortSignals", () => {
  it("uses the native implementation when the runtime provides it", () => {
    const expected = new AbortController().signal;
    const any = vi.spyOn(AbortSignal, "any").mockReturnValue(expected);
    const inputs = [new AbortController().signal, new AbortController().signal];

    expect(combineAbortSignals(inputs)).toBe(expected);
    expect(any).toHaveBeenCalledWith(inputs);
  });

  it("falls back when AbortSignal.any is unavailable and preserves the first abort reason", () => {
    removeNativeAny();
    const first = new AbortController();
    const second = new AbortController();
    const combined = combineAbortSignals([first.signal, second.signal]);

    first.abort("first reason");
    second.abort("second reason");

    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe("first reason");
  });

  it("returns an already-aborted fallback with its reason", () => {
    removeNativeAny();
    const stopped = new AbortController();
    stopped.abort("already stopped");

    const combined = combineAbortSignals([new AbortController().signal, stopped.signal]);

    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe("already stopped");
  });

  it("removes every fallback listener after the first abort", () => {
    removeNativeAny();
    const first = new AbortController();
    const second = new AbortController();
    const firstRemove = vi.spyOn(first.signal, "removeEventListener");
    const secondRemove = vi.spyOn(second.signal, "removeEventListener");

    combineAbortSignals([first.signal, second.signal]);
    first.abort("done");

    expect(firstRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(secondRemove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
