import { useEffect, useRef } from "react";
import { IS_MAC } from "../shortcuts.ts";
import { useRail } from "./RailProvider.tsx";

/** Mod+Shift+B shows or hides the workspace rail (like Mod+B for the sidebar). */
export function useRailShortcut() {
  const rail = useRail();
  const toggle = useRef(rail.toggleHidden);
  toggle.current = rail.toggleHidden;
  const enabled = rail.enabled;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      if (!mod || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      toggle.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
