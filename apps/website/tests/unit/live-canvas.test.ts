import { describe, expect, it } from "vitest";
import { canvasAction, canvasState, renderAdaptiveCanvas, renderCanvasTools } from "../../src/lib/live/canvas";
import { closeTab, initialState, openTerminal, tick } from "../../src/lib/live/model";

describe("Adaptive Canvas sample layouts", () => {
  it.each(["build", "debug", "review", "ship", "focus"])(
    "applies %s without replacing tabs, agents or their work",
    (task) => {
      const state = initialState();
      const tabs = state.tabs;
      const agents = state.agents;
      const identities = Object.values(tabs);
      canvasAction(state, `canvas:layout:${task}`);
      expect(state.tabs).toBe(tabs);
      expect(state.agents).toBe(agents);
      expect(Object.values(tabs)).toEqual(identities);
      expect(canvasState(state).task).toBe(task);
      expect(state.frames.flatMap((frame) => frame.tabs).sort()).toEqual(Object.keys(tabs).sort());
    },
  );
  it("undoes Tidy while preserving newly opened work and subsequent agent progress", () => {
    const state = initialState();
    canvasAction(state, "canvas:move:f1:after:f3");
    canvasAction(state, "canvas:minimize:f2");
    const before = state.frames.map((frame) => ({ ...frame, tabs: [...frame.tabs] }));
    canvasAction(state, "canvas:tidy");
    openTerminal(state);
    const newlyOpened = Object.values(state.tabs).at(-1);
    tick(state);
    const agents = structuredClone(state.agents);
    canvasAction(state, "canvas:undo");
    expect(state.frames.slice(0, before.length)).toEqual(before);
    expect(state.frames.flatMap((frame) => frame.tabs)).toContain(newlyOpened?.id);
    expect(state.agents).toEqual(agents);
    expect(canvasState(state).minimized.has("f2")).toBe(true);
  });
  it("preserves manual arrangements on ticks and supports minimize/restore without deletion", () => {
    const state = initialState();
    canvasAction(state, "canvas:move:f1:after:f3");
    const order = state.frames.map((frame) => frame.id);
    canvasAction(state, "canvas:minimize:f1");
    tick(state);
    expect(state.frames.map((frame) => frame.id)).toEqual(order);
    expect(canvasState(state).manual).toBe(true);
    canvasAction(state, "canvas:restore:f1");
    expect(state.focus).toBe("f1");
    expect(canvasState(state).minimized.size).toBe(0);
  });
  it("marks catalog availability and emits no inline styles", () => {
    const state = initialState();
    const html =
      renderCanvasTools(state) +
      renderAdaptiveCanvas(
        state,
        (_state, frame) =>
          `<section class="lk-frame" data-key="${frame.id}"><div class="lk-frame__end"></div></section>`,
      );
    expect(html).toContain("Adaptive Canvas");
    expect(html).toContain("data-canvas-frame");
    expect(html).not.toContain("style=");
    expect(html).toContain("Coming soon");
  });
});

it("undo never resurrects explicitly closed sessions and preserves tabs added to an existing frame", () => {
  const state = initialState();
  canvasAction(state, "canvas:tidy");
  const deleted = state.frames[0]?.active ?? "";
  closeTab(state, deleted);
  const existing = state.frames[0];
  if (!existing) throw new Error("missing sample frame");
  state.tabs.extra = { id: "extra", kind: "terminal", title: "New work" };
  existing.tabs.push("extra");
  canvasAction(state, "canvas:undo");
  const tabs = state.frames.flatMap((frame) => frame.tabs);
  expect(tabs).not.toContain(deleted);
  expect(tabs.filter((id) => id === "extra")).toHaveLength(1);
  expect(new Set(tabs).size).toBe(tabs.length);
});
