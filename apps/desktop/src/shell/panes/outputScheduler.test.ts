import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLUSH_INTERVAL_MS, OutputScheduler } from "./outputScheduler.ts";

function fakeTerminal() {
  const writes: Uint8Array[] = [];
  return {
    writes,
    write(data: Uint8Array, callback?: () => void) {
      writes.push(data);
      callback?.();
    },
  };
}

const bytes = (...values: number[]) => new Uint8Array(values);

describe("OutputScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders every chunk at once for the focused pane", () => {
    const term = fakeTerminal();
    const acked: number[] = [];
    const scheduler = new OutputScheduler(term, (n) => acked.push(n));
    scheduler.push(bytes(1));
    scheduler.push(bytes(2, 3));
    expect(term.writes).toEqual([bytes(1), bytes(2, 3)]);
    expect(acked).toEqual([1, 2]);
  });

  it("batches an unfocused pane's output to at most 4 renders a second, acknowledging after render", () => {
    const term = fakeTerminal();
    const acked: number[] = [];
    const scheduler = new OutputScheduler(term, (n) => acked.push(n));
    scheduler.setThrottled(true);
    // 100 chunks over one second.
    for (let i = 0; i < 100; i++) {
      scheduler.push(bytes(i % 256));
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(term.writes.length).toBeLessThanOrEqual(5);
    expect(term.writes.length).toBeGreaterThanOrEqual(4);
    const total = term.writes.reduce((a, w) => a + w.length, 0);
    expect(total).toBe(100);
    expect(acked.reduce((a, b) => a + b, 0)).toBe(100);
    // Order is preserved.
    const joined = term.writes.flatMap((w) => [...w]);
    expect(joined).toEqual(Array.from({ length: 100 }, (_, i) => i % 256));
  });

  it("renders what is queued as soon as the pane gets focus", () => {
    const term = fakeTerminal();
    const scheduler = new OutputScheduler(term, () => undefined);
    scheduler.setThrottled(true);
    scheduler.push(bytes(1));
    scheduler.push(bytes(2));
    expect(term.writes).toEqual([]);
    scheduler.setThrottled(false);
    expect(term.writes).toEqual([bytes(1, 2)]);
  });

  it("drops queued output on clear and never writes after dispose", () => {
    const term = fakeTerminal();
    const scheduler = new OutputScheduler(term, () => undefined);
    scheduler.setThrottled(true);
    scheduler.push(bytes(1));
    scheduler.clear();
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS * 2);
    expect(term.writes).toEqual([]);
    scheduler.push(bytes(2));
    scheduler.dispose();
    vi.advanceTimersByTime(FLUSH_INTERVAL_MS * 2);
    scheduler.push(bytes(3));
    expect(term.writes).toEqual([]);
  });
});
