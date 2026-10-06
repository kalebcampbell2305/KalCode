import { describe, expect, it } from "vitest";
import { globalShortcut, isRailToggleShortcut } from "./shortcuts.ts";

function key(
  value: string,
  overrides: Partial<Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey">> = {},
) {
  return {
    key: value,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("global shortcuts", () => {
  it("retraces navigation with native platform chords and opens settings consistently", () => {
    expect(globalShortcut(key("ArrowLeft", { altKey: true }), "windows")).toBe("back");
    expect(globalShortcut(key("ArrowRight", { altKey: true }), "windows")).toBe("forward");
    expect(globalShortcut(key("[", { metaKey: true }), "macos")).toBe("back");
    expect(globalShortcut(key("]", { metaKey: true }), "macos")).toBe("forward");
    expect(globalShortcut(key(",", { ctrlKey: true }), "windows")).toBe("open-settings");
    expect(globalShortcut(key(",", { metaKey: true }), "macos")).toBe("open-settings");
    expect(globalShortcut(key("ArrowLeft", { altKey: true, ctrlKey: true }), "windows")).toBeNull();
  });

  it("leaves Option+Arrow to word movement on macOS", () => {
    expect(globalShortcut(key("ArrowLeft", { altKey: true }), "macos")).toBeNull();
    expect(globalShortcut(key("ArrowRight", { altKey: true }), "macos")).toBeNull();
  });
  it("uses Command on macOS and Control on Windows", () => {
    expect(globalShortcut(key("k", { metaKey: true }), "macos")).toBe("open-palette");
    expect(globalShortcut(key("K", { ctrlKey: true }), "windows")).toBe("open-palette");
    expect(globalShortcut(key("b", { metaKey: true }), "macos")).toBe("toggle-sidebar");
    expect(globalShortcut(key("b", { ctrlKey: true }), "windows")).toBe("toggle-sidebar");
  });

  it("rejects the non-native modifier and modified chords", () => {
    expect(globalShortcut(key("k", { ctrlKey: true }), "macos")).toBeNull();
    expect(globalShortcut(key("k", { metaKey: true }), "windows")).toBeNull();
    expect(globalShortcut(key("k", { metaKey: true, ctrlKey: true }), "macos")).toBeNull();
    expect(globalShortcut(key("k", { metaKey: true, shiftKey: true }), "macos")).toBeNull();
    expect(globalShortcut(key("k", { ctrlKey: true, altKey: true }), "windows")).toBeNull();
  });

  it("uses the shifted native chord for the workspace rail", () => {
    expect(isRailToggleShortcut(key("b", { metaKey: true, shiftKey: true }), "macos")).toBe(true);
    expect(isRailToggleShortcut(key("b", { ctrlKey: true, shiftKey: true }), "windows")).toBe(true);
    expect(isRailToggleShortcut(key("b", { ctrlKey: true, shiftKey: true }), "macos")).toBe(false);
    expect(isRailToggleShortcut(key("b", { metaKey: true, shiftKey: true }), "windows")).toBe(false);
  });
});
