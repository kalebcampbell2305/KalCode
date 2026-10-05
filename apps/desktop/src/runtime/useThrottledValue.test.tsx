import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThrottledValue } from "./useThrottledValue.ts";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useThrottledValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("passes the first change at once and collapses a burst into one trailing update", () => {
    const seen: number[] = [];
    const { result, rerender } = renderHook(
      ({ value }) => {
        const shown = useThrottledValue(value, 500);
        if (seen.at(-1) !== shown) seen.push(shown);
        return shown;
      },
      { initialProps: { value: 0 } },
    );

    rerender({ value: 1 });
    expect(result.current).toBe(1);

    for (let value = 2; value <= 40; value += 1) rerender({ value });
    expect(result.current).toBe(1);

    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(40);
    expect(seen).toEqual([0, 1, 40]);
  });

  it("holds changes while the window is hidden and passes the newest when it is shown", () => {
    const { result, rerender } = renderHook(({ value }) => useThrottledValue(value, 500), {
      initialProps: { value: 0 },
    });
    act(() => setVisibility("hidden"));
    rerender({ value: 1 });
    rerender({ value: 2 });
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current).toBe(0);

    act(() => setVisibility("visible"));
    expect(result.current).toBe(2);
  });
});
