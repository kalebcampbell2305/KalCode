import { afterEach, describe, expect, it, vi } from "vitest";
import { blockingBrowserOverlayOpen, browserSurfaceVisible, subscribeBrowserLayout } from "./browserVisibility.ts";

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

it("hides a native browser when its scrolled viewport would paint over canvas chrome", () => {
  const canvas = document.createElement("div");
  canvas.setAttribute("data-pane-canvas", "");
  canvas.getBoundingClientRect = () => new DOMRect(100, 100, 700, 500);
  const host = document.createElement("div");
  host.getBoundingClientRect = () => new DOMRect(110, 130, 400, 300);
  canvas.append(host);
  document.body.append(canvas);
  expect(browserSurfaceVisible(host, true)).toBe(true);
  host.getBoundingClientRect = () => new DOMRect(90, 130, 400, 300);
  expect(browserSurfaceVisible(host, true)).toBe(false);
});

it("notifies native browser bounds subscribers when a canvas scrolls", () => {
  const canvas = document.createElement("div");
  document.body.append(canvas);
  const changed = vi.fn();
  const stop = subscribeBrowserLayout(changed);
  canvas.dispatchEvent(new Event("scroll"));
  expect(changed).toHaveBeenCalledTimes(1);
  stop();
  canvas.dispatchEvent(new Event("scroll"));
  expect(changed).toHaveBeenCalledTimes(1);
});

it("ignores dialogs in kept-mounted hidden content", () => {
  const hiddenPane = document.createElement("div");
  hiddenPane.hidden = true;
  hiddenPane.innerHTML = '<div role="alertdialog">Stop provider?</div>';
  document.body.append(hiddenPane);
  expect(blockingBrowserOverlayOpen()).toBe(false);
  hiddenPane.hidden = false;
  expect(blockingBrowserOverlayOpen()).toBe(true);
});
