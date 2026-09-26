import { afterEach, describe, expect, it } from "vitest";
import { blockingBrowserOverlayOpen, browserSurfaceVisible } from "./browserVisibility.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("browser native child visibility", () => {
  it("hides while a trusted modal is open so WebView2 cannot paint over it", () => {
    const host = document.createElement("div");
    host.getBoundingClientRect = () => ({
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 510,
      bottom: 410,
      width: 500,
      height: 400,
      toJSON: () => ({}),
    });
    document.body.append(host);
    expect(browserSurfaceVisible(host, true)).toBe(true);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    expect(blockingBrowserOverlayOpen()).toBe(true);
    expect(browserSurfaceVisible(host, true)).toBe(false);
  });

  it("hides for route transitions and disconnected hosts", () => {
    const host = document.createElement("div");
    host.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 300,
      bottom: 300,
      width: 300,
      height: 300,
      toJSON: () => ({}),
    });
    document.body.append(host);
    expect(browserSurfaceVisible(host, false)).toBe(false);
    host.remove();
    expect(browserSurfaceVisible(host, true)).toBe(false);
  });
});
