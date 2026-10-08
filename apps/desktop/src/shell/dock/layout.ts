/**
 * Per-workspace arrangement of Code's Workspace Dock (the right side of the Command Deck). Product
 * data never lives here: every tab renders a canonical KalCode surface, and this model remembers
 * only which tabs are open, their order, the active one, pins, the dock's width, whether the person
 * collapsed it, and which native Browser session the dock's Browser tab owns.
 *
 * Storage can be missing or full; every read falls back to the defaults and every write is best
 * effort (like the Terminal Stack's per-workspace prefs).
 */
import { newBrowserId, persistableBrowserUrl } from "../../surfaces/browser/browserModel.ts";

/** Every dock view, in the order the + picker offers them. */
export const DOCK_TAB_IDS = [
  "agents",
  "browser",
  "dashboard",
  "needs-you",
  "runs",
  "queue",
  "services",
  "environments",
  "activity",
  "provider-usage",
  "kalvoice",
  "git",
  "tests",
] as const;

export type DockTabId = (typeof DOCK_TAB_IDS)[number];

/** The rail's long-standing width (18rem), so existing layouts look exactly as before. */
export const DEFAULT_DOCK_WIDTH = 288;
export const MIN_DOCK_WIDTH = 240;
export const MAX_DOCK_WIDTH = 960;
/** Expand grows the dock to at least this for the visit (Browser, Dashboard). */
export const EXPANDED_DOCK_WIDTH = 720;
/** Adding the Browser widens a narrow dock to a comfortable start. */
export const BROWSER_START_WIDTH = 520;

export interface DockLayout {
  schemaVersion: 1;
  tabs: DockTabId[];
  active: DockTabId;
  pinned: DockTabId[];
  width: number;
  /**
   * The person's choice: `true` collapsed to the rail, `false` kept open. `null` until they choose:
   * the dock then follows the agents (open while one works or needs them), as the rail always has.
   */
  collapsed: boolean | null;
  /** The dock Browser's own native session (one per workspace) and its last safe URL. */
  browser: { browserId: string; url: string | null };
}

export type DockLayoutChange =
  | { kind: "add"; id: DockTabId }
  | { kind: "activate"; id: DockTabId }
  | { kind: "close"; id: DockTabId }
  | { kind: "move"; id: DockTabId; to: number }
  | { kind: "pin"; id: DockTabId; pinned: boolean }
  | { kind: "resize"; width: number }
  | { kind: "collapsed"; collapsed: boolean }
  | { kind: "browser-url"; url: string }
  /** The dock's Browser session moved elsewhere (a Code pane) or closed: start a fresh one next time. */
  | { kind: "browser-released" }
  | { kind: "reset-width" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function clampDockWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_DOCK_WIDTH;
  return Math.round(Math.max(MIN_DOCK_WIDTH, Math.min(MAX_DOCK_WIDTH, width)));
}

export function defaultDockLayout(browserId = newBrowserId(), collapsed: boolean | null = null): DockLayout {
  return {
    schemaVersion: 1,
    tabs: ["agents"],
    active: "agents",
    pinned: [],
    width: DEFAULT_DOCK_WIDTH,
    collapsed,
    browser: { browserId, url: null },
  };
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return persistableBrowserUrl(value);
  } catch {
    return null;
  }
}

function uniqueAvailable(value: unknown, available: ReadonlySet<DockTabId>): DockTabId[] {
  if (!Array.isArray(value)) return [];
  const result: DockTabId[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !available.has(id as DockTabId) || result.includes(id as DockTabId)) continue;
    result.push(id as DockTabId);
  }
  return result;
}

/** Repairs stale, hand-edited or unsafe state before it reaches the UI or the native Browser. */
export function normalizeDockLayout(
  value: unknown,
  availableIds: readonly DockTabId[] = DOCK_TAB_IDS,
  makeBrowserId: () => string = newBrowserId,
  fallbackCollapsed: boolean | null = null,
): DockLayout {
  const available = new Set(availableIds);
  const fallback = defaultDockLayout(makeBrowserId(), fallbackCollapsed);
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Partial<Record<keyof DockLayout, unknown>>;
  const storedTabs = uniqueAvailable(raw.tabs, available);
  // A dock always has a tab: Agents, the long-standing default.
  const tabs: DockTabId[] = storedTabs.length > 0 ? storedTabs : ["agents"];
  const first = tabs[0] ?? "agents";
  const active =
    typeof raw.active === "string" && tabs.includes(raw.active as DockTabId) ? (raw.active as DockTabId) : first;
  const pinned = uniqueAvailable(raw.pinned, new Set(tabs));
  const browserRaw = raw.browser && typeof raw.browser === "object" ? (raw.browser as Record<string, unknown>) : {};
  const browserId =
    typeof browserRaw.browserId === "string" && UUID.test(browserRaw.browserId)
      ? browserRaw.browserId
      : fallback.browser.browserId;
  return {
    schemaVersion: 1,
    tabs,
    active,
    pinned,
    width: clampDockWidth(typeof raw.width === "number" ? raw.width : DEFAULT_DOCK_WIDTH),
    collapsed: typeof raw.collapsed === "boolean" ? raw.collapsed : null,
    browser: { browserId, url: safeUrl(browserRaw.url) },
  };
}

export function applyDockLayout(
  layout: DockLayout,
  change: DockLayoutChange,
  availableIds: readonly DockTabId[] = DOCK_TAB_IDS,
  makeBrowserId: () => string = newBrowserId,
): DockLayout {
  switch (change.kind) {
    case "add":
      if (!availableIds.includes(change.id)) return layout;
      if (layout.tabs.includes(change.id)) {
        return layout.active === change.id && layout.collapsed === false
          ? layout
          : { ...layout, active: change.id, collapsed: false };
      }
      return { ...layout, tabs: [...layout.tabs, change.id], active: change.id, collapsed: false };
    case "activate":
      if (!layout.tabs.includes(change.id)) return layout;
      return layout.active === change.id ? layout : { ...layout, active: change.id };
    case "close": {
      const index = layout.tabs.indexOf(change.id);
      if (index < 0 || layout.pinned.includes(change.id) || layout.tabs.length === 1) return layout;
      const tabs = layout.tabs.filter((id) => id !== change.id);
      const active =
        layout.active === change.id ? (tabs[Math.min(index, tabs.length - 1)] ?? tabs[0] ?? "agents") : layout.active;
      // A closed Browser's native session ends; the next one starts fresh at the last page.
      const browser =
        change.id === "browser" ? { browserId: makeBrowserId(), url: layout.browser.url } : layout.browser;
      return { ...layout, tabs, active, pinned: layout.pinned.filter((id) => id !== change.id), browser };
    }
    case "move": {
      const from = layout.tabs.indexOf(change.id);
      if (from < 0) return layout;
      const to = Math.max(0, Math.min(layout.tabs.length - 1, change.to));
      if (from === to) return layout;
      const tabs = [...layout.tabs];
      tabs.splice(from, 1);
      tabs.splice(to, 0, change.id);
      return { ...layout, tabs };
    }
    case "pin": {
      if (!layout.tabs.includes(change.id)) return layout;
      const pinned = change.pinned
        ? layout.pinned.includes(change.id)
          ? layout.pinned
          : [...layout.pinned, change.id]
        : layout.pinned.filter((id) => id !== change.id);
      return pinned.length === layout.pinned.length ? layout : { ...layout, pinned };
    }
    case "resize": {
      const width = clampDockWidth(change.width);
      return width === layout.width ? layout : { ...layout, width };
    }
    case "collapsed":
      return layout.collapsed === change.collapsed ? layout : { ...layout, collapsed: change.collapsed };
    case "browser-url": {
      const url = safeUrl(change.url);
      return !url || url === layout.browser.url ? layout : { ...layout, browser: { ...layout.browser, url } };
    }
    case "browser-released":
      return { ...layout, browser: { browserId: makeBrowserId(), url: layout.browser.url } };
    case "reset-width":
      return layout.width === DEFAULT_DOCK_WIDTH ? layout : { ...layout, width: DEFAULT_DOCK_WIDTH };
  }
}

/** Where a workspace's dock lives. Without a project the dock still has one shared arrangement. */
export function dockStorageKey(workspaceId: string | null): string {
  return `kalcode.workspaceDock.v1.${workspaceId === null ? "_" : encodeURIComponent(workspaceId)}`;
}

/**
 * The person's latest open/closed choice, which a workspace's first dock starts from (so a new
 * project opens the way they last left the dock). Same key as the single rail before the dock.
 */
export const LEGACY_RAIL_KEY = "kalcode.deck.agentsRail.v2";

export function rememberDefaultCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(LEGACY_RAIL_KEY, collapsed ? "closed" : "open");
  } catch {
    // Not remembered for new projects; this project's own choice still saves.
  }
}

function legacyCollapsed(): boolean | null {
  try {
    const saved = localStorage.getItem(LEGACY_RAIL_KEY);
    return saved === "closed" ? true : saved === "open" ? false : null;
  } catch {
    return null;
  }
}

export function loadDockLayout(
  workspaceId: string | null,
  availableIds: readonly DockTabId[] = DOCK_TAB_IDS,
  makeBrowserId: () => string = newBrowserId,
): DockLayout {
  let raw: unknown = null;
  try {
    const stored = localStorage.getItem(dockStorageKey(workspaceId));
    raw = stored ? JSON.parse(stored) : null;
  } catch {
    raw = null;
  }
  return normalizeDockLayout(raw, availableIds, makeBrowserId, legacyCollapsed());
}

export function saveDockLayout(workspaceId: string | null, layout: DockLayout): void {
  try {
    localStorage.setItem(dockStorageKey(workspaceId), JSON.stringify(layout));
  } catch {
    // The layout still applies for this session when storage is unavailable.
  }
}
