/**
 * Keyboard shortcuts of the pane canvas. They work anywhere in the canvas, including inside a
 * terminal or a provider's TUI (terminal views don't send them to the process).
 *
 * Ctrl+Alt is the pane chord: shells and TUIs don't rely on it, and AltGr characters (which
 * Windows reports as Ctrl+Alt) never match because the checks use the produced key, not the
 * physical one.
 */
import type { PaneDirection } from "@kalcode/protocol";
import type { BuiltinPreset } from "./model.ts";

export type PaneShortcut =
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
  event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "key">,
): PaneShortcut | null {
  if (!event.ctrlKey || !event.altKey || event.metaKey) return null;
  const direction = ARROWS[event.key];
  if (direction) return event.shiftKey ? { kind: "resize", direction } : { kind: "focus", direction };
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (event.shiftKey) {
    if (key === "d") return { kind: "split-down" };
    return null;
  }
  switch (key) {
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
export const PANE_SHORTCUT_LABELS = {
  focus: "Ctrl Alt ←↑→↓",
  resize: "Ctrl Alt Shift ←↑→↓",
  splitRight: "Ctrl Alt D",
  splitDown: "Ctrl Alt Shift D",
  maximize: "Ctrl Alt Enter",
  close: "Ctrl Alt W",
  reopen: "Ctrl Alt R",
  collapse: "Ctrl Alt H",
  nextTab: "Ctrl Alt PgDn",
  previousTab: "Ctrl Alt PgUp",
  preset: "Ctrl Alt 2 / 3 / 4 / 6",
  even: "Ctrl Alt 0",
} as const;
