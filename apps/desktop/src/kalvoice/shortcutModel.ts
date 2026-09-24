/**
 * KalVoice shortcut helpers for the UI. Mirrors `crates/kalvoice/src/shortcuts.rs` (the native
 * side validates again on save and is authoritative); the reserved list comes from native status.
 */
import type { ReservedShortcut } from "@kalcode/protocol";

export type ShortcutCheck = { ok: true; value: string } | { ok: false; code: string; message: string };

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const DIGITS = "0123456789".split("");
const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);
const NAMED = [
  "Space",
  "Backquote",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
];
const KEYS = [...LETTERS, ...DIGITS, ...FUNCTION_KEYS, ...NAMED];
const MOD_ALIASES = new Set([
  "commandorcontrol",
  "cmdorctrl",
  "commandorctrl",
  "cmdorcontrol",
  "control",
  "ctrl",
  "command",
  "cmd",
  "mod",
]);

const INVALID: ShortcutCheck = {
  ok: false,
  code: "shortcut_invalid",
  message: "Use Ctrl or Alt with a letter, number, function key or Space.",
};

/** `ctrl+shift+space` → `CommandOrControl+Shift+Space`. */
export function canonicalize(input: string): ShortcutCheck {
  let mod = false;
  let alt = false;
  let shift = false;
  let key: string | null = null;
  for (const raw of input.split("+").map((t) => t.trim())) {
    const token = raw.toLowerCase();
    if (MOD_ALIASES.has(token)) {
      if (mod) return INVALID;
      mod = true;
    } else if (token === "alt" || token === "option") {
      if (alt) return INVALID;
      alt = true;
    } else if (token === "shift") {
      if (shift) return INVALID;
      shift = true;
    } else {
      const found = KEYS.find((k) => k.toLowerCase() === token);
      if (!found || key) return INVALID;
      key = found;
    }
  }
  if (!key) return INVALID;
  if (!mod && !alt) {
    return {
      ok: false,
      code: "shortcut_needs_modifier",
      message: "Include Ctrl (⌘ on macOS) or Alt, so the shortcut doesn't interrupt typing.",
    };
  }
  const parts = [mod && "CommandOrControl", alt && "Alt", shift && "Shift", key].filter(Boolean);
  return { ok: true, value: parts.join("+") };
}

/** Checks a KalVoice shortcut against reserved bindings and the other KalVoice shortcut. */
export function validateShortcut(
  input: string,
  other: string | null,
  reserved: readonly ReservedShortcut[],
  isMac = false,
): ShortcutCheck {
  const checked = canonicalize(input);
  if (!checked.ok) return checked;
  const owner = reserved.find((r) => {
    const c = canonicalize(r.accelerator);
    return c.ok && c.value === checked.value;
  });
  if (owner) {
    return {
      ok: false,
      code: "shortcut_conflict",
      message: `${displayShortcut(checked.value, isMac)} is already used for ${owner.owner}.`,
    };
  }
  if (other) {
    const o = canonicalize(other);
    if (o.ok && o.value === checked.value) {
      return {
        ok: false,
        code: "shortcut_conflict",
        message: `${displayShortcut(checked.value, isMac)} is already your other KalVoice shortcut.`,
      };
    }
  }
  return checked;
}

const DISPLAY_KEYS: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** Human form: `Ctrl+Shift+Space` (Windows/Linux) or `⌘⇧Space` (macOS). */
export function displayShortcut(canonical: string, isMac = false): string {
  const parts = canonical.split("+").map((p) => DISPLAY_KEYS[p] ?? p);
  if (!isMac) return parts.map((p) => (p === "CommandOrControl" ? "Ctrl" : p)).join("+");
  const symbols: Record<string, string> = { CommandOrControl: "⌘", Alt: "⌥", Shift: "⇧" };
  return parts.map((p) => symbols[p] ?? p).join("");
}

/** Individual keys for rendering as <kbd> chips. */
export function shortcutKeys(canonical: string, isMac = false): string[] {
  return canonical
    .split("+")
    .map((p) => DISPLAY_KEYS[p] ?? p)
    .map((p) => {
      if (p === "CommandOrControl") return isMac ? "⌘" : "Ctrl";
      if (isMac && p === "Alt") return "⌥";
      if (isMac && p === "Shift") return "⇧";
      return p;
    });
}

function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return NAMED.includes(code) ? code : null;
}

interface KeyLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The canonical shortcut a key press represents, or null for a bare modifier/unsupported key. */
export function shortcutFromEvent(event: KeyLike): string | null {
  const key = keyFromCode(event.code);
  if (!key) return null;
  const parts = [
    (event.ctrlKey || event.metaKey) && "CommandOrControl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    key,
  ].filter(Boolean);
  return parts.join("+");
}
