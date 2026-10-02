// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { morphIntoThread } from "./morph.ts";

type Update = () => Promise<void> | void;

describe("fleet card morph", () => {
  let update: Update | null;

  beforeEach(() => {
    vi.useFakeTimers();
    update = null;
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    (document as unknown as { startViewTransition: unknown }).startViewTransition = (next: Update) => {
      update = next;
      return { finished: new Promise<void>(() => undefined), updateCallbackDone: Promise.resolve() };
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  });

  it("does not hold the paused page while a slow open is still running", async () => {
    let finishOpen!: () => void;
    const open = vi.fn(() => new Promise<void>((resolve) => (finishOpen = resolve)));
    morphIntoThread(document.createElement("div"), "t1", open);
    let done = false;
    const callback = Promise.resolve(update?.()).then(() => {
      done = true;
    });
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await callback;
    expect(done).toBe(true);
    // The open keeps running and finishes later on its own.
    finishOpen();
  });

  it("does not leave a failed slow open unhandled", async () => {
    let failOpen!: (error: Error) => void;
    const open = () => new Promise<void>((_, reject) => (failOpen = reject));
    morphIntoThread(document.createElement("div"), "t1", open);
    const callback = Promise.resolve(update?.());
    await vi.advanceTimersByTimeAsync(100);
    await callback;
    failOpen(new Error("ipc"));
    await vi.advanceTimersByTimeAsync(0);
  });
});
