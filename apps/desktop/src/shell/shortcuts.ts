import { useEffect, useRef } from "react";

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Display label for the platform's primary modifier. */
export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

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
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      if (!mod || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        latest.current.openPalette();
      } else if (key === "b") {
        event.preventDefault();
        latest.current.toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
