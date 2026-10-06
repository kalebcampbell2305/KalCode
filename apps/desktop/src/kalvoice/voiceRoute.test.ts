import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lightTarget,
  motionReduced,
  routeDestination,
  routeVoice,
  VOICE_ROUTE_EVENT,
  VOICE_TARGET_ATTR,
} from "./voiceRoute.ts";

/** jsdom has no layout: give elements a box so they count as on screen. */
function sized(el: HTMLElement, box = { left: 10, top: 20, width: 200, height: 100 }) {
  el.getBoundingClientRect = () =>
    ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height }) as DOMRect;
  return el;
}

beforeEach(() => {
  document.body.innerHTML = `
    <nav aria-label="Primary"><button id="code">Code</button><button id="activity" aria-current="page">Activity</button></nav>
    <main id="main">
      <div data-pane-id="p1"></div>
      <div data-pane-id="p2" data-focused></div>
      <ul><li id="row"><button id="run">Failed run</button></li></ul>
    </main>
    <section data-kalvoice-widget><button id="orb">orb</button></section>`;
  for (const el of document.querySelectorAll<HTMLElement>("*")) sized(el);
});

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-motion");
});

describe("routeDestination", () => {
  it("lands a surface on its active sidebar entry", () => {
    expect(routeDestination("surface")?.id).toBe("activity");
  });

  it("lands a pane command on the focused pane", () => {
    expect(routeDestination("pane")?.dataset.paneId).toBe("p2");
  });

  it("lands a focus command on the focused row, never on KalVoice itself", () => {
    document.getElementById("run")?.focus();
    expect(routeDestination("focus")?.id).toBe("row");
    document.getElementById("orb")?.focus();
    expect(routeDestination("focus")?.id).toBe("main");
  });

  it("falls back to the page, and to nothing when nothing is on screen", () => {
    document.querySelector("[aria-current]")?.removeAttribute("aria-current");
    expect(routeDestination("surface")?.id).toBe("main");
    sized(document.getElementById("main") as HTMLElement, { left: 0, top: 0, width: 0, height: 0 });
    expect(routeDestination("surface")).toBeNull();
  });
});

describe("routeVoice", () => {
  it("lights the destination briefly and tells the widget where the comet goes", () => {
    vi.useFakeTimers();
    const heard = vi.fn();
    window.addEventListener(VOICE_ROUTE_EVENT, heard);
    routeVoice("pane");
    vi.advanceTimersByTime(0);
    const pane = document.querySelector<HTMLElement>("[data-pane-id='p2']");
    expect(pane?.hasAttribute(VOICE_TARGET_ATTR)).toBe(true);
    const event = heard.mock.calls[0]?.[0] as CustomEvent | undefined;
    expect(event?.detail.to).toEqual({ x: 10, y: 20, width: 200, height: 100 });
    vi.advanceTimersByTime(1_200);
    expect(pane?.hasAttribute(VOICE_TARGET_ATTR)).toBe(false);
    window.removeEventListener(VOICE_ROUTE_EVENT, heard);
  });

  it("waits a moment for a pane that is still opening, then uses the page", () => {
    vi.useFakeTimers();
    document.querySelector("[data-focused]")?.removeAttribute("data-focused");
    routeVoice("pane");
    vi.advanceTimersByTime(300);
    expect(document.getElementById("main")?.hasAttribute(VOICE_TARGET_ATTR)).toBe(false);
    vi.advanceTimersByTime(600);
    expect(document.getElementById("main")?.hasAttribute(VOICE_TARGET_ATTR)).toBe(true);
  });

  it("does nothing once the command was cancelled", () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    routeVoice("surface", controller.signal);
    vi.advanceTimersByTime(1_000);
    expect(document.querySelector(`[${VOICE_TARGET_ATTR}]`)).toBeNull();
  });

  it("relights rather than stacking timers when routed twice", () => {
    vi.useFakeTimers();
    const el = document.getElementById("code") as HTMLElement;
    lightTarget(el);
    vi.advanceTimersByTime(900);
    lightTarget(el);
    vi.advanceTimersByTime(900);
    expect(el.hasAttribute(VOICE_TARGET_ATTR)).toBe(true);
    vi.advanceTimersByTime(300);
    expect(el.hasAttribute(VOICE_TARGET_ATTR)).toBe(false);
  });
});

describe("motionReduced", () => {
  it("follows the app setting first", () => {
    document.documentElement.dataset.motion = "reduced";
    expect(motionReduced()).toBe(true);
    document.documentElement.dataset.motion = "full";
    expect(motionReduced()).toBe(false);
  });
});
