import { useCallback, useState } from "react";
import { applyLayout, type LayoutChange, normalizeLayout, type WidgetLayout } from "./layout.ts";
import { WIDGETS } from "./registry.tsx";

const STORAGE_KEY = "kalcode.widgets.v1";

/**
 * Stored per viewer in the WebView's local storage (it persists across restarts in the app's
 * data folder). A per-viewer convenience: a missing or unreadable value falls back to defaults.
 */
function load(): WidgetLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeLayout(raw ? JSON.parse(raw) : null, WIDGETS);
  } catch {
    return normalizeLayout(null, WIDGETS);
  }
}

function save(layout: WidgetLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Not saved: the layout still applies for this session.
  }
}

export function useWidgetLayout(): [WidgetLayout, (change: LayoutChange) => void] {
  const [layout, setLayout] = useState<WidgetLayout>(load);
  const change = useCallback((next: LayoutChange) => {
    setLayout((current) => {
      const updated = applyLayout(current, next, WIDGETS);
      if (updated !== current) save(updated);
      return updated;
    });
  }, []);
  return [layout, change];
}
