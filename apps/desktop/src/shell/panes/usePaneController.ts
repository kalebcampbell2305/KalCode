/**
 * State of one workspace's pane canvas: the layout (loaded from the layout store, saved back
 * debounced), which pane has focus, the recently closed panes, and every layout operation with
 * its announcement for assistive technology. Pure layout logic lives in `model.ts`.
 */
import type { PaneContent, PaneDirection, PaneLayout, PaneNode, SplitAxis } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activateTab,
  addTab,
  applyPreset,
  applyShape,
  type BuiltinPreset,
  type ClosedPane,
  closePane,
  contentKey,
  DEFAULT_GEOMETRY,
  type DropZone,
  dockPane,
  evenDivider,
  evenOut,
  findContent,
  findLeaf,
  leaves,
  makeLeaf,
  movePane,
  moveTab,
  neighbourPane,
  paneCount,
  removeContents,
  removeTab,
  reopenPane,
  resizePane,
  setCollapsed,
  setMaximized,
  splitPane,
  swapPanes,
  undock,
  validateLayout,
} from "./model.ts";

/** How long after the last change the layout is written to the store. */
export const SAVE_DEBOUNCE_MS = 400;
/** One keyboard resize step, in pixels. */
export const RESIZE_STEP_PX = 32;
const CLOSED_KEPT = 12;

export interface PaneStore {
  load(): Promise<PaneLayout | null>;
  save(layout: PaneLayout): Promise<void>;
}

export interface PaneControllerOptions {
  /** Identity of what is being arranged (the workspace); a change reloads. */
  scope: string;
  store: PaneStore;
  /** The layout to start with when nothing valid is stored. */
  initial: () => PaneLayout;
  /** Titles for announcements. */
  titleOf: (content: PaneContent) => string;
}

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface PaneController {
  layout: PaneLayout;
  ready: boolean;
  saveState: SaveState;
  focusedPaneId: string | null;
  /** Incremented when the focused pane's content should take keyboard focus. */
  focusRequest: { paneId: string; n: number };
  closed: readonly ClosedPane[];
  /** Latest announcement (rendered in a polite live region). */
  message: { text: string; n: number };
  /** Canvas size, measured by the canvas, for pixel-based operations. */
  size: React.MutableRefObject<{ width: number; height: number }>;
  announce(text: string): void;
  replace(layout: PaneLayout, announcement?: string): void;
  focusPane(paneId: string, moveKeyboardFocus?: boolean): void;
  paneTitle(paneId: string): string;
  split(paneId: string, axis: SplitAxis, content?: PaneContent): string | null;
  close(paneId: string): void;
  reopen(): void;
  toggleMaximize(paneId: string): void;
  restore(): void;
  toggleCollapse(paneId: string): void;
  /** Adds (or brings forward) content in a pane (the focused pane by default). */
  show(content: PaneContent, options?: { paneId?: string; focus?: boolean; placement?: "tab" | "split" }): void;
  activate(paneId: string, index: number): void;
  /** Takes a tab out of the layout (what it runs keeps running). */
  hideTab(paneId: string, index: number): void;
  forget(keys: ReadonlySet<string>): void;
  moveTab(fromPaneId: string, index: number, toPaneId: string, zone: DropZone): void;
  movePane(paneId: string, toPaneId: string, zone: DropZone): void;
  swapWith(paneId: string, direction: PaneDirection): void;
  resize(paneId: string, direction: PaneDirection, steps?: number): void;
  focusDirection(direction: PaneDirection): void;
  cycleTab(delta: 1 | -1): void;
  preset(preset: BuiltinPreset): void;
  applyShape(shape: PaneNode, name: string): void;
  even(): void;
  evenDivider(path: number[], index: number): void;
  dock(paneId: string): void;
  undock(index: number): void;
  /** Takes an item out of the dock (it keeps running, in the background). */
  removeFromDock(index: number): void;
}

const DIRECTION_WORD: Record<PaneDirection, string> = { left: "left", right: "right", up: "up", down: "down" };
const PRESET_WORD: Record<BuiltinPreset, string> = { two: "2", three: "3", four: "4", six: "6" };

export function usePaneController({ scope, store, initial, titleOf }: PaneControllerOptions): PaneController {
  const [layout, setLayout] = useState<PaneLayout>(() => initial());
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState({ paneId: "", n: 0 });
  const [closed, setClosed] = useState<ClosedPane[]>([]);
  const [message, setMessage] = useState({ text: "", n: 0 });
  const size = useRef({ width: 1200, height: 800 });
  const latest = useRef(layout);
  latest.current = layout;
  const storeRef = useRef(store);
  storeRef.current = store;
  const titleRef = useRef(titleOf);
  titleRef.current = titleOf;
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const lastSaved = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedScope = useRef<string | null>(null);

  // Load this workspace's layout (or build the default).
  useEffect(() => {
    let cancelled = false;
    loadedScope.current = null;
    setReady(false);
    storeRef.current
      .load()
      .catch(() => null)
      .then((stored) => {
        if (cancelled) return;
        const next = stored && validateLayout(stored) === null ? stored : initialRef.current();
        lastSaved.current = stored ? JSON.stringify(stored) : null;
        setLayout(next);
        setFocusedPaneId(leaves(next.root)[0]?.paneId ?? null);
        setClosed([]);
        loadedScope.current = scope;
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const current = latest.current;
    const serialized = JSON.stringify(current);
    if (serialized === lastSaved.current || validateLayout(current) !== null) return;
    setSaveState("saving");
    try {
      await storeRef.current.save(current);
      lastSaved.current = serialized;
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }, []);

  // Save debounced after every change once loaded.
  useEffect(() => {
    if (!ready || loadedScope.current !== scope) return;
    if (JSON.stringify(layout) === lastSaved.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }, [layout, ready, scope, flush]);

  // Whatever is pending is written when the canvas goes away (navigation, workspace switch).
  useEffect(
    () => () => {
      if (saveTimer.current) void flush();
    },
    [flush],
  );

  // Focus always points at an existing pane.
  const panes = useMemo(() => leaves(layout.root), [layout]);
  const focusValid = focusedPaneId !== null && panes.some((p) => p.paneId === focusedPaneId);
  const effectiveFocus = focusValid ? focusedPaneId : (panes[0]?.paneId ?? null);

  const announce = useCallback((text: string) => setMessage((m) => ({ text, n: m.n + 1 })), []);

  const paneTitle = useCallback((paneId: string) => {
    const leaf = findLeaf(latest.current, paneId);
    const active = leaf?.tabs[leaf.activeTab];
    return active ? titleRef.current(active) : "Empty pane";
  }, []);

  const apply = useCallback(
    (next: PaneLayout, announcement?: string) => {
      if (next === latest.current) return false;
      if (validateLayout(next) !== null) return false;
      latest.current = next;
      setLayout(next);
      if (announcement) announce(announcement);
      return true;
    },
    [announce],
  );

  const focusPane = useCallback((paneId: string, moveKeyboardFocus = true) => {
    setFocusedPaneId(paneId);
    if (moveKeyboardFocus) setFocusRequest((f) => ({ paneId, n: f.n + 1 }));
  }, []);

  const focused = () => {
    const current = latest.current;
    const ids = leaves(current.root).map((l) => l.paneId);
    return effectiveFocusRef.current && ids.includes(effectiveFocusRef.current) ? effectiveFocusRef.current : ids[0];
  };
  const effectiveFocusRef = useRef(effectiveFocus);
  effectiveFocusRef.current = effectiveFocus;

  const controller: PaneController = {
    layout,
    ready,
    saveState,
    focusedPaneId: effectiveFocus,
    focusRequest,
    closed,
    message,
    size,
    announce,
    replace: (next, announcement) => {
      apply(next, announcement);
    },
    focusPane,
    paneTitle,
    split: (paneId, axis, content) => {
      const pane = makeLeaf(content ? [content] : []);
      const current = latest.current;
      // Content already shown elsewhere moves into the new pane.
      const base = content ? removeContents(current, new Set([contentKey(content)])) : current;
      const next = splitPane(base, paneId, axis, pane);
      if (next === base) {
        announce("There's no room for another pane here.");
        return null;
      }
      apply(next, `Split ${paneTitle(paneId)} ${axis === "horizontal" ? "side by side" : "top and bottom"}.`);
      focusPane(pane.paneId);
      return pane.paneId;
    },
    close: (paneId) => {
      const title = paneTitle(paneId);
      const result = closePane(latest.current, paneId);
      if (result.closed) setClosed((list) => [result.closed as ClosedPane, ...list].slice(0, CLOSED_KEPT));
      const running = result.closed?.pane.tabs.length ?? 0;
      apply(
        result.layout,
        running > 0 ? `Closed the ${title} pane. It keeps running; reopen it with Ctrl Alt R.` : "Closed the pane.",
      );
      const remaining = leaves(result.layout.root);
      const next = remaining.find((l) => l.paneId === paneId) ?? remaining[0];
      if (next) focusPane(next.paneId);
    },
    reopen: () => {
      const [last, ...rest] = closed;
      if (!last) {
        announce("No closed panes to reopen.");
        return;
      }
      const next = reopenPane(latest.current, last);
      setClosed(rest);
      const reopened = leaves(next.root).find((l) =>
        l.tabs.some((t) => last.pane.tabs.some((c) => contentKey(c) === contentKey(t))),
      );
      apply(next, `Reopened ${last.pane.tabs[0] ? titleRef.current(last.pane.tabs[0]) : "the pane"}.`);
      if (reopened) focusPane(reopened.paneId);
    },
    toggleMaximize: (paneId) => {
      const current = latest.current;
      if (paneCount(current) === 1) return;
      const restoring = current.maximizedPaneId === paneId;
      apply(
        setMaximized(current, restoring ? null : paneId),
        restoring ? "Restored the layout." : `Maximized ${paneTitle(paneId)}. Other panes keep running.`,
      );
      focusPane(paneId);
    },
    restore: () => {
      if (latest.current.maximizedPaneId) apply(setMaximized(latest.current, null), "Restored the layout.");
    },
    toggleCollapse: (paneId) => {
      const leaf = findLeaf(latest.current, paneId);
      if (!leaf) return;
      const next = setCollapsed(latest.current, paneId, !leaf.collapsed);
      if (next === latest.current) {
        announce("At least one pane stays open.");
        return;
      }
      apply(
        next,
        leaf.collapsed ? `Expanded ${paneTitle(paneId)}.` : `Collapsed ${paneTitle(paneId)}. It keeps running.`,
      );
      focusPane(paneId, leaf.collapsed);
    },
    show: (content, options = {}) => {
      const current = latest.current;
      const key = contentKey(content);
      const where = findContent(current, key);
      if (where) {
        let next = activateTab(current, where.paneId, where.index);
        if (next.maximizedPaneId && next.maximizedPaneId !== where.paneId) next = setMaximized(next, null);
        apply(next);
        if (options.focus !== false) focusPane(where.paneId);
        return;
      }
      const target = options.paneId && findLeaf(current, options.paneId) ? options.paneId : focused();
      if (!target) return;
      const targetLeaf = findLeaf(current, target);
      if (options.placement === "split" && targetLeaf && targetLeaf.tabs.length > 0) {
        const pane = makeLeaf([content]);
        const dockIndex = current.dock.findIndex((d) => contentKey(d) === key);
        const base = dockIndex >= 0 ? { ...current, dock: current.dock.filter((_, i) => i !== dockIndex) } : current;
        const next = splitPane(base, target, "horizontal", pane);
        if (next !== base) {
          apply(next, `Opened ${titleRef.current(content)} beside ${paneTitle(target)}.`);
          if (options.focus !== false) focusPane(pane.paneId);
          return;
        }
      }
      const next = addTab(current, target, content);
      if (!findContent(next, key)) {
        announce("That pane is full. Close a tab or use another pane.");
        return;
      }
      apply(next.maximizedPaneId && next.maximizedPaneId !== target ? setMaximized(next, null) : next);
      if (options.focus !== false) focusPane(target);
    },
    activate: (paneId, index) => {
      apply(activateTab(latest.current, paneId, index));
    },
    hideTab: (paneId, index) => {
      const leaf = findLeaf(latest.current, paneId);
      const tab = leaf?.tabs[index];
      if (!tab) return;
      apply(removeTab(latest.current, paneId, index), `Closed the ${titleRef.current(tab)} tab.`);
    },
    forget: (keys) => {
      apply(removeContents(latest.current, keys));
    },
    moveTab: (fromPaneId, index, toPaneId, zone) => {
      const tab = findLeaf(latest.current, fromPaneId)?.tabs[index];
      if (!tab) return;
      const next = moveTab(latest.current, fromPaneId, index, toPaneId, zone);
      if (next === latest.current) return;
      const target = paneTitle(toPaneId);
      apply(
        next,
        zone === "center"
          ? `Moved ${titleRef.current(tab)} into the ${target} pane.`
          : `Moved ${titleRef.current(tab)} to the ${zone === "top" ? "top" : zone === "bottom" ? "bottom" : zone} of ${target}.`,
      );
      const where = findContent(next, contentKey(tab));
      if (where) focusPane(where.paneId);
    },
    movePane: (paneId, toPaneId, zone) => {
      const title = paneTitle(paneId);
      const target = paneTitle(toPaneId);
      const next = movePane(latest.current, paneId, toPaneId, zone);
      if (next === latest.current) return;
      apply(
        next,
        zone === "center" ? `Merged ${title} into ${target}.` : `Moved ${title} to the ${zone} of ${target}.`,
      );
      if (findLeaf(next, paneId)) focusPane(paneId);
      else focusPane(toPaneId);
    },
    swapWith: (paneId, direction) => {
      const { width, height } = size.current;
      const other = neighbourPane(latest.current, paneId, direction, width, height);
      if (!other) {
        announce(`There's no pane to the ${DIRECTION_WORD[direction]}.`);
        return;
      }
      apply(swapPanes(latest.current, paneId, other), `Moved ${paneTitle(paneId)} ${DIRECTION_WORD[direction]}.`);
      focusPane(paneId);
    },
    resize: (paneId, direction, steps = 1) => {
      const { width, height } = size.current;
      const step = RESIZE_STEP_PX * Math.max(1, Math.min(10, steps));
      let next = resizePane(latest.current, paneId, direction, step, width, height, DEFAULT_GEOMETRY);
      if (next === latest.current) {
        // Nothing that way: grow toward the other side instead ("make this pane bigger").
        const opposite: Record<PaneDirection, PaneDirection> = { left: "right", right: "left", up: "down", down: "up" };
        next = resizePane(latest.current, paneId, opposite[direction], step, width, height, DEFAULT_GEOMETRY);
      }
      if (next === latest.current) {
        announce("This pane can't grow that way.");
        return;
      }
      apply(next, `Resized ${paneTitle(paneId)}.`);
    },
    focusDirection: (direction) => {
      const from = focused();
      if (!from) return;
      const { width, height } = size.current;
      const next = neighbourPane(latest.current, from, direction, width, height);
      if (!next) {
        announce(`No pane to the ${DIRECTION_WORD[direction]}.`);
        return;
      }
      focusPane(next);
      announce(`${paneTitle(next)} pane.`);
    },
    cycleTab: (delta) => {
      const paneId = focused();
      const leaf = paneId ? findLeaf(latest.current, paneId) : null;
      if (!leaf || leaf.tabs.length < 2) return;
      const index = (leaf.activeTab + delta + leaf.tabs.length) % leaf.tabs.length;
      apply(activateTab(latest.current, leaf.paneId, index));
      focusPane(leaf.paneId);
    },
    preset: (preset) => {
      apply(applyPreset(latest.current, preset), `Arranged ${PRESET_WORD[preset]} panes. Nothing was closed.`);
    },
    applyShape: (shape, name) => {
      apply(applyShape(latest.current, shape), `Applied the ${name} layout. Nothing was closed.`);
    },
    even: () => {
      apply(evenOut(latest.current), "Evened out pane sizes.");
    },
    evenDivider: (path, index) => {
      apply(evenDivider(latest.current, path, index), "Evened out the two panes.");
    },
    dock: (paneId) => {
      const title = paneTitle(paneId);
      const next = dockPane(latest.current, paneId);
      if (next === latest.current) return;
      apply(next, `Moved ${title} to the dock. It keeps running.`);
      const first = leaves(next.root)[0];
      if (first) focusPane(first.paneId);
    },
    removeFromDock: (index) => {
      const content = latest.current.dock[index];
      if (!content) return;
      apply(
        { ...latest.current, dock: latest.current.dock.filter((_, i) => i !== index) },
        `Removed ${titleRef.current(content)} from the dock. It keeps running.`,
      );
    },
    undock: (index) => {
      const content = latest.current.dock[index];
      const target = focused();
      if (!content || !target) return;
      apply(undock(latest.current, index, target), `Opened ${titleRef.current(content)} from the dock.`);
      focusPane(target);
    },
  };
  return controller;
}
