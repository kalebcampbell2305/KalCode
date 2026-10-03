/**
 * The Agent Fleet's remembered layout: the Agents panel's width beside the widget dock, which
 * groups are folded and which agent cards are expanded. Per device (localStorage, like the Command
 * Deck's rail); a convenience, so unreadable or blocked storage just means defaults.
 */
import { useCallback, useState } from "react";

const KEY = "kalcode.fleet.layout";
/** Expanded cards remembered at most (oldest forgotten first): ids of closed agents age out. */
const MAX_EXPANDED = 200;
/** A failed group bigger than this starts folded, so old failures never bury live agents. */
export const FAILED_FOLD_AT = 6;

/** The widget dock's width beside the Agents panel, in px. */
export const DOCK_MIN_PX = 280;
export const DOCK_MAX_PX = 640;
export const DOCK_DEFAULT_PX = 352;

export interface FleetLayout {
  /** Widget dock width (the Agents panel takes the rest); null: the default. */
  dockWidth: number | null;
  /** Explicit fold choices by group key ("status:failed", "project:<id>"): true = folded. */
  folded: Record<string, boolean>;
  /** Expanded agent cards, oldest first. */
  expanded: string[];
}

const EMPTY: FleetLayout = { dockWidth: null, folded: {}, expanded: [] };

export function clampDock(px: number): number {
  return Math.round(Math.min(DOCK_MAX_PX, Math.max(DOCK_MIN_PX, px)));
}

export function readLayout(): FleetLayout {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const value = JSON.parse(raw) as Partial<FleetLayout>;
    return {
      dockWidth:
        typeof value.dockWidth === "number" && Number.isFinite(value.dockWidth) ? clampDock(value.dockWidth) : null,
      folded:
        value.folded && typeof value.folded === "object"
          ? Object.fromEntries(Object.entries(value.folded).filter(([, v]) => typeof v === "boolean"))
          : {},
      expanded: Array.isArray(value.expanded)
        ? value.expanded.filter((id): id is string => typeof id === "string").slice(-MAX_EXPANDED)
        : [],
    };
  } catch {
    return EMPTY;
  }
}

function writeLayout(patch: Partial<FleetLayout>): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...readLayout(), ...patch }));
  } catch {
    // Not remembered; the layout still applies until KalCode closes.
  }
}

/** Whether a group is folded: the person's choice, else folded only for a long failed group. */
export function isFolded(layout: Pick<FleetLayout, "folded">, key: string, count: number): boolean {
  const choice = layout.folded[key];
  if (choice !== undefined) return choice;
  return key === "status:failed" && count > FAILED_FOLD_AT;
}

export function toggleExpanded(expanded: readonly string[], id: string): string[] {
  return expanded.includes(id) ? expanded.filter((x) => x !== id) : [...expanded, id].slice(-MAX_EXPANDED);
}

export function useFleetLayout() {
  const [layout, setLayout] = useState<FleetLayout>(readLayout);

  const setDockWidth = useCallback((px: number | null, persist = true) => {
    const dockWidth = px === null ? null : clampDock(px);
    setLayout((current) => (current.dockWidth === dockWidth ? current : { ...current, dockWidth }));
    if (persist) writeLayout({ dockWidth });
  }, []);

  const setFolded = useCallback((key: string, folded: boolean) => {
    setLayout((current) => {
      const next = { ...current, folded: { ...current.folded, [key]: folded } };
      writeLayout({ folded: next.folded });
      return next;
    });
  }, []);

  const toggleCard = useCallback((id: string) => {
    setLayout((current) => {
      const expanded = toggleExpanded(current.expanded, id);
      writeLayout({ expanded });
      return { ...current, expanded };
    });
  }, []);

  return { layout, setDockWidth, setFolded, toggleCard };
}
