import { describe, expect, it } from "vitest";
import { canvasAction, canvasState, visibleCanvasFrames } from "../../src/lib/live/canvas";
import { frameOfTab, initialState, tabOfAgent } from "../../src/lib/live/model";
import { applyDemoContextAction, demoContextItems } from "../../src/scripts/live/contextMenus";

describe("live demo context actions", () => {
  it("duplicates the clicked agent's configuration into a fresh coding session", () => {
    const state = initialState();
    const source = state.agents.a2;
    if (!source) throw new Error("Missing sample Codex agent");
    const original = JSON.stringify(source);
    applyDemoContextAction(state, { kind: "tab", id: "t-a2" }, "duplicate");
    const copy = state.agents[state.order.at(-1) ?? ""];
    if (!copy) throw new Error("Missing duplicate agent");
    expect(copy.id).not.toBe(source.id);
    expect([copy.provider, copy.account, copy.model, copy.effort]).toEqual([
      source.provider,
      source.account,
      source.model,
      source.effort,
    ]);
    expect(copy.status).toBe("starting");
    expect(state.tabs[tabOfAgent(state, copy.id) ?? ""]?.kind).toBe("agent");
    expect(JSON.stringify(source)).toBe(original);
  });
  it("opens Browser beside the clicked agent even while another pane is focused", () => {
    const state = initialState();
    state.focus = "f3";
    applyDemoContextAction(state, { kind: "tab", id: "t-a1" }, "browser");
    const browser = Object.values(state.tabs).find((tab) => tab.kind === "browser");
    if (!browser) throw new Error("Missing Browser pane");
    expect(state.frames[1]).toBe(frameOfTab(state, browser.id));
    expect(state.frames[0]?.id).toBe("f1");
  });
  it("reveals Browser beside the clicked agent after Focus layout and a minimized source", () => {
    const state = initialState();
    canvasAction(state, "canvas:layout:focus");
    canvasState(state).minimized.add("f2");
    applyDemoContextAction(state, { kind: "tab", id: "t-a2" }, "browser");
    const browser = Object.values(state.tabs).find((tab) => tab.kind === "browser");
    if (!browser) throw new Error("Missing Browser pane");
    const frames = visibleCanvasFrames(state);
    expect(frames).toContain(frameOfTab(state, "t-a2"));
    expect(frames).toContain(frameOfTab(state, browser.id));
  });
  it("splits an existing Browser out of the clicked source's tab group", () => {
    const state = initialState();
    applyDemoContextAction(state, { kind: "tab", id: "t-a1" }, "browser");
    const browser = Object.values(state.tabs).find((tab) => tab.kind === "browser");
    if (!browser) throw new Error("Missing Browser pane");
    const browserFrame = frameOfTab(state, browser.id);
    canvasAction(state, `canvas:move:${browserFrame?.id}:tabs:f1`);
    applyDemoContextAction(state, { kind: "tab", id: "t-a1" }, "browser");
    expect(state.frames[0]?.active).toBe("t-a1");
    expect(state.frames[1]?.active).toBe(browser.id);
    expect(frameOfTab(state, browser.id)).not.toBe(frameOfTab(state, "t-a1"));
  });
  it("stops and closes only the selected object and hides Stop once idle", () => {
    const state = initialState();
    applyDemoContextAction(state, { kind: "tab", id: "t-a1" }, "stop");
    expect(state.agents.a1?.status).toBe("idle");
    expect(state.agents.a2?.status).toBe("testing");
    expect(demoContextItems(state, { kind: "tab", id: "t-a1" }).map((item) => item.action)).not.toContain("stop");
    applyDemoContextAction(state, { kind: "tab", id: "t-a1" }, "close");
    expect(state.tabs["t-a1"]).toBeUndefined();
    expect(state.tabs["t-a2"]).toBeDefined();
    expect(demoContextItems(state, { kind: "tab", id: "t-a1" })).toEqual([]);
  });
  it("shows only real sample-workspace actions and scopes copied output", () => {
    const state = initialState();
    expect(demoContextItems(state, { kind: "workspace" }).map((item) => item.action)).toEqual(["launcher", "browser"]);
    const text = applyDemoContextAction(state, { kind: "output", id: "t-a2" }, "copy");
    expect(text).toBe(
      state.agents.a2?.lines
        .slice(-40)
        .map((line) => line.t)
        .join("\n"),
    );
  });
  it("keeps terminal output actions separate from terminal object actions", () => {
    const state = initialState();
    expect(demoContextItems(state, { kind: "output", id: "t-a1" })).toEqual([
      { action: "copy", label: "Copy relevant context" },
    ]);
    expect(demoContextItems(state, { kind: "tab", id: "t-a1" }).map((item) => item.action)).not.toContain("copy");
    applyDemoContextAction(state, { kind: "output", id: "t-a1" }, "stop");
    expect(state.agents.a1?.status).toBe("working");
  });
});
