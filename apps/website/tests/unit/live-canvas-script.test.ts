// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { canvasState } from "../../src/lib/live/canvas";
import { initialState } from "../../src/lib/live/model";
import { mountAdaptiveCanvas, snapZone } from "../../src/scripts/live/canvas";

afterEach(() => document.body.replaceChildren());
it("moves and focuses panes by keyboard without changing sessions", () => {
  const state = initialState();
  const tabs = state.tabs;
  const host = document.createElement("div");
  host.innerHTML =
    '<div data-canvas-frame="f1" tabindex="-1"><input data-key="draft"></div><div data-canvas-frame="f2" tabindex="-1"></div><div data-canvas-frame="f3" tabindex="-1"></div>';
  document.body.append(host);
  const render = vi.fn();
  const canvas = mountAdaptiveCanvas(host, { getState: () => state, render });
  host.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, altKey: true, shiftKey: true, bubbles: true }),
  );
  expect(state.frames.map((frame) => frame.id)).toEqual(["f2", "f1", "f3"]);
  expect(state.tabs).toBe(tabs);
  expect(render).toHaveBeenCalledTimes(1);
  canvas.destroy();
});
it("restores typed drafts after a tab crosses frames and handles balance without inline styles", () => {
  const state = initialState();
  const host = document.createElement("div");
  host.innerHTML = '<input data-key="draft" value=""><input type="range" data-canvas-resize value="50">';
  document.body.append(host);
  const canvas = mountAdaptiveCanvas(host, { getState: () => state, render: vi.fn() });
  const draft = host.querySelector<HTMLInputElement>("[data-key]");
  if (!draft) throw new Error("draft input missing");
  draft.value = "unfinished command";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  const balance = host.querySelector<HTMLInputElement>("[data-canvas-resize]");
  if (!balance) throw new Error("balance control missing");
  balance.value = "60";
  balance.dispatchEvent(new Event("input", { bubbles: true }));
  expect(canvasState(state).share).toBe(60);
  host.innerHTML = '<input data-key="draft" value="">';
  canvas.afterRender();
  expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("unfinished command");
  expect(host.querySelector("[style]")).toBeNull();
  canvas.destroy();
});
it("uses magnetic snap hysteresis and an explicit tab zone", () => {
  expect(snapZone(0.1, null)).toBe("before");
  expect(snapZone(0.31, "before")).toBe("before");
  expect(snapZone(0.5, "before")).toBe("tabs");
  expect(snapZone(0.9, null)).toBe("after");
});

it("shows live magnetic placement and commits a pane move only on drop", () => {
  const state = initialState();
  const host = document.createElement("div");
  host.innerHTML =
    '<section data-canvas-frame="f1"><button data-canvas-grip="f1">Move</button></section><section data-canvas-frame="f2" tabindex="-1"></section>';
  document.body.append(host);
  const target = host.querySelector<HTMLElement>('[data-canvas-frame="f2"]');
  const grip = host.querySelector("button");
  if (!target || !grip) throw new Error("missing drag fixture");
  target.getBoundingClientRect = () => new DOMRect(300, 0, 300, 220);
  const originalHit = document.elementFromPoint;
  document.elementFromPoint = () => target;
  const canvas = mountAdaptiveCanvas(host, { getState: () => state, render: vi.fn() });
  try {
    grip.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 20, clientY: 20, bubbles: true }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 580, clientY: 100 }));
    expect(target.dataset.canvasSnap).toBe("after");
    expect(state.frames.map((frame) => frame.id)).toEqual(["f1", "f2", "f3"]);
    window.dispatchEvent(new MouseEvent("pointerup"));
    expect(state.frames.map((frame) => frame.id)).toEqual(["f2", "f1", "f3"]);
    expect(target.hasAttribute("data-canvas-snap")).toBe(false);
  } finally {
    canvas.destroy();
    document.elementFromPoint = originalHit;
  }
});
