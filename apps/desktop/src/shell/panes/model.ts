/**
 * The pane layout model (Z7-W1): pure functions over the contract's versioned split tree
 * (`PaneLayout` / `PaneNode` / `PaneContent`, `crates/contracts/src/workspace_ui.rs`). Every
 * operation returns a new, normalized layout that passes the same structural checks native
 * `PaneLayout::validate` applies, so whatever the UI saves is accepted.
 *
 * Axis convention: a `horizontal` split lays its children out side by side (left → right, the
 * dividers are vertical lines); a `vertical` split stacks them (top → bottom).
 *
 * Panes only ever *show* things. Removing a pane or a tab from the layout never stops a process;
 * that is always a separate, explicit action (Z7-14).
 */
import type { PaneContent, PaneDirection, PaneLayout, PaneNode, SplitAxis } from "@kalcode/protocol";

export const PANE_LAYOUT_SCHEMA_VERSION = 1;
/** Deepest split nesting native accepts. */
export const MAX_PANE_DEPTH = 8;
/** Most panes in one layout. */
export const MAX_PANES = 32;
/** Most tabs in one pane (and items in the dock). */
export const MAX_TABS_PER_PANE = 32;
/** Ratios are per-mille shares that sum to exactly this. */
export const RATIO_TOTAL = 1000;

export type LeafNode = Extract<PaneNode, { kind: "leaf" }>;
export type SplitNode = Extract<PaneNode, { kind: "split" }>;
export type DropZone = "center" | "left" | "right" | "top" | "bottom";
export type BuiltinPreset = "two" | "three" | "four" | "six";

export const BUILTIN_PRESETS: readonly BuiltinPreset[] = ["two", "three", "four", "six"];
export const PRESET_PANES: Record<BuiltinPreset, number> = { two: 2, three: 3, four: 4, six: 6 };

/** A pane taken out of the layout, kept so it can be reopened where it was. */
export interface ClosedPane {
  pane: LeafNode;
  /** The pane it sat next to, and on which side, when it was closed. */
  anchorPaneId: string | null;
  zone: Exclude<DropZone, "center">;
  /** The panes of the neighbouring subtree it shared a split with, and its share of the two. */
  siblingPaneIds?: string[];
  share?: number;
}

/** Why a layout is refused (mirrors native `LayoutError`). */
export type LayoutProblem =
  | "unsupported_version"
  | "bad_split"
  | "bad_ratios"
  | "too_deep"
  | "too_large"
  | "bad_pane_id"
  | "bad_active_tab"
  | "unknown_maximized_pane";

let idCounter = 0;

/** A fresh pane id: short, unique within a session and across sessions. */
export function newPaneId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  const random = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `p${Date.now().toString(36)}${idCounter.toString(36)}${random}`;
}

export function makeLeaf(tabs: PaneContent[] = [], paneId: string = newPaneId(), activeTab = 0): LeafNode {
  return {
    kind: "leaf",
    paneId,
    tabs,
    activeTab: tabs.length === 0 ? 0 : Math.max(0, Math.min(tabs.length - 1, activeTab)),
    collapsed: false,
  };
}

export function emptyLayout(): PaneLayout {
  return { schemaVersion: PANE_LAYOUT_SCHEMA_VERSION, root: makeLeaf(), maximizedPaneId: null, dock: [] };
}

/** Stable identity of a content item (the same terminal is never shown twice). */
export function contentKey(content: PaneContent): string {
  switch (content.kind) {
    case "agent":
      return `agent:${content.agentId}`;
    case "thread":
      return `thread:${content.threadId}`;
    case "terminal":
      return `terminal:${content.terminalId}`;
    case "dashboard":
      return "dashboard";
    case "widget":
      return `widget:${content.widgetId}`;
    case "browser":
      return `browser:${content.browserId}`;
    case "git":
      return `git:${content.workspaceId}`;
    default:
      return `unknown:${JSON.stringify(content)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Reading

/** Every pane, in reading order (left → right, top → bottom through the tree). */
export function leaves(node: PaneNode): LeafNode[] {
  if (node.kind === "leaf") return [node];
  return node.children.flatMap(leaves);
}

export function findLeaf(layout: PaneLayout, paneId: string): LeafNode | null {
  return leaves(layout.root).find((l) => l.paneId === paneId) ?? null;
}

/** Where a content item is shown, if anywhere. */
export function findContent(layout: PaneLayout, key: string): { paneId: string; index: number } | null {
  for (const leaf of leaves(layout.root)) {
    const index = leaf.tabs.findIndex((t) => contentKey(t) === key);
    if (index >= 0) return { paneId: leaf.paneId, index };
  }
  return null;
}

/** Every content item shown in the layout (panes and the dock). */
export function allContents(layout: PaneLayout): PaneContent[] {
  return [...leaves(layout.root).flatMap((l) => l.tabs), ...layout.dock];
}

/** Upgrade old Code agent tabs only after their provider-session identity is confirmed. */
export function migrateAgentContents(layout: PaneLayout, knownAgentIds: ReadonlySet<string>): PaneLayout {
  const migrate = (items: PaneContent[]): PaneContent[] => {
    let changed = false;
    const next = items.map((content): PaneContent => {
      if (content.kind !== "thread" || !knownAgentIds.has(content.threadId)) return content;
      changed = true;
      return { kind: "agent", agentId: content.threadId };
    });
    return changed ? next : items;
  };
  const visit = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") {
      const tabs = migrate(node.tabs);
      return tabs === node.tabs ? node : { ...node, tabs };
    }
    const children = node.children.map(visit);
    return children.every((child, index) => child === node.children[index]) ? node : { ...node, children };
  };
  const root = visit(layout.root);
  const dock = migrate(layout.dock);
  return root === layout.root && dock === layout.dock ? layout : { ...layout, root, dock };
}

export function activeContent(leaf: LeafNode): PaneContent | null {
  return leaf.tabs[leaf.activeTab] ?? null;
}

/** Path (child indices from the root) of the node holding `paneId`. */
export function pathOf(node: PaneNode, paneId: string, path: number[] = []): number[] | null {
  if (node.kind === "leaf") return node.paneId === paneId ? path : null;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i] as PaneNode;
    const found = pathOf(child, paneId, [...path, i]);
    if (found) return found;
  }
  return null;
}

export function nodeAt(node: PaneNode, path: readonly number[]): PaneNode | null {
  let current: PaneNode = node;
  for (const index of path) {
    if (current.kind !== "split") return null;
    const next = current.children[index];
    if (!next) return null;
    current = next;
  }
  return current;
}

/** Structural validation, identical in effect to native `PaneLayout::validate`. */
export function validateLayout(layout: PaneLayout): LayoutProblem | null {
  if (layout.schemaVersion !== PANE_LAYOUT_SCHEMA_VERSION) return "unsupported_version";
  const ids = new Set<string>();
  const visit = (node: PaneNode, depth: number): LayoutProblem | null => {
    if (depth > MAX_PANE_DEPTH) return "too_deep";
    if (node.kind === "split") {
      if (node.children.length < 2 || node.ratios.length !== node.children.length) return "bad_split";
      const sum = node.ratios.reduce((a, b) => a + b, 0);
      if (sum !== RATIO_TOTAL || node.ratios.some((r) => r <= 0 || !Number.isInteger(r) || r > 65535))
        return "bad_ratios";
      for (const child of node.children) {
        const problem = visit(child, depth + 1);
        if (problem) return problem;
      }
      return null;
    }
    if (!node.paneId || node.paneId.length > 64 || ids.has(node.paneId)) return "bad_pane_id";
    ids.add(node.paneId);
    if (ids.size > MAX_PANES || node.tabs.length > MAX_TABS_PER_PANE) return "too_large";
    if (
      !Number.isInteger(node.activeTab) ||
      (node.tabs.length === 0 && node.activeTab !== 0) ||
      (node.tabs.length > 0 && (node.activeTab < 0 || node.activeTab >= node.tabs.length))
    )
      return "bad_active_tab";
    return null;
  };
  const problem = visit(layout.root, 1);
  if (problem) return problem;
  if (layout.dock.length > MAX_TABS_PER_PANE) return "too_large";
  if (layout.maximizedPaneId !== null && !ids.has(layout.maximizedPaneId)) return "unknown_maximized_pane";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Ratios

/** Scales positive weights to integer per-mille shares that sum to exactly 1000 (each ≥ 1). */
export function toRatios(weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 1));
  const total = clean.reduce((a, b) => a + b, 0);
  const raw = clean.map((w) => (w / total) * RATIO_TOTAL);
  const floored = raw.map((r) => Math.max(1, Math.floor(r)));
  let remainder = RATIO_TOTAL - floored.reduce((a, b) => a + b, 0);
  // Largest fractional parts first; if flooring to 1 overshot, take back from the largest.
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  let k = 0;
  while (remainder > 0) {
    const target = order[k % n];
    if (target) floored[target.i] = (floored[target.i] ?? 0) + 1;
    remainder--;
    k++;
  }
  while (remainder < 0) {
    let largest = 0;
    for (let i = 1; i < n; i++) if ((floored[i] ?? 0) > (floored[largest] ?? 0)) largest = i;
    floored[largest] = (floored[largest] ?? 0) - 1;
    remainder++;
  }
  return floored;
}

export function equalRatios(n: number): number[] {
  return toRatios(Array.from({ length: n }, () => 1));
}

// ---------------------------------------------------------------------------------------------
// Normalization

/**
 * Collapses single-child splits, flattens a split nested directly in a split of the same axis
 * (keeping each pane's share), and re-derives integer ratios. Idempotent.
 */
export function normalizeNode(node: PaneNode): PaneNode {
  if (node.kind === "leaf") return node;
  const children: PaneNode[] = [];
  const weights: number[] = [];
  node.children.forEach((raw, i) => {
    const child = normalizeNode(raw);
    const weight = node.ratios[i] ?? 1;
    if (child.kind === "split" && child.axis === node.axis) {
      const inner = child.ratios.reduce((a, b) => a + b, 0) || 1;
      child.children.forEach((grand, j) => {
        children.push(grand);
        weights.push((weight * (child.ratios[j] ?? 1)) / inner);
      });
    } else {
      children.push(child);
      weights.push(weight);
    }
  });
  if (children.length === 1) return children[0] as PaneNode;
  return { kind: "split", axis: node.axis, ratios: toRatios(weights), children };
}

function withRoot(layout: PaneLayout, root: PaneNode): PaneLayout {
  const normalized = normalizeNode(root);
  const ids = new Set(leaves(normalized).map((l) => l.paneId));
  return {
    ...layout,
    root: normalized,
    maximizedPaneId: layout.maximizedPaneId && ids.has(layout.maximizedPaneId) ? layout.maximizedPaneId : null,
  };
}

/** Replaces the node at `path` (the root when empty) with `replacement` (null removes it). */
function replaceAt(node: PaneNode, path: readonly number[], replacement: PaneNode | null): PaneNode | null {
  if (path.length === 0) return replacement;
  if (node.kind !== "split") return node;
  const [head, ...rest] = path as [number, ...number[]];
  const child = node.children[head];
  if (!child) return node;
  const next = replaceAt(child, rest, replacement);
  if (next === null) {
    const children = node.children.filter((_, i) => i !== head);
    const ratios = node.ratios.filter((_, i) => i !== head);
    if (children.length === 0) return null;
    return { ...node, children, ratios: toRatios(ratios) };
  }
  const children = node.children.map((c, i) => (i === head ? next : c));
  return { ...node, children };
}

function mapLeaf(layout: PaneLayout, paneId: string, update: (leaf: LeafNode) => LeafNode): PaneLayout {
  const visit = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") return node.paneId === paneId ? update(node) : node;
    return { ...node, children: node.children.map(visit) };
  };
  return { ...layout, root: visit(layout.root) };
}

// ---------------------------------------------------------------------------------------------
// Capacity

export function paneCount(layout: PaneLayout): number {
  return leaves(layout.root).length;
}

/** Whether `paneId` can be split without breaking the depth or pane limits. */
export function canSplit(layout: PaneLayout, paneId: string, axis: SplitAxis): boolean {
  if (paneCount(layout) >= MAX_PANES) return false;
  const path = pathOf(layout.root, paneId);
  if (!path) return false;
  const parent = path.length > 0 ? nodeAt(layout.root, path.slice(0, -1)) : null;
  // Splitting along the parent's axis adds a sibling (no new depth).
  if (parent?.kind === "split" && parent.axis === axis) return true;
  return path.length + 2 <= MAX_PANE_DEPTH;
}

// ---------------------------------------------------------------------------------------------
// Operations

/**
 * Splits `paneId` along `axis`, putting `newPane` after it (right / below) or before it.
 * Returns the layout unchanged when the limits don't allow another pane.
 */
export function splitPane(
  layout: PaneLayout,
  paneId: string,
  axis: SplitAxis,
  newPane: LeafNode = makeLeaf(),
  where: "before" | "after" = "after",
): PaneLayout {
  if (!canSplit(layout, paneId, axis)) return layout;
  const path = pathOf(layout.root, paneId);
  const target = path ? nodeAt(layout.root, path) : null;
  if (!path || !target) return layout;
  const children = where === "after" ? [target, newPane] : [newPane, target];
  const replacement: SplitNode = { kind: "split", axis, ratios: equalRatios(2), children };
  const root = replaceAt(layout.root, path, replacement) ?? layout.root;
  return withRoot({ ...layout, maximizedPaneId: null }, root);
}

/** The side of its neighbour a pane sits on, for reopening it in place. */
function anchorFor(
  layout: PaneLayout,
  paneId: string,
): Pick<ClosedPane, "anchorPaneId" | "zone" | "siblingPaneIds" | "share"> {
  const path = pathOf(layout.root, paneId);
  if (!path || path.length === 0) return { anchorPaneId: null, zone: "right" };
  const parent = nodeAt(layout.root, path.slice(0, -1));
  const index = path[path.length - 1] as number;
  if (parent?.kind !== "split") return { anchorPaneId: null, zone: "right" };
  const before = index > 0;
  const sibling = parent.children[before ? index - 1 : index + 1];
  const anchor = sibling ? (before ? leaves(sibling).at(-1) : leaves(sibling)[0]) : undefined;
  const zone: ClosedPane["zone"] =
    parent.axis === "horizontal" ? (before ? "right" : "left") : before ? "bottom" : "top";
  const own = parent.ratios[index] ?? 1;
  const theirs = parent.ratios[before ? index - 1 : index + 1] ?? 1;
  return {
    anchorPaneId: anchor?.paneId ?? null,
    zone,
    siblingPaneIds: sibling ? leaves(sibling).map((l) => l.paneId) : undefined,
    share: own / (own + theirs),
  };
}

/** Path of the node whose panes are exactly `ids` (the subtree a closed pane sat beside). */
function pathOfSubtree(node: PaneNode, ids: ReadonlySet<string>, path: number[] = []): number[] | null {
  const own = leaves(node).map((l) => l.paneId);
  if (own.length === ids.size && own.every((id) => ids.has(id))) return path;
  if (node.kind === "leaf") return null;
  for (let i = 0; i < node.children.length; i++) {
    const found = pathOfSubtree(node.children[i] as PaneNode, ids, [...path, i]);
    if (found) return found;
  }
  return null;
}

/**
 * Takes `paneId` out of the layout (its contents keep running). The last pane is never removed:
 * it is emptied instead, so the canvas always has somewhere to put things.
 */
export function closePane(layout: PaneLayout, paneId: string): { layout: PaneLayout; closed: ClosedPane | null } {
  const leaf = findLeaf(layout, paneId);
  if (!leaf) return { layout, closed: null };
  const closed: ClosedPane = { pane: leaf, ...anchorFor(layout, paneId) };
  if (paneCount(layout) === 1) {
    return { layout: withRoot(layout, makeLeaf([], leaf.paneId)), closed: leaf.tabs.length > 0 ? closed : null };
  }
  const path = pathOf(layout.root, paneId) ?? [];
  const root = replaceAt(layout.root, path, null) ?? makeLeaf();
  return { layout: withRoot(layout, root), closed };
}

/** Puts a closed pane back next to where it was (or beside the first pane). */
export function reopenPane(layout: PaneLayout, closed: ClosedPane): PaneLayout {
  // Contents already shown elsewhere since stay where they are now.
  const shown = new Set(allContents(layout).map(contentKey));
  const tabs = closed.pane.tabs.filter((t) => !shown.has(contentKey(t)));
  const id = findLeaf(layout, closed.pane.paneId) ? newPaneId() : closed.pane.paneId;
  const pane = makeLeaf(tabs, id, closed.pane.activeTab);
  const first = leaves(layout.root)[0];
  // An empty lone pane is simply replaced.
  if (paneCount(layout) === 1 && first && first.tabs.length === 0) {
    return withRoot(layout, pane);
  }
  // Back beside the same neighbouring subtree, with the share of the space it had.
  if (closed.siblingPaneIds && closed.siblingPaneIds.length > 0 && paneCount(layout) < MAX_PANES) {
    const path = pathOfSubtree(layout.root, new Set(closed.siblingPaneIds));
    const node = path ? nodeAt(layout.root, path) : null;
    if (path && node) {
      const axis: SplitAxis = closed.zone === "left" || closed.zone === "right" ? "horizontal" : "vertical";
      const first = closed.zone === "left" || closed.zone === "top";
      const share = Math.min(0.9, Math.max(0.1, closed.share ?? 0.5));
      const ratios = toRatios(first ? [share, 1 - share] : [1 - share, share]);
      const split: SplitNode = { kind: "split", axis, ratios, children: first ? [pane, node] : [node, pane] };
      const root = replaceAt(layout.root, path, split) ?? layout.root;
      const next = withRoot({ ...layout, maximizedPaneId: null }, root);
      if (validateLayout(next) === null) return next;
    }
  }
  const anchor = closed.anchorPaneId && findLeaf(layout, closed.anchorPaneId) ? closed.anchorPaneId : first?.paneId;
  if (!anchor) return layout;
  return insertBeside(layout, anchor, pane, closed.zone);
}

/** Inserts `pane` on the `zone` side of `targetPaneId`. */
export function insertBeside(
  layout: PaneLayout,
  targetPaneId: string,
  pane: LeafNode,
  zone: Exclude<DropZone, "center">,
): PaneLayout {
  const axis: SplitAxis = zone === "left" || zone === "right" ? "horizontal" : "vertical";
  const where = zone === "left" || zone === "top" ? "before" : "after";
  return splitPane(layout, targetPaneId, axis, pane, where);
}

/** Adds (or brings forward) a content item in a pane. */
export function addTab(layout: PaneLayout, paneId: string, content: PaneContent, activate = true): PaneLayout {
  const key = contentKey(content);
  const existing = findContent(layout, key);
  if (existing) {
    return activate ? activateTab(layout, existing.paneId, existing.index) : layout;
  }
  const leaf = findLeaf(layout, paneId);
  if (!leaf || leaf.tabs.length >= MAX_TABS_PER_PANE) return layout;
  const dock = layout.dock.filter((d) => contentKey(d) !== key);
  return mapLeaf({ ...layout, dock }, paneId, (l) => {
    const tabs = [...l.tabs, content];
    return {
      ...l,
      tabs,
      activeTab: activate ? tabs.length - 1 : l.activeTab,
      collapsed: activate ? false : l.collapsed,
    };
  });
}

export function activateTab(layout: PaneLayout, paneId: string, index: number): PaneLayout {
  return mapLeaf(layout, paneId, (l) =>
    index >= 0 && index < l.tabs.length ? { ...l, activeTab: index, collapsed: false } : l,
  );
}

/** Takes one tab out of its pane (its process keeps running). The pane stays, possibly empty. */
export function removeTab(layout: PaneLayout, paneId: string, index: number): PaneLayout {
  return mapLeaf(layout, paneId, (l) => {
    if (index < 0 || index >= l.tabs.length) return l;
    const tabs = l.tabs.filter((_, i) => i !== index);
    let activeTab = l.activeTab;
    if (index < activeTab || activeTab >= tabs.length) activeTab = Math.max(0, activeTab - 1);
    return { ...l, tabs, activeTab: tabs.length === 0 ? 0 : Math.min(activeTab, tabs.length - 1) };
  });
}

/** Removes every occurrence of the given contents (for example, a terminal that was closed). */
export function removeContents(layout: PaneLayout, keys: ReadonlySet<string>): PaneLayout {
  if (keys.size === 0) return layout;
  let next = layout;
  for (const leaf of leaves(layout.root)) {
    for (let i = leaf.tabs.length - 1; i >= 0; i--) {
      const tab = leaf.tabs[i];
      if (tab && keys.has(contentKey(tab))) next = removeTab(next, leaf.paneId, i);
    }
  }
  const dock = next.dock.filter((d) => !keys.has(contentKey(d)));
  return dock.length === next.dock.length ? next : { ...next, dock };
}

/** Reorders a tab within its pane. */
export function reorderTab(layout: PaneLayout, paneId: string, from: number, to: number): PaneLayout {
  return mapLeaf(layout, paneId, (l) => {
    if (from < 0 || from >= l.tabs.length || to < 0 || to >= l.tabs.length || from === to) return l;
    const tabs = [...l.tabs];
    const [moved] = tabs.splice(from, 1);
    if (!moved) return l;
    tabs.splice(to, 0, moved);
    const activeKey = l.tabs[l.activeTab] ? contentKey(l.tabs[l.activeTab] as PaneContent) : null;
    const activeTab = activeKey ? tabs.findIndex((t) => contentKey(t) === activeKey) : 0;
    return { ...l, tabs, activeTab: Math.max(0, activeTab) };
  });
}

/**
 * Moves one tab onto another pane: `center` adds it as a tab there, an edge splits that pane
 * and gives the tab its own pane on that side. A pane left empty by the move is closed.
 */
export function moveTab(
  layout: PaneLayout,
  fromPaneId: string,
  index: number,
  toPaneId: string,
  zone: DropZone,
): PaneLayout {
  const source = findLeaf(layout, fromPaneId);
  const content = source?.tabs[index];
  if (!source || !content) return layout;
  if (fromPaneId === toPaneId && (zone === "center" || source.tabs.length === 1)) return layout;
  const target = findLeaf(layout, toPaneId);
  if (!target) return layout;
  if (zone === "center" && target.tabs.length >= MAX_TABS_PER_PANE) return layout;
  if (zone !== "center" && paneCount(layout) >= MAX_PANES && source.tabs.length > 1) return layout;

  let next = removeTab(layout, fromPaneId, index);
  const emptied = (findLeaf(next, fromPaneId)?.tabs.length ?? 0) === 0;
  if (zone === "center") {
    next = mapLeaf(next, toPaneId, (l) => ({
      ...l,
      tabs: [...l.tabs, content],
      activeTab: l.tabs.length,
      collapsed: false,
    }));
  } else {
    next = insertBeside(next, toPaneId, makeLeaf([content]), zone);
  }
  if (emptied && fromPaneId !== toPaneId) next = closePane(next, fromPaneId).layout;
  return next;
}

/** Moves a whole pane (all its tabs) to the `zone` side of another pane, or into it. */
export function movePane(layout: PaneLayout, paneId: string, toPaneId: string, zone: DropZone): PaneLayout {
  if (paneId === toPaneId) return layout;
  const pane = findLeaf(layout, paneId);
  const target = findLeaf(layout, toPaneId);
  if (!pane || !target) return layout;
  if (zone === "center") {
    const room = MAX_TABS_PER_PANE - target.tabs.length;
    if (pane.tabs.length > room) return layout;
    const removed = closePane(layout, paneId).layout;
    return mapLeaf(removed, toPaneId, (l) => ({
      ...l,
      tabs: [...l.tabs, ...pane.tabs],
      activeTab: pane.tabs.length > 0 ? l.tabs.length + pane.activeTab : l.activeTab,
      collapsed: false,
    }));
  }
  const removed = closePane(layout, paneId).layout;
  if (!findLeaf(removed, toPaneId)) return layout;
  const moved = insertBeside(removed, toPaneId, { ...pane, collapsed: false }, zone);
  return findLeaf(moved, paneId) ? moved : layout;
}

/** Swaps two panes' places (each keeps its id and tabs, so focus follows the moved pane). */
export function swapPanes(layout: PaneLayout, a: string, b: string): PaneLayout {
  const first = findLeaf(layout, a);
  const second = findLeaf(layout, b);
  if (!first || !second || a === b) return layout;
  const visit = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") {
      if (node.paneId === a) return second;
      if (node.paneId === b) return first;
      return node;
    }
    return { ...node, children: node.children.map(visit) };
  };
  return { ...layout, root: visit(layout.root) };
}

export function setMaximized(layout: PaneLayout, paneId: string | null): PaneLayout {
  if (paneId !== null && !findLeaf(layout, paneId)) return layout;
  if (paneId !== null && paneCount(layout) === 1) return { ...layout, maximizedPaneId: null };
  const next = paneId === null ? layout : mapLeaf(layout, paneId, (l) => ({ ...l, collapsed: false }));
  return { ...next, maximizedPaneId: paneId };
}

export function toggleMaximized(layout: PaneLayout, paneId: string): PaneLayout {
  return setMaximized(layout, layout.maximizedPaneId === paneId ? null : paneId);
}

/** Collapses a pane to its header (its content is suspended, never stopped) or expands it. */
export function setCollapsed(layout: PaneLayout, paneId: string, collapsed: boolean): PaneLayout {
  // A lone pane, or the last expanded pane of the canvas, can't collapse: something stays open.
  if (collapsed) {
    const open = leaves(layout.root).filter((l) => !l.collapsed && l.paneId !== paneId);
    if (open.length === 0) return layout;
  }
  const next = mapLeaf(layout, paneId, (l) => ({ ...l, collapsed }));
  return collapsed && next.maximizedPaneId === paneId ? { ...next, maximizedPaneId: null } : next;
}

/** Moves a pane's tabs into the side dock; the pane is closed. */
export function dockPane(layout: PaneLayout, paneId: string): PaneLayout {
  const leaf = findLeaf(layout, paneId);
  if (!leaf || leaf.tabs.length === 0) return layout;
  const room = MAX_TABS_PER_PANE - layout.dock.length;
  if (leaf.tabs.length > room) return layout;
  const closed = closePane(layout, paneId).layout;
  return { ...closed, dock: [...closed.dock, ...leaf.tabs] };
}

/** Takes an item out of the dock into a pane (as a tab). */
export function undock(layout: PaneLayout, dockIndex: number, paneId: string): PaneLayout {
  const content = layout.dock[dockIndex];
  if (!content) return layout;
  const without = { ...layout, dock: layout.dock.filter((_, i) => i !== dockIndex) };
  const next = addTab(without, paneId, content);
  return findContent(next, contentKey(content)) ? next : layout;
}

// ---------------------------------------------------------------------------------------------
// Presets

/** The split tree of a built-in preset, with fresh empty panes. */
export function presetShape(preset: BuiltinPreset): PaneNode {
  const row = (n: number): SplitNode => ({
    kind: "split",
    axis: "horizontal",
    ratios: equalRatios(n),
    children: Array.from({ length: n }, () => makeLeaf()),
  });
  switch (preset) {
    case "two":
      return row(2);
    case "three":
      return row(3);
    // Grids fill row by row (reading order: top-left, top-right, …).
    case "four":
      return { kind: "split", axis: "vertical", ratios: equalRatios(2), children: [row(2), row(2)] };
    case "six":
      return { kind: "split", axis: "vertical", ratios: equalRatios(2), children: [row(3), row(3)] };
  }
}

/** A layout's shape with fresh ids and no contents (for saving as a custom preset). */
export function shapeOf(node: PaneNode): PaneNode {
  if (node.kind === "leaf") return makeLeaf();
  return { ...node, children: node.children.map(shapeOf) };
}

/**
 * Rearranges the current panes into `shape`: each existing pane's tabs move, in reading order,
 * into the shape's panes. When there are more existing panes than slots, the extra tabs join
 * the last pane; empty slots stay empty for new work. Nothing is closed or stopped.
 */
export function applyShape(layout: PaneLayout, shape: PaneNode): PaneLayout {
  const slots = leaves(shapeOf(shape));
  const groups = leaves(layout.root).filter((l) => l.tabs.length > 0);
  const assigned = new Map<string, LeafNode>();
  const dockExtra: PaneContent[] = [];
  slots.forEach((slot, i) => {
    const group = groups[i];
    if (!group) {
      assigned.set(slot.paneId, slot);
      return;
    }
    if (i < slots.length - 1 || groups.length <= slots.length) {
      assigned.set(slot.paneId, makeLeaf(group.tabs, group.paneId, group.activeTab));
      return;
    }
    // The last slot collects every remaining pane's tabs; what doesn't fit goes to the dock.
    const all = groups.slice(i).flatMap((g) => g.tabs);
    assigned.set(slot.paneId, makeLeaf(all.slice(0, MAX_TABS_PER_PANE), group.paneId, group.activeTab));
    dockExtra.push(...all.slice(MAX_TABS_PER_PANE));
  });
  const root = rebuild(
    shape,
    slots.map((slot) => assigned.get(slot.paneId) ?? slot),
  );
  const dock = [...layout.dock, ...dockExtra].slice(0, MAX_TABS_PER_PANE);
  return withRoot({ ...layout, maximizedPaneId: null, dock }, root);
}

/** `shape` with its leaves replaced, in order, by `slots` (same structure). */
function rebuild(shape: PaneNode, slots: LeafNode[]): PaneNode {
  let next = 0;
  const visit = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") return slots[next++] ?? makeLeaf();
    return { ...node, children: node.children.map(visit) };
  };
  return visit(shape);
}

export function applyPreset(layout: PaneLayout, preset: BuiltinPreset): PaneLayout {
  return applyShape(layout, presetShape(preset));
}

/**
 * Adds each requested content exactly once in its own balanced subgroup. Existing tabs, pane
 * geometry and dock items are retained beside it; arranging never stops their processes.
 * Returns `null` when the complete layout would exceed the native pane limit.
 */
export function arrangeContents(layout: PaneLayout, requested: readonly PaneContent[]): PaneLayout | null {
  const unique: PaneContent[] = [];
  const requestedKeys = new Set<string>();
  for (const content of requested) {
    const key = contentKey(content);
    if (requestedKeys.has(key)) continue;
    requestedKeys.add(key);
    unique.push(content);
  }
  if (unique.length === 0) return layout;

  const originalLeaves = leaves(layout.root);
  const reusableIds = originalLeaves
    .filter((leaf) => leaf.tabs.length > 0 && leaf.tabs.every((content) => requestedKeys.has(contentKey(content))))
    .map((leaf) => leaf.paneId);
  let base = removeContents(layout, requestedKeys);
  for (const paneId of reusableIds) {
    if (paneCount(base) > 1 && findLeaf(base, paneId)?.tabs.length === 0) base = closePane(base, paneId).layout;
  }
  const hasExistingWork = leaves(base.root).some((leaf) => leaf.tabs.length > 0);
  if (!hasExistingWork) {
    for (const leaf of leaves(base.root)) {
      if (!reusableIds.includes(leaf.paneId)) reusableIds.push(leaf.paneId);
    }
  }

  const usedIds = new Set(hasExistingWork ? leaves(base.root).map((leaf) => leaf.paneId) : []);
  const targets = unique.map((content) => {
    const reusable = reusableIds.find((id) => !usedIds.has(id));
    const pane = makeLeaf([content], reusable);
    usedIds.add(pane.paneId);
    return pane;
  });
  const existingCount = hasExistingWork ? paneCount(base) : 0;
  if (existingCount + targets.length > MAX_PANES) return null;

  const balanced = (groups: LeafNode[]): PaneNode => {
    const makeRow = (children: LeafNode[]): PaneNode =>
      children.length === 1
        ? (children[0] as LeafNode)
        : { kind: "split", axis: "horizontal", ratios: equalRatios(children.length), children };
    const columns = Math.ceil(Math.sqrt(groups.length));
    const rowCount = Math.ceil(groups.length / columns);
    const shortRow = Math.floor(groups.length / rowCount);
    const longRows = groups.length % rowCount;
    const rows: PaneNode[] = [];
    let start = 0;
    for (let row = 0; row < rowCount; row++) {
      const length = shortRow + (row < longRows ? 1 : 0);
      rows.push(makeRow(groups.slice(start, start + length)));
      start += length;
    }
    return rows.length === 1
      ? (rows[0] as PaneNode)
      : { kind: "split", axis: "vertical", ratios: equalRatios(rows.length), children: rows };
  };
  const targetRoot = balanced(targets);
  if (!hasExistingWork) return { ...base, root: targetRoot, maximizedPaneId: null };

  const combined = withRoot(
    { ...base, maximizedPaneId: null },
    { kind: "split", axis: "horizontal", ratios: equalRatios(2), children: [base.root, targetRoot] },
  );
  if (validateLayout(combined) === null) return combined;
  // A maximum-depth existing tree cannot accept another wrapper; retain every pane in a shallow
  // balanced layout rather than dropping any content.
  return { ...base, root: balanced([...leaves(base.root), ...targets]), maximizedPaneId: null };
}

/** Which built-in preset a layout's shape matches, if any (for showing the current choice). */
export function matchingPreset(layout: PaneLayout): BuiltinPreset | null {
  const signature = (node: PaneNode): string =>
    node.kind === "leaf" ? "L" : `${node.axis[0]}(${node.children.map(signature).join(",")})`;
  const current = signature(layout.root);
  return BUILTIN_PRESETS.find((p) => signature(presetShape(p)) === current) ?? null;
}

/** Equal shares for every split (keeps the structure). */
export function evenOut(layout: PaneLayout): PaneLayout {
  const visit = (node: PaneNode): PaneNode =>
    node.kind === "leaf"
      ? node
      : { ...node, ratios: equalRatios(node.children.length), children: node.children.map(visit) };
  return { ...layout, root: visit(layout.root) };
}

// ---------------------------------------------------------------------------------------------
// Geometry

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GeometryOptions {
  /** Size of the dividers between panes, in pixels. */
  gutter: number;
  /** Smallest pane, in pixels. */
  minWidth: number;
  minHeight: number;
  /** Size of a collapsed pane along its split's axis (its header). */
  collapsedSize: number;
}

export const DEFAULT_GEOMETRY: GeometryOptions = { gutter: 6, minWidth: 140, minHeight: 84, collapsedSize: 34 };

/** A divider between child `index` and `index + 1` of the split at `path`. */
export interface Divider {
  path: number[];
  index: number;
  axis: SplitAxis;
  rect: Rect;
  /** Pixel extent of the split along its axis, and where it starts. */
  span: number;
  origin: number;
  /** Children's pixel sizes along the axis. */
  sizes: number[];
  mins: number[];
  fixed: boolean[];
}

export interface Geometry {
  panes: Map<string, Rect>;
  dividers: Divider[];
}

function isCollapsedLeaf(node: PaneNode): boolean {
  return node.kind === "leaf" && node.collapsed;
}

/** Minimum pixel size of a subtree along `axis` ("horizontal" = width). */
export function minSize(node: PaneNode, axis: SplitAxis, options: GeometryOptions = DEFAULT_GEOMETRY): number {
  if (node.kind === "leaf") {
    if (node.collapsed) return options.collapsedSize;
    return axis === "horizontal" ? options.minWidth : options.minHeight;
  }
  const mins = node.children.map((c) => minSize(c, axis, options));
  if (node.axis === axis) return mins.reduce((a, b) => a + b, 0) + options.gutter * (node.children.length - 1);
  return Math.max(...mins);
}

/**
 * Pixel sizes of a split's children along its axis: collapsed panes take their header size,
 * the rest share what is left by their ratios, and no child goes below its minimum while the
 * space allows.
 */
export function childSizes(split: SplitNode, span: number, options: GeometryOptions = DEFAULT_GEOMETRY): number[] {
  const n = split.children.length;
  const available = Math.max(0, span - options.gutter * (n - 1));
  const fixed = split.children.map(isCollapsedLeaf);
  const mins = split.children.map((c) => minSize(c, split.axis, options));
  const sizes = new Array<number>(n).fill(0);
  let flexible = available;
  fixed.forEach((f, i) => {
    if (f) {
      sizes[i] = options.collapsedSize;
      flexible -= options.collapsedSize;
    }
  });
  const flexIdx = split.children.map((_, i) => i).filter((i) => !fixed[i]);
  if (flexIdx.length === 0) return sizes;
  // Iteratively pin children that would fall below their minimum.
  let pool = [...flexIdx];
  let space = Math.max(0, flexible);
  for (let pass = 0; pass < n; pass++) {
    const weight = pool.reduce((a, i) => a + (split.ratios[i] ?? 1), 0) || 1;
    const under = pool.filter((i) => (space * (split.ratios[i] ?? 1)) / weight < (mins[i] ?? 0));
    if (under.length === 0 || under.length === pool.length) {
      for (const i of pool) sizes[i] = (space * (split.ratios[i] ?? 1)) / weight;
      break;
    }
    for (const i of under) {
      sizes[i] = mins[i] ?? 0;
      space -= mins[i] ?? 0;
    }
    pool = pool.filter((i) => !under.includes(i));
    space = Math.max(0, space);
  }
  return sizes;
}

/** Pixel rectangles of every pane and divider inside a `width` × `height` canvas. */
export function computeGeometry(
  layout: PaneLayout,
  width: number,
  height: number,
  options: GeometryOptions = DEFAULT_GEOMETRY,
): Geometry {
  const panes = new Map<string, Rect>();
  const dividers: Divider[] = [];
  const visit = (node: PaneNode, rect: Rect, path: number[]) => {
    if (node.kind === "leaf") {
      panes.set(node.paneId, rect);
      return;
    }
    const horizontal = node.axis === "horizontal";
    const span = horizontal ? rect.width : rect.height;
    const origin = horizontal ? rect.x : rect.y;
    const sizes = childSizes(node, span, options);
    const mins = node.children.map((c) => minSize(c, node.axis, options));
    const fixed = node.children.map(isCollapsedLeaf);
    let offset = origin;
    node.children.forEach((child, i) => {
      const size = sizes[i] ?? 0;
      const childRect: Rect = horizontal
        ? { x: offset, y: rect.y, width: size, height: rect.height }
        : { x: rect.x, y: offset, width: rect.width, height: size };
      visit(child, childRect, [...path, i]);
      offset += size;
      if (i < node.children.length - 1) {
        dividers.push({
          path,
          index: i,
          axis: node.axis,
          rect: horizontal
            ? { x: offset, y: rect.y, width: options.gutter, height: rect.height }
            : { x: rect.x, y: offset, width: rect.width, height: options.gutter },
          span,
          origin,
          sizes,
          mins,
          fixed,
        });
        offset += options.gutter;
      }
    });
  };
  visit(layout.root, { x: 0, y: 0, width, height }, []);
  return { panes, dividers };
}

/**
 * Moves the divider after child `index` of the split at `path` by `deltaPx`, keeping both
 * neighbours at or above their minimum. Only the two neighbours change size.
 */
export function resizeDivider(
  layout: PaneLayout,
  divider: Pick<Divider, "path" | "index" | "sizes" | "mins" | "fixed">,
  deltaPx: number,
): PaneLayout {
  const split = nodeAt(layout.root, divider.path);
  if (split?.kind !== "split") return layout;
  const a = divider.index;
  const b = a + 1;
  if (divider.fixed[a] || divider.fixed[b]) return layout;
  const sizeA = divider.sizes[a] ?? 0;
  const sizeB = divider.sizes[b] ?? 0;
  const minA = divider.mins[a] ?? 0;
  const minB = divider.mins[b] ?? 0;
  const total = sizeA + sizeB;
  const lower = Math.min(minA, total / 2);
  const upper = Math.max(total - minB, total / 2);
  const nextA = Math.max(lower, Math.min(upper, sizeA + deltaPx));
  if (Math.abs(nextA - sizeA) < 0.5) return layout;
  const shareSum = (split.ratios[a] ?? 1) + (split.ratios[b] ?? 1);
  const weights = split.ratios.map((r) => r);
  weights[a] = total > 0 ? (shareSum * nextA) / total : shareSum / 2;
  weights[b] = shareSum - (weights[a] ?? 0);
  if ((weights[a] ?? 0) < 1 || (weights[b] ?? 0) < 1) return layout;
  const replacement: SplitNode = { ...split, ratios: toRatios(weights) };
  const root = replaceAt(layout.root, divider.path, replacement) ?? layout.root;
  return { ...layout, root };
}

/** Resets the two panes around a divider to equal shares of their space. */
export function evenDivider(layout: PaneLayout, path: number[], index: number): PaneLayout {
  const split = nodeAt(layout.root, path);
  if (split?.kind !== "split") return layout;
  const weights = [...split.ratios];
  const both = (weights[index] ?? 0) + (weights[index + 1] ?? 0);
  weights[index] = both / 2;
  weights[index + 1] = both / 2;
  const root = replaceAt(layout.root, path, { ...split, ratios: toRatios(weights) }) ?? layout.root;
  return { ...layout, root };
}

const DIRECTION_AXIS: Record<PaneDirection, SplitAxis> = {
  left: "horizontal",
  right: "horizontal",
  up: "vertical",
  down: "vertical",
};

/**
 * Grows `paneId` toward `direction` by `stepPx` (shrinking its neighbour on that side), using the
 * nearest enclosing split along that axis that has a neighbour there.
 */
export function resizePane(
  layout: PaneLayout,
  paneId: string,
  direction: PaneDirection,
  stepPx: number,
  width: number,
  height: number,
  options: GeometryOptions = DEFAULT_GEOMETRY,
): PaneLayout {
  const path = pathOf(layout.root, paneId);
  if (!path) return layout;
  const axis = DIRECTION_AXIS[direction];
  const forward = direction === "right" || direction === "down";
  const geometry = computeGeometry(layout, width, height, options);
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const splitPath = path.slice(0, depth);
    const split = nodeAt(layout.root, splitPath);
    const childIndex = path[depth] as number;
    if (split?.kind !== "split" || split.axis !== axis) continue;
    const neighbour = forward ? childIndex + 1 : childIndex - 1;
    if (neighbour < 0 || neighbour >= split.children.length) continue;
    const dividerIndex = forward ? childIndex : childIndex - 1;
    const divider = geometry.dividers.find(
      (d) =>
        d.index === dividerIndex && d.path.length === splitPath.length && d.path.every((v, i) => v === splitPath[i]),
    );
    if (!divider) return layout;
    return resizeDivider(layout, divider, forward ? stepPx : -stepPx);
  }
  return layout;
}

/** Grows or shrinks a pane against its nearest enclosing divider, independent of direction. */
export function resizePaneRelative(
  layout: PaneLayout,
  paneId: string,
  grow: boolean,
  stepPx: number,
  width: number,
  height: number,
  options: GeometryOptions = DEFAULT_GEOMETRY,
): PaneLayout {
  const path = pathOf(layout.root, paneId);
  if (!path) return layout;
  const geometry = computeGeometry(layout, width, height, options);
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const splitPath = path.slice(0, depth);
    const split = nodeAt(layout.root, splitPath);
    const childIndex = path[depth] as number;
    if (split?.kind !== "split") continue;
    const hasForward = childIndex + 1 < split.children.length;
    const dividerIndex = hasForward ? childIndex : childIndex - 1;
    if (dividerIndex < 0) continue;
    const divider = geometry.dividers.find(
      (candidate) =>
        candidate.index === dividerIndex &&
        candidate.path.length === splitPath.length &&
        candidate.path.every((value, index) => value === splitPath[index]),
    );
    if (!divider) return layout;
    const towardPane = hasForward ? 1 : -1;
    return resizeDivider(layout, divider, (grow ? 1 : -1) * towardPane * stepPx);
  }
  return layout;
}

/** The pane next to `paneId` in `direction` (by geometry), for keyboard focus traversal. */
export function neighbourPane(
  layout: PaneLayout,
  paneId: string,
  direction: PaneDirection,
  width = 1600,
  height = 1000,
): string | null {
  const { panes } = computeGeometry(layout, width, height);
  const from = panes.get(paneId);
  if (!from) return null;
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  let best: { id: string; score: number } | null = null;
  for (const [id, rect] of panes) {
    if (id === paneId) continue;
    const overlapY = Math.min(from.y + from.height, rect.y + rect.height) - Math.max(from.y, rect.y);
    const overlapX = Math.min(from.x + from.width, rect.x + rect.width) - Math.max(from.x, rect.x);
    let distance: number;
    if (direction === "left") {
      if (rect.x + rect.width > from.x + 1 || overlapY <= 0) continue;
      distance = from.x - (rect.x + rect.width);
    } else if (direction === "right") {
      if (rect.x < from.x + from.width - 1 || overlapY <= 0) continue;
      distance = rect.x - (from.x + from.width);
    } else if (direction === "up") {
      if (rect.y + rect.height > from.y + 1 || overlapX <= 0) continue;
      distance = from.y - (rect.y + rect.height);
    } else {
      if (rect.y < from.y + from.height - 1 || overlapX <= 0) continue;
      distance = rect.y - (from.y + from.height);
    }
    const along =
      direction === "left" || direction === "right"
        ? Math.abs(rect.y + rect.height / 2 - cy)
        : Math.abs(rect.x + rect.width / 2 - cx);
    const score = distance * 4 + along;
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Parsing stored layouts

function isContent(value: unknown): value is PaneContent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "agent":
      return typeof v.agentId === "string";
    case "thread":
      return typeof v.threadId === "string";
    case "terminal":
      return typeof v.terminalId === "string";
    case "dashboard":
      return true;
    case "widget":
      return typeof v.widgetId === "string";
    case "browser":
      return typeof v.browserId === "string" && (v.url === null || typeof v.url === "string");
    case "git":
      return typeof v.workspaceId === "string";
    default:
      return false;
  }
}

/**
 * Reads a stored layout defensively: unknown content kinds are dropped, and anything
 * structurally wrong yields null (the caller falls back to a default layout).
 */
export function parseLayout(value: unknown): PaneLayout | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PaneLayout>;
  const visit = (node: unknown): PaneNode | null => {
    if (!node || typeof node !== "object") return null;
    const n = node as Record<string, unknown>;
    if (n.kind === "leaf" && typeof n.paneId === "string") {
      const tabs = Array.isArray(n.tabs) ? (n.tabs.filter(isContent) as PaneContent[]) : [];
      const active = typeof n.activeTab === "number" ? n.activeTab : 0;
      return { ...makeLeaf(tabs, n.paneId, active), collapsed: n.collapsed === true };
    }
    if (n.kind === "split" && (n.axis === "horizontal" || n.axis === "vertical") && Array.isArray(n.children)) {
      const children = n.children.map(visit);
      if (children.some((c) => c === null)) return null;
      const ratios = Array.isArray(n.ratios) ? (n.ratios as number[]) : [];
      return {
        kind: "split",
        axis: n.axis,
        ratios: toRatios(children.map((_, i) => ratios[i] ?? 1)),
        children: children as PaneNode[],
      };
    }
    return null;
  };
  const root = visit(raw.root);
  if (!root || raw.schemaVersion !== PANE_LAYOUT_SCHEMA_VERSION) return null;
  const layout: PaneLayout = {
    schemaVersion: PANE_LAYOUT_SCHEMA_VERSION,
    root: normalizeNode(root),
    maximizedPaneId: typeof raw.maximizedPaneId === "string" ? raw.maximizedPaneId : null,
    dock: Array.isArray(raw.dock) ? raw.dock.filter(isContent) : [],
  };
  if (layout.maximizedPaneId && !findLeaf(layout, layout.maximizedPaneId)) layout.maximizedPaneId = null;
  return validateLayout(layout) === null ? layout : null;
}
