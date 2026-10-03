import type { PaneContent, PaneLayout, PaneNode } from "@kalcode/protocol";
import {
  allContents,
  contentKey,
  type LeafNode,
  leaves,
  MAX_PANES,
  makeLeaf,
  toRatios,
  validateLayout,
} from "./model.ts";

export const TASK_LAYOUTS = ["build", "debug", "review", "ship", "focus"] as const;
export type TaskLayout = (typeof TASK_LAYOUTS)[number];
export const TASK_LABELS: Record<TaskLayout, string> = {
  build: "Build",
  debug: "Debug",
  review: "Review",
  ship: "Ship",
  focus: "Focus",
};
export const TASK_DESCRIPTIONS: Record<TaskLayout, string> = {
  build: "Code, Browser and Terminal",
  debug: "Terminal, activity logs and Browser",
  review: "Compare work side by side",
  ship: "Terminal and live activity",
  focus: "Your focused pane, with everything else kept ready",
};

function split(axis: "horizontal" | "vertical", children: PaneNode[], weights = children.map(() => 1)): PaneNode {
  if (children.length === 0) return makeLeaf();
  if (children.length === 1) return children[0] as PaneNode;
  return { kind: "split", axis, children, ratios: toRatios(weights) };
}

function grid(panes: LeafNode[], columns: number): PaneNode {
  const rows: PaneNode[] = [];
  for (let i = 0; i < panes.length; i += columns) rows.push(split("horizontal", panes.slice(i, i + columns)));
  return split("vertical", rows);
}

/** Explicit, lossless layout action. Never runs in response to context or window changes. */
export function tidyLayout(layout: PaneLayout, width: number): PaneLayout {
  const panes = leaves(layout.root);
  const occupied = panes.filter((pane) => pane.tabs.length > 0);
  return {
    ...layout,
    maximizedPaneId: null,
    root: grid(occupied.length ? occupied : panes.slice(0, 1), Math.max(1, Math.min(3, Math.floor(width / 380)))),
  };
}

function role(content: PaneContent | undefined): string {
  if (content?.kind === "widget")
    return content.widgetId === "activity" ? "logs" : content.widgetId === "utility-dock" ? "review" : "widget";
  return content?.kind ?? "empty";
}

/** Keep each session exactly once; split unlike tabs only if the pane budget allows it. */
export function arrangeTask(layout: PaneLayout, task: TaskLayout, focusedPaneId: string | null): PaneLayout {
  if (task === "focus") {
    const focused = leaves(layout.root).find((p) => p.paneId === focusedPaneId) ?? leaves(layout.root)[0];
    if (!focused) return layout;
    return { ...layout, maximizedPaneId: focused.paneId, root: expand(layout.root, focused.paneId) };
  }
  const original = leaves(layout.root);
  let panes = original.flatMap((pane) => {
    if (pane.tabs.length < 2) return [pane];
    const groups = new Map<string, PaneContent[]>();
    for (const tab of pane.tabs) groups.set(role(tab), [...(groups.get(role(tab)) ?? []), tab]);
    const selected = pane.tabs[pane.activeTab];
    return [...groups.values()].map((tabs) => {
      const index = selected ? tabs.indexOf(selected) : -1;
      return makeLeaf(tabs, index >= 0 ? pane.paneId : undefined, Math.max(0, index));
    });
  });
  if (panes.length > MAX_PANES) panes = original;
  const occupied = panes.filter((pane) => pane.tabs.length > 0);
  if (occupied.length) panes = occupied;
  const priorities: Record<Exclude<TaskLayout, "focus">, string[]> = {
    build: ["agent", "browser", "terminal"],
    debug: ["terminal", "logs", "browser", "agent"],
    review: ["git", "review", "agent", "browser", "terminal"],
    ship: ["terminal", "logs", "agent", "browser"],
  };
  const order = priorities[task];
  const rank = (pane: LeafNode) => {
    const index = order.indexOf(role(pane.tabs[pane.activeTab]));
    return index < 0 ? order.length : index;
  };
  panes = [...panes].sort((a, b) => rank(a) - rank(b));
  const primary = panes[0];
  if (!primary) return layout;
  const root =
    task === "review"
      ? grid(panes, 2)
      : split(
          "horizontal",
          [primary, ...(panes.length > 1 ? [grid(panes.slice(1), panes.length > 4 ? 2 : 1)] : [])],
          [3, 2],
        );
  const next = { ...layout, root, maximizedPaneId: null };
  return validateLayout(next) === null ? next : layout;
}

function expand(node: PaneNode, paneId: string): PaneNode {
  if (node.kind === "leaf") return node.paneId === paneId && node.collapsed ? { ...node, collapsed: false } : node;
  const children = node.children.map((child) => expand(child, paneId));
  return children.every((child, i) => child === node.children[i]) ? node : { ...node, children };
}

export function suggestTask(layout: PaneLayout, failed: boolean): { task: TaskLayout; reason: string } | null {
  if (failed) return { task: "debug", reason: "A terminal failed. Bring its output, activity and Browser together." };
  if (allContents(layout).some((content) => content.kind === "browser"))
    return { task: "build", reason: "Browser is open. Keep coding, preview and Terminal together." };
  if (allContents(layout).some((content) => content.kind === "git" || role(content) === "review"))
    return { task: "review", reason: "Changes are open. Give comparison work more room." };
  return null;
}

/** Add requested companions without replacing, truncating or duplicating existing work. */
export function withCompanions(layout: PaneLayout, companions: PaneContent[]): PaneLayout {
  const known = new Set(
    leaves(layout.root)
      .flatMap((pane) => pane.tabs)
      .map(contentKey),
  );
  const extra = companions.filter((content) => {
    const key = contentKey(content);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  if (extra.length === 0) return layout;
  const panes = leaves(layout.root);
  if (panes.length + extra.length > MAX_PANES) return layout;
  const requested = new Set(extra.map(contentKey));
  const next = {
    ...layout,
    dock: layout.dock.filter((content) => !requested.has(contentKey(content))),
    root: grid(
      [
        ...panes,
        ...extra.map((content) =>
          makeLeaf([layout.dock.find((item) => contentKey(item) === contentKey(content)) ?? content]),
        ),
      ],
      3,
    ),
  };
  return validateLayout(next) === null ? next : layout;
}
