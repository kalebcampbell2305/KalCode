import { describe, expect, it } from "vitest";
import { paneShortcut, paneShortcutLabels } from "./paneShortcuts.ts";

function key(
  value: string,
  overrides: Partial<Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">> = {},
) {
  return {
    key: value,
    code: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("pane shortcuts", () => {
  it("preserves the Windows Control+Alt contract", () => {
    expect(paneShortcut(key("d", { code: "KeyD", ctrlKey: true, altKey: true }), "windows")).toEqual({
      kind: "split-right",
    });
    expect(paneShortcut(key("d", { code: "KeyD", metaKey: true, altKey: true }), "windows")).toBeNull();
    expect(paneShortcutLabels("windows").splitRight).toBe("Ctrl Alt D");
  });

  it("keeps Control+Option on macOS and reads physical letter codes", () => {
    expect(
      paneShortcut(key("∂", { code: "KeyD", ctrlKey: true, altKey: true }), "macos"),
      "Option+D produces ∂ on a Mac keyboard",
    ).toEqual({ kind: "split-right" });
    expect(paneShortcut(key("d", { code: "KeyD", metaKey: true, altKey: true }), "macos")).toBeNull();
    expect(paneShortcutLabels("macos").splitRight).toBe("⌃ ⌥ D");
  });

  it("maps shifted Mac chords and pane preset digits from KeyboardEvent.code", () => {
    expect(
      paneShortcut(key("Î", { code: "KeyD", ctrlKey: true, altKey: true, shiftKey: true }), "macos"),
    ).toEqual({ kind: "split-down" });
    expect(paneShortcut(key("™", { code: "Digit2", ctrlKey: true, altKey: true }), "macos")).toEqual({
      kind: "preset",
      preset: "two",
    });
    expect(paneShortcutLabels("macos").splitDown).toBe("⌃ ⌥ ⇧ D");
  });

  it("keeps directional and tab actions available on both platforms", () => {
    expect(
      paneShortcut(key("ArrowLeft", { code: "ArrowLeft", ctrlKey: true, altKey: true }), "macos"),
    ).toEqual({ kind: "focus", direction: "left" });
    expect(
      paneShortcut(key("PageDown", { code: "PageDown", ctrlKey: true, altKey: true }), "windows"),
    ).toEqual({ kind: "next-tab" });
  });
});
