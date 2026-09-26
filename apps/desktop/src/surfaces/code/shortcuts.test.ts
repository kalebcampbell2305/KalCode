import { describe, expect, it } from "vitest";
import { codeShortcut } from "./shortcuts.ts";

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
  } as KeyboardEvent;
}

describe("terminal-safe Code shortcuts", () => {
  it("keeps the existing Control chords on Windows", () => {
    expect(codeShortcut(key("Tab", { ctrlKey: true }))).toBe("next-tab");
    expect(codeShortcut(key("W", { ctrlKey: true, shiftKey: true }))).toBe("close-tab");
  });

  it("does not capture Command chords reserved by macOS", () => {
    expect(codeShortcut(key("Tab", { metaKey: true }))).toBeNull();
    expect(codeShortcut(key("w", { metaKey: true, shiftKey: true }))).toBeNull();
  });

  it("does not turn Control+C or Control+V into application commands", () => {
    expect(codeShortcut(key("c", { ctrlKey: true }))).toBeNull();
    expect(codeShortcut(key("v", { ctrlKey: true }))).toBeNull();
  });
});
