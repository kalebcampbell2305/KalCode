import { useEffect, useRef } from "react";
import {
  DESKTOP_PLATFORM,
  formatShortcut,
  hasPrimaryModifier,
  IS_MAC,
  type DesktopPlatform,
} from "../platform/keyboard.ts";

export { IS_MAC };

/** Display label for the platform's primary modifier. */
export const MOD_LABEL = formatShortcut(["Mod"]);

export type GlobalShortcut = "open-palette" | "toggle-sidebar";

type GlobalShortcutEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/** Maps primary application chords without accepting the other platform's modifier. */
export function globalShortcut(
  event: GlobalShortcutEvent,
  platform: DesktopPlatform = DESKTOP_PLATFORM,
): GlobalShortcut | null {
  if (!hasPrimaryModifier(event, platform) || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (key === "k") return "open-palette";
  if (key === "b") return "toggle-sidebar";
  return null;
}

export function isRailToggleShortcut(
  event: GlobalShortcutEvent,
  platform: DesktopPlatform = DESKTOP_PLATFORM,
): boolean {
  return (
    hasPrimaryModifier(event, platform) &&
    event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "b"
  );
}

interface ShortcutHandlers {
  openPalette: () => void;
  toggleSidebar: () => void;
}

/** Global shortcuts: Mod+K command palette, Mod+B sidebar. */
export function useShortcuts(handlers: ShortcutHandlers) {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = globalShortcut(event);
      if (shortcut === "open-palette") {
        event.preventDefault();
        latest.current.openPalette();
      } else if (shortcut === "toggle-sidebar") {
        event.preventDefault();
        latest.current.toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
