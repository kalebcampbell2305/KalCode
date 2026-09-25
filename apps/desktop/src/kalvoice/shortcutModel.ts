/**
 * The KalVoice push-to-talk key in the UI. Mirrors `crates/kalvoice/src/shortcuts.rs`; the
 * native side validates again on save and is authoritative. The allowed and reserved keys come
 * from native status.
 */
import type { ReservedShortcut } from "@kalcode/protocol";

export type KeyCheck = { ok: true; value: string } | { ok: false; code: string; message: string };

interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const BY_CODE: Record<string, string> = { Pause: "Pause", ScrollLock: "ScrollLock", Insert: "Insert" };

function unsupported(what: string, why: string): KeyCheck {
  return { ok: false, code: "talk_key_unsupported", message: `${what} can't be the push-to-talk key: ${why}` };
}

/** A modifier pressed on its own (the start of a chord, or someone trying Shift alone). */
export function isModifierOnly(event: KeyLike): boolean {
  return (
    /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(event.code) ||
    ["Control", "Alt", "Shift", "Meta"].includes(event.key)
  );
}

/**
 * Reads the key a person pressed in the "Press the key you want to use" capture. Only keys that
 * actually arrive are offered: on most Windows keyboards Fn never does.
 */
export function talkKeyFromEvent(event: KeyLike, allowed: readonly string[]): KeyCheck {
  if (event.key === "Fn" || event.code === "Fn") {
    return unsupported("Fn", "on this system it never reaches apps, so KalCode can't detect it.");
  }
  if (["CapsLock", "NumLock"].includes(event.code)) {
    return unsupported("A lock key", "it would switch on and off while you hold it.");
  }
  if (isModifierOnly(event)) {
    return unsupported("A modifier key", "the system can't register it on its own.");
  }
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return {
      ok: false,
      code: "talk_key_single",
      message: "Push to talk uses one key on its own, without Ctrl, Alt or Shift.",
    };
  }
  const name = /^F([1-9]|1[0-9]|2[0-4])$/.test(event.code) ? event.code : BY_CODE[event.code];
  if (!name || !allowed.includes(name)) {
    return {
      ok: false,
      code: "talk_key_invalid",
      message: "Choose a function key (F1–F24), Pause, Scroll Lock or Insert.",
    };
  }
  return { ok: true, value: name };
}

/** Refuses keys KalCode already uses. */
export function checkReserved(key: string, reserved: readonly ReservedShortcut[]): KeyCheck {
  const owner = reserved.find((r) => r.accelerator === key);
  return owner
    ? { ok: false, code: "talk_key_conflict", message: `${displayKey(key)} is used for ${owner.owner} in KalCode.` }
    : { ok: true, value: key };
}

export function displayKey(key: string): string {
  return key === "ScrollLock" ? "Scroll Lock" : key;
}

/** True when a keyboard event is the configured push-to-talk key (no modifiers). */
export function isTalkKey(event: KeyLike, talkKey: string): boolean {
  const check = talkKeyFromEvent(event, [talkKey]);
  return check.ok && check.value === talkKey;
}
