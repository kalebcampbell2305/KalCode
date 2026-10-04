import { useEffect, useRef } from "react";
import {
  DESKTOP_PLATFORM,
  type DesktopPlatform,
  formatShortcut,
  hasPrimaryModifier,
  IS_MAC,
} from "../platform/keyboard.ts";

export { IS_MAC };

/** Display label for the platform's primary modifier. */
export const MOD_LABEL = formatShortcut(["Mod"]);

export type GlobalShortcut = "open-palette" | "toggle-sidebar" | "back" | "forward" | "open-settings";

type GlobalShortcutEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

/** Maps primary application chords without accepting the other platform's modifier. */
export function globalShortcut(
  event: GlobalShortcutEvent,
  platform: DesktopPlatform = DESKTOP_PLATFORM,
): GlobalShortcut | null {
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (event.key === "ArrowLeft") return "back";
    if (event.key === "ArrowRight") return "forward";
  }
  if (platform === "macos" && hasPrimaryModifier(event, platform) && !event.altKey && !event.shiftKey) {
    if (event.key === "[") return "back";
    if (event.key === "]") return "forward";
  }
  if (!hasPrimaryModifier(event, platform) || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (key === "k") return "open-palette";
  if (key === "b") return "toggle-sidebar";
  if (key === ",") return "open-settings";
  return null;
}

export function isRailToggleShortcut(
  event: GlobalShortcutEvent,
  platform: DesktopPlatform = DESKTOP_PLATFORM,
): boolean {
  return hasPrimaryModifier(event, platform) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "b";
}

interface ShortcutHandlers {
  openPalette: () => void;
  toggleSidebar: () => void;
  back?: () => void;
  forward?: () => void;
  openSettings?: () => void;
}

/** Global shortcuts: Mod+K command palette, Mod+B sidebar. */
export function useShortcuts(handlers: ShortcutHandlers) {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat) return;
      const shortcut = globalShortcut(event);
      if (shortcut === "open-palette") {
        event.preventDefault();
        latest.current.openPalette();
      } else if (shortcut === "toggle-sidebar") {
        event.preventDefault();
        latest.current.toggleSidebar();
      } else if (shortcut === "back" || shortcut === "forward" || shortcut === "open-settings") {
        const handler = shortcut === "open-settings" ? latest.current.openSettings : latest.current[shortcut];
        if (handler) {
          event.preventDefault();
          handler();
        }
      }
    };
    // Capture before xterm consumes application navigation chords.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
