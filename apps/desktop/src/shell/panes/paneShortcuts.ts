/**
 * Keyboard shortcuts of the pane canvas. They work anywhere in the canvas, including inside a
 * terminal or a provider's TUI (terminal views don't send them to the process).
 *
 * Ctrl+Alt is the pane chord: shells and TUIs don't rely on it, and AltGr characters (which
 * Windows reports as Ctrl+Alt) never match because the checks use the produced key, not the
 * physical one.
 */
import type { PaneDirection } from "@kalcode/protocol";
import { DESKTOP_PLATFORM, type DesktopPlatform, formatShortcut } from "../../platform/keyboard.ts";
import type { BuiltinPreset } from "./model.ts";

export type PaneShortcut =
  | { kind: "move"; direction: PaneDirection }
  | { kind: "tidy" }
  | { kind: "undo-layout" }
  | { kind: "focus"; direction: PaneDirection }
  | { kind: "resize"; direction: PaneDirection }
  | { kind: "split-right" }
  | { kind: "split-down" }
  | { kind: "maximize" }
  | { kind: "close" }
  | { kind: "reopen" }
  | { kind: "collapse" }
  | { kind: "next-tab" }
  | { kind: "previous-tab" }
  | { kind: "preset"; preset: BuiltinPreset }
  | { kind: "even" };

const ARROWS: Record<string, PaneDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

const PRESET_KEYS: Record<string, BuiltinPreset> = { "2": "two", "3": "three", "4": "four", "6": "six" };

/** Maps a key event to a pane shortcut (Ctrl+Alt, never ⌘ or AltGr characters). */
export function paneShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "key" | "code">,
  platform: DesktopPlatform = DESKTOP_PLATFORM,
): PaneShortcut | null {
  if (!event.ctrlKey || !event.altKey || event.metaKey) return null;
  const direction = ARROWS[event.key];
  if (direction) return event.shiftKey ? { kind: "resize", direction } : { kind: "focus", direction };
  const codeKey =
    platform === "macos" && /^Key[A-Z]$/.test(event.code)
      ? event.code.slice(3).toLowerCase()
      : platform === "macos" && /^Digit[0-9]$/.test(event.code)
        ? event.code.slice(5)
        : null;
  const key = codeKey ?? (event.key.length === 1 ? event.key.toLowerCase() : event.key);
  if (event.shiftKey) {
    if (key === "d") return { kind: "split-down" };
    const movement: Record<string, PaneDirection> = { h: "left", j: "down", k: "up", l: "right" };
    if (movement[key]) return { kind: "move", direction: movement[key] };
    return null;
  }
  switch (key) {
    case "t":
      return { kind: "tidy" };
    case "z":
      return { kind: "undo-layout" };
    case "d":
      return { kind: "split-right" };
    case "Enter":
      return { kind: "maximize" };
    case "w":
      return { kind: "close" };
    case "r":
      return { kind: "reopen" };
    case "h":
      return { kind: "collapse" };
    case "PageDown":
      return { kind: "next-tab" };
    case "PageUp":
      return { kind: "previous-tab" };
    case "0":
      return { kind: "even" };
  }
  const preset = PRESET_KEYS[key];
  return preset ? { kind: "preset", preset } : null;
}

export function isPaneShortcut(event: KeyboardEvent): boolean {
  return paneShortcut(event) !== null;
}

/** Labels for menus, tooltips and the status bar. */
export function paneShortcutLabels(platform: DesktopPlatform = DESKTOP_PLATFORM) {
  const chord = (tokens: readonly string[]) => formatShortcut(["Control", "Alt", ...tokens], platform);
  return {
    move: chord(["Shift", "H / J / K / L"]),
    tidy: chord(["T"]),
    undoLayout: chord(["Z"]),
    focus: chord(["←↑→↓"]),
    resize: chord(["Shift", "←↑→↓"]),
    splitRight: chord(["D"]),
    splitDown: chord(["Shift", "D"]),
    maximize: chord(["Enter"]),
    close: chord(["W"]),
    reopen: chord(["R"]),
    collapse: chord(["H"]),
    nextTab: chord(["PgDn"]),
    previousTab: chord(["PgUp"]),
    preset: chord(["2 / 3 / 4 / 6"]),
    even: chord(["0"]),
  } as const;
}

export const PANE_SHORTCUT_LABELS = paneShortcutLabels();
