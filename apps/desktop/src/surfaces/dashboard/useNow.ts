import { useState, useSyncExternalStore } from "react";

/**
 * One shared clock for every relative time in the app ("4m ago", "Started 2m ago", "Resets in…").
 * It ticks on wall-clock 30 s boundaries, only while something reads it, so every reader's tick
 * lands in the same task and React renders them in one commit instead of one timer each.
 */
export const CLOCK_TICK_MS = 30_000;

/** The latest boundary the clock has reached (fresh whenever the first reader subscribes). */
let tick = boundary(Date.now());
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

/** A timer can fire a hair early; the slack keeps that from reading as the previous boundary. */
function boundary(at: number): number {
  return Math.floor((at + 50) / CLOCK_TICK_MS) * CLOCK_TICK_MS;
}

function schedule() {
  timer = setTimeout(
    () => {
      tick = boundary(Date.now());
      schedule();
      for (const listener of [...listeners]) listener();
    },
    Math.max(0, tick + CLOCK_TICK_MS - Date.now()),
  );
}

function subscribeClock(listener: () => void): () => void {
  if (listeners.size === 0) {
    tick = boundary(Date.now());
    schedule();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
}

/** Something that says whether a reader is on screen (Code's shown store, for one). */
export interface ClockGate {
  get(): boolean;
  subscribe(listener: () => void): () => void;
}

const gated = new WeakMap<ClockGate, (listener: () => void) => () => void>();

/** Listens to the clock only while the gate is open; opening it re-checks the reader's texts. */
function gatedSubscribe(gate: ClockGate): (listener: () => void) => () => void {
  let subscribe = gated.get(gate);
  if (!subscribe) {
    subscribe = (listener) => {
      let stop = gate.get() ? subscribeClock(listener) : undefined;
      const stopGate = gate.subscribe(() => {
        if (gate.get() === (stop !== undefined)) return;
        stop?.();
        stop = gate.get() ? subscribeClock(listener) : undefined;
        listener();
      });
      return () => {
        stopGate();
        stop?.();
      };
    };
    gated.set(gate, subscribe);
  }
  return subscribe;
}

/**
 * The time a reader shows: never older than when it mounted (a new row's "just now" can't read
 * as before it started), then the shared boundary once the clock passes that.
 */
function reading(mountedAt: number, intervalMs = CLOCK_TICK_MS): number {
  return Math.max(mountedAt, Math.floor(tick / intervalMs) * intervalMs);
}

/** Re-renders every `intervalMs` (a multiple of 30 s) so relative times and run durations stay accurate. */
export function useNow(intervalMs = CLOCK_TICK_MS): number {
  const [mountedAt] = useState(Date.now);
  return useSyncExternalStore(subscribeClock, () => reading(mountedAt, intervalMs));
}

/**
 * The shared clock's reading, re-rendering only when `texts(now)` changes: pass every text the
 * component derives from the time (joined into one string), so a tick that changes none of them
 * renders nothing. With a `gate`, the reader stops listening while it is off screen and catches
 * up when it is shown again.
 */
export function useClock(texts: (now: number) => string | number | boolean | null, gate?: ClockGate): number {
  const [mountedAt] = useState(Date.now);
  useSyncExternalStore(gate ? gatedSubscribe(gate) : subscribeClock, () => texts(reading(mountedAt)));
  return reading(mountedAt);
}

/** Moves focus to a section so keyboard and screen-reader users land where the summary points. */
export function focusSection(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  const heading = section.querySelector<HTMLElement>("h2");
  const target = heading ?? section;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.scrollIntoView({ block: "start", behavior: "smooth" });
  target.focus({ preventScroll: true });
}
