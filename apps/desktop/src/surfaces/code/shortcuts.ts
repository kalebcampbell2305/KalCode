import { isPaneShortcut } from "../../shell/panes/paneShortcuts.ts";

/** Keyboard shortcuts of the Code surface. They work while a terminal has focus. */
export type CodeShortcut = "new-terminal" | "next-tab" | "previous-tab" | "close-tab" | "leave-terminal";

export const CODE_SHORTCUT_LABELS: Record<CodeShortcut, string> = {
  "new-terminal": "Ctrl Shift `",
  "next-tab": "Ctrl Tab",
  "previous-tab": "Ctrl Shift Tab",
  "close-tab": "Ctrl Shift W",
  "leave-terminal": "Ctrl Shift E",
};

/**
 * Maps a key event to a Code shortcut. Ctrl (not ⌘) on every platform, like terminal apps.
 * Combinations with Shift are chosen because a terminal cannot tell Ctrl+Shift+letter from
 * Ctrl+letter, so shells never rely on them; Ctrl+Tab has no meaning to shells.
 */
export function codeShortcut(event: KeyboardEvent): CodeShortcut | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.code === "Backquote" && event.shiftKey) return "new-terminal";
  if (event.key === "Tab") return event.shiftKey ? "previous-tab" : "next-tab";
  if (!event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (key === "w") return "close-tab";
  if (key === "e") return "leave-terminal";
  return null;
}

/** True for shortcuts xterm.js must not send to the shell (Code and pane shortcuts). */
export function isTerminalShortcut(event: KeyboardEvent): boolean {
  return codeShortcut(event) !== null || isPaneShortcut(event);
}
